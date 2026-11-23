import hashlib
import importlib
from pathlib import Path

import pytest

MODULE_PATH = Path(__file__).resolve().parents[1] / "src/codehead/clinic/files.py"


def files_module():
    assert MODULE_PATH.is_file(), "Candidate file validation is not implemented"
    return importlib.import_module("codehead.clinic.files")


def proposal(path="backend/clinic_api.py", content="print('test')\n", base_hash=None):
    from codehead.contracts import FileProposal

    return FileProposal(relative_path=path, content=content, base_hash=base_hash)


def test_source_content_is_not_trimmed_by_its_public_contract():
    from codehead import contracts

    assert hasattr(contracts, "FileProposal"), "File proposals need a Python-owned contract"
    content = "  print('example')  \n\n"
    draft = contracts.FileProposal(relative_path="backend/clinic_api.py", content=content)
    assert draft.content == content
    with pytest.raises(ValueError):
        contracts.FileProposal(relative_path="x.py", content="x", extra="untrusted")


def test_public_candidate_descriptor_is_a_snapshot_member():
    from codehead import contracts

    assert hasattr(contracts, "CandidateView"), "Candidate metadata has no public descriptor"
    assert "candidate" in contracts.Snapshot.model_fields
    assert "candidate" in contracts.WorkflowUpdatedPayload.model_fields
    assert {"manifest_hash", "manifest_byte_size"} <= contracts.CandidateView.model_fields.keys()


def test_text_hash_normalization_preserves_significant_whitespace():
    module = files_module()
    normalized = module.normalize_text("\ufeff  x\r\ny \r\n\r")
    assert normalized == "  x\ny \n\n"
    assert module.text_hash(normalized) == hashlib.sha256(normalized.encode()).hexdigest()
    assert module.text_hash("x\n") != module.text_hash("x")


def test_bom_is_normalized_once_before_hashing_prepared_content():
    module = files_module()
    prepared = module.validate_batch("backend", [proposal(content="\ufeff\ufeffprint(1)\n")], {})[0]
    assert prepared.content == "\ufeffprint(1)\n"
    assert module.text_hash(prepared.content) == prepared.content_hash


@pytest.mark.parametrize("value", ["\ud800", "x\x00y", b"not text"])
def test_text_rejects_invalid_utf8_and_nul(value):
    module = files_module()
    with pytest.raises(module.InvalidFile):
        module.normalize_text(value)


@pytest.mark.parametrize(
    "path",
    [
        "../outside.py",
        "backend/../outside.py",
        "backend/./clinic_api.py",
        "/absolute.py",
        "C:/outside.py",
        "C:outside.py",
        "\\\\server\\share\\file.py",
        "\\\\?\\C:\\x.py",
        "backend/clinic_api.py:stream",
        "backend/CON.py",
        "backend/PRN",
        "backend/AUX.py",
        "backend/NUL.txt",
        "backend/COM1.py",
        "backend/LPT9.py",
        "backend/CON .py",
        "backend/clinic_api.py.",
        "backend/clinic_api.py ",
        "backend/CLINIC~1.PY",
        "backend//clinic_api.py",
        "backend/clinic\x00_api.py",
        "backend/file?.py",
        "backend/file*.py",
        "backend/clinic_\ud800.py",
        "",
        ".",
    ],
)
def test_windows_path_aliases_and_escapes_are_rejected(path):
    module = files_module()
    with pytest.raises(module.InvalidFile):
        module.normalize_relative_path(path)


def test_windows_separator_is_canonicalized():
    assert (
        files_module().normalize_relative_path("backend\\clinic_api.py") == "backend/clinic_api.py"
    )


def test_batch_preserves_base_hash_and_normalized_bytes():
    module = files_module()
    old_hash = module.text_hash("old\n")
    prepared = module.validate_batch(
        "backend",
        [proposal(content="\ufeffnew\r\n", base_hash=old_hash)],
        {"backend/clinic_api.py": old_hash},
    )
    assert len(prepared) == 1
    assert prepared[0].content == "new\n"
    assert prepared[0].content_hash == module.text_hash("new\n")
    assert prepared[0].base_hash == old_hash


def test_batch_rejects_stale_base_before_returning_any_file():
    module = files_module()
    old_hash = module.text_hash("changed")
    with pytest.raises(module.FileConflict):
        module.validate_batch(
            "backend",
            [proposal("backend/clinic_models.py"), proposal()],
            {"backend/clinic_api.py": old_hash},
        )


def test_another_roles_revision_does_not_invalidate_this_area():
    module = files_module()
    prepared = module.validate_batch(
        "frontend",
        [proposal("frontend/src/App.tsx", "export default () => null;\n")],
        {"backend/clinic_api.py": module.text_hash("independent backend")},
    )
    assert prepared[0].relative_path == "frontend/src/App.tsx"


@pytest.mark.parametrize(
    "path",
    ["frontend/src/App.tsx", "backend/main.py", "requirements.lock", "frontend/package.json"],
)
def test_backend_cannot_write_other_roles_or_trusted_entry_points(path):
    module = files_module()
    with pytest.raises(module.InvalidFile):
        module.validate_batch("backend", [proposal(path)], {})


def test_duplicate_windows_paths_and_unbounded_files_are_rejected():
    module = files_module()
    with pytest.raises(module.InvalidFile):
        module.validate_batch("backend", [proposal(), proposal("backend\\clinic_api.py")], {})
    with pytest.raises(module.InvalidFile):
        module.validate_batch("backend", [proposal(content="я" * 32769)], {})
    with pytest.raises(module.InvalidFile):
        module.validate_batch("backend", [], {})


def test_tree_hash_uses_paths_and_hashes_in_a_stable_order():
    module = files_module()
    first = {
        "backend/clinic_api.py": module.text_hash("one"),
        "frontend/src/App.tsx": module.text_hash("two"),
    }
    assert module.tree_hash(first) == module.tree_hash(dict(reversed(list(first.items()))))
    assert module.tree_hash(first) != module.tree_hash(
        {"backend/other.py": first["backend/clinic_api.py"]}
    )


def test_workspace_path_checks_every_existing_reparse_component(tmp_path, monkeypatch):
    module = files_module()
    root = tmp_path / "candidate"
    root.mkdir()
    parent = root / "backend"
    parent.mkdir()
    original = Path.lstat

    class ReparseStat:
        st_file_attributes = 0x400

    def marked_stat(path, *args, **kwargs):
        return ReparseStat() if path == parent else original(path, *args, **kwargs)

    monkeypatch.setattr(Path, "lstat", marked_stat)
    with pytest.raises(module.InvalidFile):
        module.workspace_path(root, "backend/clinic_api.py")
    assert not (parent / "clinic_api.py").exists()
