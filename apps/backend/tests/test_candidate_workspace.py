import hashlib
import importlib
import json
import subprocess
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

import pytest

from codehead.clinic.files import InvalidFile, tree_hash
from codehead.contracts import CandidateFileView, CandidateView

MODULE_PATH = Path(__file__).resolve().parents[1] / "src/codehead/clinic/workspace.py"


def workspace_module():
    assert MODULE_PATH.is_file(), "Immutable candidate materialization is missing"
    return importlib.import_module("codehead.clinic.workspace")


def descriptor(files=None):
    contents = files or {"backend/clinic_api.py": "# fixture\n"}
    stamp = datetime.now(UTC)
    views = [
        CandidateFileView(
            relative_path=path,
            artifact_id=str(uuid4()),
            version=1,
            content_hash=hashlib.sha256(content.encode("utf-8")).hexdigest(),
            byte_size=len(content.encode("utf-8")),
            media_type="text/plain",
            origin="test_injected",
            source="test",
        )
        for path, content in sorted(contents.items())
    ]
    candidate = CandidateView(
        id=str(uuid4()),
        run_id=str(uuid4()),
        revision=3,
        status="materializing",
        profile_version="clinic_demo/v1",
        profile_hash="a" * 64,
        acceptance_suite_hash="b" * 64,
        template_hash="c" * 64,
        tree_hash=tree_hash({view.relative_path: view.content_hash for view in views}),
        manifest_artifact_id=str(uuid4()),
        files=views,
        created_at=stamp,
        updated_at=stamp,
    )
    manifest = (
        json.dumps(
            {
                "candidate_id": candidate.id,
                "run_id": candidate.run_id,
                "revision": candidate.revision,
                "profile_version": candidate.profile_version,
                "profile_hash": candidate.profile_hash,
                "acceptance_suite_hash": candidate.acceptance_suite_hash,
                "template_hash": candidate.template_hash,
                "tree_hash": candidate.tree_hash,
                "normalization_version": "utf8-lf-v1",
                "files": [view.model_dump(mode="json") for view in views],
            }
        )
        + "\n"
    )
    candidate = candidate.model_copy(
        update={
            "manifest_hash": hashlib.sha256(manifest.encode("utf-8")).hexdigest(),
            "manifest_byte_size": len(manifest.encode("utf-8")),
        }
    )
    return candidate, contents, manifest


def test_materialization_writes_verified_files_and_the_immutable_manifest(tmp_path):
    candidate, contents, manifest = descriptor()
    path = workspace_module().materialize(tmp_path, candidate, contents, manifest)
    assert path == tmp_path / candidate.id / "v3"
    assert (path / "backend/clinic_api.py").read_bytes() == b"# fixture\n"
    assert (path / ".codehead/manifest.json").read_text(encoding="utf-8") == manifest


def test_materialization_is_idempotent_without_rewriting_existing_sources(tmp_path):
    candidate, contents, manifest = descriptor()
    module = workspace_module()
    path = module.materialize(tmp_path, candidate, contents, manifest)
    before = (path / "backend/clinic_api.py").stat().st_mtime_ns
    assert module.materialize(tmp_path, candidate, contents, manifest) == path
    assert (path / "backend/clinic_api.py").stat().st_mtime_ns == before


def test_concurrent_replay_waits_for_complete_immutable_file(tmp_path, monkeypatch):
    candidate, contents, manifest = descriptor()
    module = workspace_module()
    opened, release = threading.Event(), threading.Event()
    original = Path.open

    def delayed_open(path, mode="r", *args, **kwargs):
        stream = original(path, mode, *args, **kwargs)
        if path.name == "clinic_api.py" and mode == "xb":
            opened.set()
            assert release.wait(timeout=5)
        return stream

    monkeypatch.setattr(Path, "open", delayed_open)
    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(module.materialize, tmp_path, candidate, contents, manifest)
        assert opened.wait(timeout=5)
        second = pool.submit(module.materialize, tmp_path, candidate, contents, manifest)
        try:
            with pytest.raises(TimeoutError):
                second.result(timeout=0.2)
        finally:
            release.set()
        assert first.result(timeout=5) == second.result(timeout=5)


