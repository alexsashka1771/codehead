import hashlib
import importlib
import io
import json
import shutil
import subprocess
import tempfile
from dataclasses import replace
from pathlib import Path
from uuid import uuid4
from zipfile import ZipFile

import pytest
from test_runner import request as runner_request

from codehead.clinic.files import InvalidFile
from codehead.clinic.profile import REPOSITORY_ROOT
from codehead.runner.execution import RestrictedProcessRunner


def package_module():
    assert (Path(__file__).resolve().parents[1] / "src/codehead/delivery/package.py").is_file()
    return importlib.import_module("codehead.delivery.package")


@pytest.fixture(scope="module")
def real_build():
    request = runner_request("build_frontend")
    with tempfile.TemporaryDirectory(
        prefix="delivery-build-", dir=REPOSITORY_ROOT / ".data"
    ) as root:
        tool_root = Path(root)
        result = RestrictedProcessRunner(workspace_root=tool_root).execute(request)
        assert result.status == "succeeded", result.stdout + result.stderr
        yield request, result.report, tool_root


@pytest.fixture
def retained_build(real_build, tmp_path):
    request, report, root = real_build
    tool_root = tmp_path / "tools"
    shutil.copytree(root, tool_root)
    copy = tool_root / request.tool_run_id / request.candidate.id / f"v{request.candidate.revision}"
    return request, report, tool_root, copy


def publication(retained_build):
    request, report, _, _ = retained_build
    return package_module().PackageRequest(
        str(uuid4()),
        1,
        request.candidate,
        request.contents,
        request.manifest_content,
        request.tool_run_id,
        report,
    )


def test_package_freezes_real_committed_sources_and_build(retained_build, tmp_path):
    module = package_module()
    request, report, tool_root, copy = retained_build
    (copy / "backend" / "__pycache__").mkdir()
    (copy / "backend" / "__pycache__" / "module.pyc").write_bytes(b"cache")
    spec = publication(retained_build)
    compiler = module.PackageCompiler(tool_root, tmp_path / "packages")
    result = compiler.publish(spec)
    second = module.PackageCompiler(tool_root, tmp_path / "copies").publish(spec)
    archive = compiler.read_archive(result)
    assert result.archive_hash == second.archive_hash == hashlib.sha256(archive).hexdigest()
    assert result.archive_byte_size == len(archive)
    assert (
        compiler.load(
            spec.package_id,
            spec.generation,
            manifest_hash=result.manifest_hash,
            archive_hash=result.archive_hash,
            archive_byte_size=result.archive_byte_size,
        )
        == result
    )
    with ZipFile(io.BytesIO(archive)) as zipped:
        names = zipped.namelist()
        assert names == sorted(names)
        expected = {*request.contents, ".codehead/manifest.json", ".codehead/package.json"}
        assert set(names) == expected | {f"frontend/dist/{name}" for name in report["files"]}
        for name, payload in request.contents.items():
            assert zipped.read(name) == payload.encode()
        manifest = json.loads(zipped.read(".codehead/package.json"))
        assert manifest["candidate_tree_hash"] == spec.candidate.tree_hash
        assert manifest["build_tool_id"] == spec.build_tool_id
        assert manifest["build_report_hash"] == module.document_hash(report)
        assert manifest["tree_hash"] == result.tree_hash
        for name, descriptor in report["files"].items():
            data = zipped.read(f"frontend/dist/{name}")
            assert len(data) == descriptor["byte_size"]
            assert hashlib.sha256(data).hexdigest() == descriptor["sha256"]


@pytest.mark.parametrize(
    "violation",
    [
        "changed_build",
        "extra_build",
        "changed_source",
        "traversal",
        "alias",
        "size",
        "count",
        "partial",
        "junction",
    ],
)
def test_package_rejects_unverified_files_and_generations(retained_build, tmp_path, violation):
    module = package_module()
    _, _, tool_root, copy = retained_build
    spec = publication(retained_build)
    compiler = module.PackageCompiler(tool_root, tmp_path / "packages")
    dist = copy / "frontend/dist"
    if violation == "changed_build":
        (dist / "index.html").write_bytes(b"changed")
    elif violation == "extra_build":
        (dist / "extra.js").write_bytes(b"extra")
    elif violation == "changed_source":
        (copy / "backend/main.py").write_bytes(b"changed")
    elif violation in {"traversal", "alias", "count"}:
        report = {**spec.build_report, "files": dict(spec.build_report["files"])}
        if violation == "traversal":
            report["files"]["../index.html"] = report["files"]["index.html"]
        elif violation == "alias":
            report["files"]["INDEX.html"] = report["files"]["index.html"]
        else:
            report["files"].update(
                {f"file-{i}.js": report["files"]["index.html"] for i in range(1025)}
            )
        spec = replace(spec, build_report=report)
    elif violation == "size":
        compiler = module.PackageCompiler(tool_root, tmp_path / "packages", byte_limit=1024)
    elif violation == "partial":
        (tmp_path / "packages" / spec.package_id / "g1").mkdir(parents=True)
    elif violation == "junction":
        outside = tmp_path / "outside"
        outside.mkdir()
        subprocess.run(
            ["cmd.exe", "/c", "mklink", "/J", str(dist / "private"), str(outside)],
            check=True,
            capture_output=True,
        )
    with pytest.raises(InvalidFile):
        compiler.publish(spec)


@pytest.mark.parametrize(
    "name", ["frontend/dist/index.html", ".codehead/package.json", "package.zip", "unexpected.txt"]
)
def test_package_is_verified_again_at_use(retained_build, tmp_path, name):
    module = package_module()
    _, _, tool_root, _ = retained_build
    compiler = module.PackageCompiler(tool_root, tmp_path / "packages")
    result = compiler.publish(publication(retained_build))
    (result.root / name).write_bytes(b"changed")
    with pytest.raises(InvalidFile):
        compiler.read_archive(result)
