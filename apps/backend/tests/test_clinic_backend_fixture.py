"""Development checks for the test fixture; these do not replace the frozen HTTP suite."""

import importlib
import sqlite3
from contextlib import closing
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

FIXTURE_ROOT = Path(__file__).resolve().parents[3] / "profiles/clinic_demo/v1/fixtures/backend"
FIXED_NOW = datetime(2030, 1, 1, tzinfo=UTC)
SLOT = "2030-01-02T05:00:00+00:00"
INVALID_TEXT_BOUNDARIES = [
    pytest.param("\x1c", id="file-separator"),
    pytest.param("\x1d", id="group-separator"),
    pytest.param("\x1e", id="record-separator"),
    pytest.param("\x1f", id="unit-separator"),
    pytest.param(" " + "S" * 120, id="raw-length-121"),
]
HTTP_TEXT_TARGETS = [
    ("/api/doctors", "name", {"name": "Synthetic", "specialty": "Therapy"}),
    ("/api/doctors", "specialty", {"name": "Synthetic", "specialty": "Therapy"}),
    ("/api/patients", "full_name", {"full_name": "Synthetic"}),
]
MODEL_TEXT_TARGETS = [
    ("DoctorCreate", "name", {"name": "Synthetic", "specialty": "Therapy"}),
    ("DoctorCreate", "specialty", {"name": "Synthetic", "specialty": "Therapy"}),
    ("DoctorPatch", "name", {}),
    ("DoctorPatch", "specialty", {}),
    ("PatientCreate", "full_name", {"full_name": "Synthetic"}),
    ("PatientPatch", "full_name", {}),
]


@pytest.fixture
def backend_fixture(monkeypatch):
    monkeypatch.syspath_prepend(str(FIXTURE_ROOT))
    return importlib.import_module("clinic_api")


def _people(client, count=1):
    doctors, patients = [], []
    for index in range(count):
        doctor = client.post(
            "/api/doctors", json={"name": f"Synthetic {index}", "specialty": "Therapy"}
        )
        patient = client.post("/api/patients", json={"full_name": f"Synthetic {index}"})
        assert doctor.status_code == patient.status_code == 201
        doctors.append(doctor.json())
        patients.append(patient.json())
    return doctors, patients


def _book(client, doctor, patient):
    response = client.post(
        "/api/appointments",
        json={"doctor_id": doctor["id"], "patient_id": patient["id"], "starts_at": SLOT},
    )
    assert response.status_code == 201
    return response.json()


def test_text_constraints_use_the_profile_length_and_trim_rules(backend_fixture, tmp_path):
    with TestClient(backend_fixture.create_app(tmp_path / "clinic.sqlite3", FIXED_NOW)) as client:
        doctor = client.post(
            "/api/doctors", json={"name": " \x00Synthetic ", "specialty": " \x00Therapy "}
        )
        assert doctor.status_code == 201, doctor.json()
        assert doctor.json()["name"] == "\x00Synthetic"
        assert doctor.json()["specialty"] == "\x00Therapy"
        patient = client.post("/api/patients", json={"full_name": " \x00Synthetic patient "})
        assert patient.status_code == 201, patient.json()
        assert patient.json()["full_name"] == "\x00Synthetic patient"


@pytest.mark.parametrize("value", INVALID_TEXT_BOUNDARIES)
@pytest.mark.parametrize("method", ["POST", "PATCH"])
@pytest.mark.parametrize("base,field,initial", HTTP_TEXT_TARGETS)
def test_text_boundaries_reject_invalid_http_requests_without_mutation(
    backend_fixture, tmp_path, base, field, initial, method, value
):
    with TestClient(backend_fixture.create_app(tmp_path / "clinic.sqlite3", FIXED_NOW)) as client:
        created = client.post(base, json=initial)
        assert created.status_code == 201
        original = created.json()
        resource_path = f"{base}/{original['id']}"
        path = base if method == "POST" else resource_path
        payload = initial | {field: value} if method == "POST" else {field: value}
        failure = client.request(method, path, json=payload)
        assert failure.status_code == 422, failure.json()
        assert failure.json() == {
            "code": "validation_error",
            "message": "Check the request fields and formats.",
        }
        assert client.get(resource_path).json() == original
        assert client.get(base).json() == [original]