def test_publication_lock_spans_processes_and_is_released_after_owner_exit(tmp_path):
    candidate, contents, manifest = descriptor()
    command = (
        "import sys; from pathlib import Path; "
        "from codehead.clinic.workspace import _publication_lock; "
        "lock = _publication_lock(Path(sys.argv[1]), sys.argv[2]); "
        "lock.__enter__(); print('locked', flush=True); sys.stdin.readline()"
    )
    owner = subprocess.Popen(
        [sys.executable, "-c", command, str(tmp_path), f"{candidate.id}/v3"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    try:
        with ThreadPoolExecutor(max_workers=2) as pool:
            assert pool.submit(owner.stdout.readline).result(timeout=5) == "locked\n"
            pending = pool.submit(
                workspace_module().materialize, tmp_path, candidate, contents, manifest
            )
            try:
                with pytest.raises(TimeoutError):
                    pending.result(timeout=0.2)
            finally:
                owner.communicate(input="exit\n", timeout=5)
            assert owner.returncode == 0
            assert pending.result(timeout=5) == tmp_path / candidate.id / "v3"
    finally:
        if owner.poll() is None:
            owner.kill()
            owner.communicate(timeout=5)


def test_hash_mismatch_is_detected_before_any_directory_is_created(tmp_path):
    candidate, contents, manifest = descriptor()
    contents["backend/clinic_api.py"] = "changed\n"
    with pytest.raises(InvalidFile):
        workspace_module().materialize(tmp_path, candidate, contents, manifest)
    assert not (tmp_path / candidate.id).exists()


def test_changed_workspace_file_is_preserved_and_refused(tmp_path):
    candidate, contents, manifest = descriptor()
    module = workspace_module()
    path = module.materialize(tmp_path, candidate, contents, manifest)
    file = path / "backend/clinic_api.py"
    file.write_text("human change\n", encoding="utf-8")
    with pytest.raises(InvalidFile):
        module.materialize(tmp_path, candidate, contents, manifest)
    assert file.read_text(encoding="utf-8") == "human change\n"


def test_double_bom_change_to_existing_source_cannot_bypass_hash_verification(tmp_path):
    candidate, contents, manifest = descriptor()
    module = workspace_module()
    path = module.materialize(tmp_path, candidate, contents, manifest)
    file = path / "backend/clinic_api.py"
    changed = b"\xef\xbb\xbf\xef\xbb\xbf# fixture\n"
    file.write_bytes(changed)
    with pytest.raises(InvalidFile):
        module.materialize(tmp_path, candidate, contents, manifest)
    assert file.read_bytes() == changed


def test_normalized_leading_feff_content_survives_materialization(tmp_path):
    candidate, contents, manifest = descriptor({"backend/clinic_api.py": "\ufeffprint(1)\n"})
    module = workspace_module()
    path = module.materialize(tmp_path, candidate, contents, manifest)
    assert (path / "backend/clinic_api.py").read_bytes() == b"\xef\xbb\xbf\xef\xbb\xbfprint(1)\n"
    assert module.materialize(tmp_path, candidate, contents, manifest) == path


def test_changed_serialization_of_committed_manifest_is_refused(tmp_path):
    candidate, contents, manifest = descriptor()
    rewritten = json.dumps(json.loads(manifest), indent=2) + "\n"
    assert rewritten != manifest
    with pytest.raises(InvalidFile):
        workspace_module().materialize(tmp_path, candidate, contents, rewritten)
    assert not (tmp_path / candidate.id).exists()


def test_changed_workspace_reads_are_bounded_by_the_committed_size(tmp_path, monkeypatch):
    candidate, contents, manifest = descriptor()
    module = workspace_module()
    path = module.materialize(tmp_path, candidate, contents, manifest)
    target = path / "backend/clinic_api.py"
    target.write_bytes(b"x" * (8 * 1024 * 1024))
    original_open = Path.open
    received = []

    class Reader:
        def __init__(self, stream):
            self.stream = stream

        def __enter__(self):
            self.stream.__enter__()
            return self

        def __exit__(self, *args):
            return self.stream.__exit__(*args)

        def __getattr__(self, name):
            return getattr(self.stream, name)

        def read(self, size=-1):
            value = self.stream.read(size)
            received.append(len(value))
            return value

    def watched_open(file, *args, **kwargs):
        stream = original_open(file, *args, **kwargs)
        return Reader(stream) if file == target else stream

    monkeypatch.setattr(Path, "open", watched_open)
    with pytest.raises(InvalidFile):
        module.materialize(tmp_path, candidate, contents, manifest)
    assert sum(received) <= candidate.files[0].byte_size * 2 + 4


def test_missing_content_refuses_a_partial_workspace(tmp_path):
    candidate, _, manifest = descriptor()
    with pytest.raises(InvalidFile):
        workspace_module().materialize(tmp_path, candidate, {}, manifest)
    assert not (tmp_path / candidate.id).exists()


def test_untracked_source_does_not_get_overwritten_or_ignored(tmp_path):
    candidate, contents, manifest = descriptor()
    path = tmp_path / candidate.id / "v3/backend"
    path.mkdir(parents=True)
    extra = path / "untracked.py"
    extra.write_text("human code\n", encoding="utf-8")
    with pytest.raises(InvalidFile):
        workspace_module().materialize(tmp_path, candidate, contents, manifest)
    assert extra.read_text(encoding="utf-8") == "human code\n"
    assert not (path / "clinic_api.py").exists()


@pytest.mark.parametrize("identifier", ["../outside", "C:/outside", "not-a-uuid"])
def test_candidate_identifier_cannot_be_used_as_a_path_escape(tmp_path, identifier):
    candidate, contents, manifest = descriptor()
    candidate = candidate.model_copy(update={"id": identifier})
    with pytest.raises(InvalidFile):
        workspace_module().materialize(tmp_path, candidate, contents, manifest)


def test_manifest_content_must_describe_the_committed_candidate(tmp_path):
    candidate, contents, manifest = descriptor()
    value = json.loads(manifest)
    value["revision"] = 99
    with pytest.raises(InvalidFile):
        workspace_module().materialize(tmp_path, candidate, contents, json.dumps(value))
    assert not (tmp_path / candidate.id).exists()
