import importlib
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from codehead.clinic.files import text_hash, tree_hash
from codehead.clinic.profile import REPOSITORY_ROOT, load_profile


def fixtures_module():
    assert (REPOSITORY_ROOT / "apps/backend/src/codehead/clinic/quality_fixtures.py").is_file(), (
        "Versioned quality fixtures are missing"
    )
    return importlib.import_module("codehead.clinic.quality_fixtures")


def test_defect_is_a_separate_version_and_normal_template_stays_clean():
    module = fixtures_module()
    defect = module.storage_fixture()
    good = module.repair_storage_fixture("repair_success", 1)
    assert defect.relative_path == good.relative_path == "backend/clinic_storage.py"
    assert text_hash(defect.content) == defect.content_hash
    assert "CREATE UNIQUE INDEX" not in defect.content
    assert "CREATE UNIQUE INDEX" in good.content
    assert defect.content_hash != good.content_hash
    assert "clinic_storage.py" not in {
        Path(file.relative_path).name for file in load_profile().template_files
    }


def test_two_insufficient_versions_are_explicit_distinct_and_still_faulty():
    module = fixtures_module()
    first = module.repair_storage_fixture("repair_blocked", 1)
    second = module.repair_storage_fixture("repair_blocked", 2)
    assert first.version != second.version and first.content_hash != second.content_hash
    assert "CREATE UNIQUE INDEX" not in first.content + second.content
    with pytest.raises(ValueError):
        module.repair_storage_fixture("repair_blocked", 3)


def test_oversized_fixture_is_refused_before_unbounded_read(tmp_path, monkeypatch):
    module = fixtures_module()
    target = tmp_path / "fixtures/defects/clinic_storage.py"
    target.parent.mkdir(parents=True)
    target.write_bytes(b"x" * 65537)
    monkeypatch.setattr(module, "load_profile", lambda: SimpleNamespace(root=tmp_path))
    with pytest.raises(ValueError, match="size"):
        module.storage_fixture()


def test_unchanged_external_suite_has_real_red_for_the_defect():
    module = fixtures_module()
    from test_runner import request

    from codehead.clinic.workspace import _manifest_document
    from codehead.runner.execution import RestrictedProcessRunner, RunnerRequest

    original = request("test_backend")
    defect = module.storage_fixture()
    contents = {**original.contents, defect.relative_path: defect.content}
    files = [
        file.model_copy(
            update={"content_hash": defect.content_hash, "byte_size": len(defect.content.encode())}
        )
        if file.relative_path == defect.relative_path
        else file
        for file in original.candidate.files
    ]
    candidate = original.candidate.model_copy(
        update={
            "files": files,
            "tree_hash": tree_hash({file.relative_path: file.content_hash for file in files}),
        }
    )
    manifest = json.dumps(_manifest_document(candidate)) + "\n"
    candidate = candidate.model_copy(
        update={"manifest_hash": text_hash(manifest), "manifest_byte_size": len(manifest.encode())}
    )
    before = load_profile().suite_hash
    result = RestrictedProcessRunner().execute(
        RunnerRequest(original.tool_run_id, "test_backend", candidate, contents, manifest)
    )
    assert result.status == "failed", result.stdout + result.stderr
    assert result.error_code == "tool_failed" and result.exit_code == 1
    assert result.report["status"] == "failed"
    assert "[201, 201]" in result.report["output"]
    assert result.report["suite_hash"] == load_profile().suite_hash == before


def test_real_concurrent_http_exposes_defect_and_good_constraint_recovers(tmp_path):
    module = fixtures_module()
    import importlib.util
    import sys
    from concurrent.futures import ThreadPoolExecutor
    from datetime import UTC, datetime

    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    source = load_profile().root / "fixtures/backend"
    sys.path.insert(0, str(source))
    try:
        from clinic_models import AppointmentCreate

        def application(store):
            app = FastAPI()

            @app.post("/api/appointments", status_code=201)
            def book(body: AppointmentCreate):
                from clinic_models import ClinicError
                from fastapi.responses import JSONResponse

                try:
                    return store.create_appointment(body)
                except ClinicError as failure:
                    return JSONResponse({"code": failure.code}, status_code=failure.status)

            return app

        for index, fixture in enumerate(
            (module.storage_fixture(), module.repair_storage_fixture("repair_success", 1))
        ):
            path = tmp_path / f"storage{index}.py"
            path.write_text(fixture.content, encoding="utf-8")
            spec = importlib.util.spec_from_file_location(f"quality_storage_{index}", path)
            loaded = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(loaded)
            storage = loaded.ClinicStorage(
                tmp_path / f"clinic{index}.sqlite", datetime(2030, 1, 1, tzinfo=UTC)
            )
            doctor = storage.create_directory("doctors", {"name": "Synthetic", "specialty": "Test"})
            patients = [
                storage.create_directory("patients", {"full_name": f"Patient {number}"})
                for number in range(2)
            ]
            with TestClient(application(storage)) as client:

                def send(patient, doctor_id=doctor["id"]):
                    return client.post(
                        "/api/appointments",
                        json={
                            "doctor_id": doctor_id,
                            "patient_id": patient["id"],
                            "starts_at": "2030-01-02T10:00:00+05:00",
                        },
                    ).status_code

                with ThreadPoolExecutor(max_workers=2) as pool:
                    statuses = sorted(pool.map(send, patients))
                assert statuses == ([201, 201] if index == 0 else [201, 409])
    finally:
        sys.path.remove(str(source))