@pytest.mark.parametrize("value", INVALID_TEXT_BOUNDARIES)
@pytest.mark.parametrize("model_name,field,initial", MODEL_TEXT_TARGETS)
def test_text_boundaries_reject_invalid_request_model_fields(
    backend_fixture, model_name, field, initial, value
):
    models = importlib.import_module("clinic_models")
    model = getattr(models, model_name)
    with pytest.raises(ValidationError):
        model.model_validate(initial | {field: value})


@pytest.mark.parametrize(
    "raw,expected",
    [("\x1cSynthetic\x1f", "Synthetic"), (" \x00Synthetic ", "\x00Synthetic")],
)
@pytest.mark.parametrize("model_name,field,initial", MODEL_TEXT_TARGETS)
def test_text_normalization_uses_python_strip_and_keeps_valid_nul_in_request_models(
    backend_fixture, model_name, field, initial, raw, expected
):
    models = importlib.import_module("clinic_models")
    model = getattr(models, model_name).model_validate(initial | {field: raw})
    assert getattr(model, field) == expected


def test_health_checks_the_database_schema_and_returns_a_safe_failure(backend_fixture, tmp_path):
    database = tmp_path / "clinic.sqlite3"
    with TestClient(backend_fixture.create_app(database, FIXED_NOW)) as client:
        assert client.get("/health").json() == {"status": "ok"}
        with closing(sqlite3.connect(database)) as connection, connection:
            connection.execute("ALTER TABLE doctors RENAME TO unavailable_doctors")
        failure = client.get("/health")
        assert failure.status_code == 503
        assert failure.json() == {
            "code": "database_unavailable",
            "message": "Clinic storage is unavailable.",
        }


def test_both_scheduled_slot_constraints_exist_and_reject_direct_sql(backend_fixture, tmp_path):
    database = tmp_path / "clinic.sqlite3"
    with TestClient(backend_fixture.create_app(database, FIXED_NOW)) as client:
        doctors, patients = _people(client, 2)
        _book(client, doctors[0], patients[0])
        with closing(sqlite3.connect(database, isolation_level=None)) as connection:
            connection.execute("PRAGMA foreign_keys = ON")
            partial_unique = [
                row[1]
                for row in connection.execute("PRAGMA index_list(appointments)")
                if row[2] == 1 and row[4] == 1
            ]
            columns = {
                tuple(
                    row[0]
                    for row in connection.execute(
                        "SELECT name FROM pragma_index_info(?) ORDER BY seqno", (index,)
                    )
                )
                for index in partial_unique
            }
            assert {("doctor_id", "starts_at_utc"), ("patient_id", "starts_at_utc")} <= columns
            for doctor, patient in ((doctors[0], patients[1]), (doctors[1], patients[0])):
                with pytest.raises(sqlite3.IntegrityError) as conflict:
                    connection.execute(
                        """INSERT INTO appointments
                            (id, doctor_id, patient_id, starts_at_utc, status)
                            VALUES (?, ?, ?, ?, 'scheduled')""",
                        (str(uuid4()), doctor["id"], patient["id"], SLOT),
                    )
                assert conflict.value.sqlite_errorcode == sqlite3.SQLITE_CONSTRAINT_UNIQUE
            assert connection.execute("SELECT count(*) FROM appointments").fetchone()[0] == 1


def test_cancelled_history_is_idempotent_after_restart_and_clock_advance(backend_fixture, tmp_path):
    database = tmp_path / "clinic.sqlite3"
    with TestClient(backend_fixture.create_app(database, FIXED_NOW)) as client:
        doctors, patients = _people(client)
        original = _book(client, doctors[0], patients[0])
        path = f"/api/appointments/{original['id']}/cancel"
        cancelled = client.post(path, json={})
        assert cancelled.status_code == 200
        expected = original | {"status": "cancelled"}
        assert cancelled.json() == expected
    advanced_now = datetime(2030, 1, 3, tzinfo=UTC)
    with TestClient(backend_fixture.create_app(database, advanced_now)) as client:
        repeated = client.post(path, json={})
        assert repeated.status_code == 200
        assert repeated.json() == expected
        assert client.get("/api/appointments").json() == [expected]
