"""Frozen Clinic Demo v1 acceptance: real HTTP, fresh storage, no candidate imports."""

import json
import re
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4
from zoneinfo import ZoneInfo

import pytest

NOW = "2030-01-01T00:00:00Z"
SLOT = "2030-01-02T05:00:00Z"
NEXT_SLOT = "2030-01-02T05:30:00Z"
THIRD_SLOT = "2030-01-02T06:00:00Z"
CANARY = "RAW_INPUT_CANARY_7f91bace"
UUID_PATTERN = re.compile(r"^[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$")
UTC_PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|\+00:00)$")


def _uuid(value):
    assert isinstance(value, str) and UUID_PATTERN.fullmatch(value)
    assert str(UUID(value)) == value.lower()


def _name(value):
    assert isinstance(value, str) and value.strip() and len(value) <= 120


def _doctor(value):
    assert isinstance(value, dict) and set(value) == {"id", "name", "specialty"}
    _uuid(value["id"])
    _name(value["name"])
    _name(value["specialty"])
    return value


def _patient(value):
    assert isinstance(value, dict) and set(value) == {"id", "full_name"}
    _uuid(value["id"])
    _name(value["full_name"])
    return value


def _appointment(value):
    assert isinstance(value, dict) and set(value) == {
        "id",
        "doctor_id",
        "patient_id",
        "starts_at",
        "status",
    }
    for name in ("id", "doctor_id", "patient_id"):
        _uuid(value[name])
    assert isinstance(value["starts_at"], str) and UTC_PATTERN.fullmatch(value["starts_at"])
    timestamp = datetime.fromisoformat(value["starts_at"].replace("Z", "+00:00"))
    assert timestamp.utcoffset() == timedelta(0)
    local = timestamp.astimezone(ZoneInfo("Asia/Yekaterinburg"))
    assert local.minute in {0, 30} and local.second == local.microsecond == 0
    assert value["status"] in {"scheduled", "cancelled"}
    return value


def _error(response, status, *raw_markers):
    assert response.status == status, response.body
    assert isinstance(response.body, dict) and set(response.body) == {"code", "message"}
    code, message = response.body["code"], response.body["message"]
    assert isinstance(code, str) and len(code) <= 64 and re.fullmatch(r"[a-z][a-z0-9_]*", code)
    assert isinstance(message, str) and message.strip() and len(message) <= 240
    serialized = json.dumps(response.body, ensure_ascii=False).lower()
    for marker in (CANARY, "traceback", "sqlite3.", "sqlalchemy.", "pydantic.", *raw_markers):
        assert marker.lower() not in serialized


def _people(clinic, count=1):
    doctors = [
        _doctor(
            clinic.expect(
                "POST",
                "/api/doctors",
                {"name": f"Synthetic doctor {index}", "specialty": "Therapy"},
                status=201,
            )
        )
        for index in range(count)
    ]
    patients = [
        _patient(
            clinic.expect(
                "POST", "/api/patients", {"full_name": f"Synthetic patient {index}"}, status=201
            )
        )
        for index in range(count)
    ]
    return doctors, patients


def _book(clinic, doctor, patient, starts_at=SLOT):
    return _appointment(
        clinic.expect(
            "POST",
            "/api/appointments",
            {"doctor_id": doctor["id"], "patient_id": patient["id"], "starts_at": starts_at},
            status=201,
        )
    )


def _parallel(clinic, calls):
    barrier = threading.Barrier(len(calls))

    def send(call):
        barrier.wait(timeout=5)
        method, path, body = call
        return clinic.request(method, path, body)

    with ThreadPoolExecutor(max_workers=len(calls)) as executor:
        return list(executor.map(send, calls))


def test_application_health_and_fresh_empty_lists(clinic):
    assert clinic.expect("GET", "/health") == {"status": "ok"}
    for path in ("/api/doctors", "/api/patients", "/api/appointments"):
        assert clinic.expect("GET", path) == []


def test_doctor_create_read_list_and_partial_patch(clinic):
    doctor = _doctor(
        clinic.expect(
            "POST",
            "/api/doctors",
            {"name": "Synthetic physician", "specialty": "Therapy"},
            status=201,
        )
    )
    path = f"/api/doctors/{doctor['id']}"
    assert clinic.expect("GET", path) == doctor
    assert clinic.expect("GET", "/api/doctors") == [doctor]
    changed = _doctor(clinic.expect("PATCH", path, {"name": "Updated physician"}))
    assert changed == doctor | {"name": "Updated physician"}
    changed = _doctor(clinic.expect("PATCH", path, {"specialty": "Cardiology"}))
    assert changed == doctor | {"name": "Updated physician", "specialty": "Cardiology"}
    assert clinic.expect("GET", path) == changed


def test_patient_create_read_list_and_partial_patch(clinic):
    patient = _patient(
        clinic.expect("POST", "/api/patients", {"full_name": "Synthetic patient"}, status=201)
    )
    path = f"/api/patients/{patient['id']}"
    assert clinic.expect("GET", path) == patient
    assert clinic.expect("GET", "/api/patients") == [patient]
    changed = _patient(clinic.expect("PATCH", path, {"full_name": "Updated synthetic patient"}))
    assert changed == patient | {"full_name": "Updated synthetic patient"}
    assert clinic.expect("GET", path) == changed


@pytest.mark.parametrize("field", ["name", "specialty"])
@pytest.mark.parametrize("value", ["", " \t ", "x" * 121, None, 7])
def test_doctor_text_validation_is_safe_and_atomic(clinic, field, value):
    payload = {"name": "Synthetic physician", "specialty": "Therapy", field: value}
    _error(clinic.request("POST", "/api/doctors", payload), 422)
    doctor = _doctor(
        clinic.expect(
            "POST",
            "/api/doctors",
            {"name": "Synthetic physician", "specialty": "Therapy"},
            status=201,
        )
    )
    path = f"/api/doctors/{doctor['id']}"
    _error(clinic.request("PATCH", path, {field: value}), 422)
    assert clinic.expect("GET", path) == doctor
    assert clinic.expect("GET", "/api/doctors") == [doctor]


@pytest.mark.parametrize("value", ["", " \t ", "x" * 121, None, 7])
def test_patient_text_validation_is_safe_and_atomic(clinic, value):
    _error(clinic.request("POST", "/api/patients", {"full_name": value}), 422)
    patient = _patient(
        clinic.expect("POST", "/api/patients", {"full_name": "Synthetic patient"}, status=201)
    )
    path = f"/api/patients/{patient['id']}"
    _error(clinic.request("PATCH", path, {"full_name": value}), 422)
    assert clinic.expect("GET", path) == patient
    assert clinic.expect("GET", "/api/patients") == [patient]


def test_text_limit_accepts_exactly_120_characters_and_unicode(clinic):
    doctor = _doctor(
        clinic.expect(
            "POST",
            "/api/doctors",
            {"name": "S" * 120, "specialty": "Синтетическая терапия"},
            status=201,
        )
    )
    patient = _patient(clinic.expect("POST", "/api/patients", {"full_name": "P" * 120}, status=201))
    assert doctor["name"] == "S" * 120
    assert doctor["specialty"] == "Синтетическая терапия"
    assert patient["full_name"] == "P" * 120


def test_extra_fields_and_empty_patch_are_rejected_without_mutation(clinic):
    doctors, patients = _people(clinic)
    appointment = _book(clinic, doctors[0], patients[0])
    doctor_path = f"/api/doctors/{doctors[0]['id']}"
    patient_path = f"/api/patients/{patients[0]['id']}"
    appointment_path = f"/api/appointments/{appointment['id']}"
    cases = [
        ("POST", "/api/doctors", {"name": "New", "specialty": "Therapy", "extra": CANARY}),
        ("POST", "/api/patients", {"full_name": "New", "extra": CANARY}),
        (
            "POST",
            "/api/appointments",
            {
                "doctor_id": doctors[0]["id"],
                "patient_id": patients[0]["id"],
                "starts_at": NEXT_SLOT,
                "extra": CANARY,
            },
        ),
        ("PATCH", doctor_path, {}),
        ("PATCH", patient_path, {}),
        ("PATCH", appointment_path, {}),
        ("PATCH", doctor_path, {"name": "New", "extra": CANARY}),
        ("PATCH", patient_path, {"full_name": "New", "extra": CANARY}),
        ("PATCH", appointment_path, {"starts_at": NEXT_SLOT, "extra": CANARY}),
        ("PATCH", appointment_path, {"status": "cancelled"}),
        ("POST", appointment_path + "/cancel", {"extra": CANARY}),
        ("POST", appointment_path + "/cancel", []),
        ("POST", appointment_path + "/cancel", None),
    ]
    for method, path, payload in cases:
        _error(clinic.request(method, path, payload), 422)
    assert clinic.expect("GET", doctor_path) == doctors[0]
    assert clinic.expect("GET", patient_path) == patients[0]
    assert clinic.expect("GET", appointment_path) == appointment
    assert clinic.expect("GET", "/api/appointments") == [appointment]


def test_create_requires_complete_object_payloads(clinic):
    cases = [
        ("/api/doctors", {}),
        ("/api/doctors", {"name": "Synthetic"}),
        ("/api/patients", {}),
        ("/api/appointments", {}),
        ("/api/doctors", []),
        ("/api/patients", []),
        ("/api/appointments", []),
    ]
    for path, payload in cases:
        _error(clinic.request("POST", path, payload), 422)


def test_appointment_creation_uses_utc_and_fixed_thirty_minute_slots(clinic):
    doctors, patients = _people(clinic)
    appointment = _book(clinic, doctors[0], patients[0], "2030-01-02T10:00:00+05:00")
    path = f"/api/appointments/{appointment['id']}"
    assert appointment["status"] == "scheduled"
    assert datetime.fromisoformat(appointment["starts_at"].replace("Z", "+00:00")) == datetime(
        2030, 1, 2, 5, tzinfo=UTC
    )
    assert clinic.expect("GET", path) == appointment
    assert clinic.expect("GET", "/api/appointments") == [appointment]
    _book(clinic, doctors[0], patients[0], "2030-01-02T10:30:00+05:00")
    assert len(clinic.expect("GET", "/api/appointments")) == 2


@pytest.mark.parametrize(
    "starts_at",
    [
        "2030-01-02T10:00:00+05:00",
        "2030-01-02T01:00:00-04:00",
        "2030-01-02T09:45:00+04:45",
        "2030-01-02T05:00:00Z",
        "2030-01-02t05:00:00z",
        "2030-01-02T05:00:00.000000Z",
    ],
)
def test_explicit_offset_inputs_describe_the_same_utc_instant(clinic, starts_at):
    doctors, patients = _people(clinic)
    appointment = _book(clinic, doctors[0], patients[0], starts_at)
    assert datetime.fromisoformat(appointment["starts_at"].replace("Z", "+00:00")) == datetime(
        2030, 1, 2, 5, tzinfo=UTC
    )


@pytest.mark.parametrize(
    "starts_at",
    [
        "2029-12-31T23:30:00Z",
        NOW,
        "2030-01-02T10:00:00",
        "2030-01-02T10:15:00+05:00",
        "2030-01-02T10:00:01+05:00",
        "2030-01-02T10:00:00.000001+05:00",
        "2030-01-02T10:00:00.0000001+05:00",
        "2030-02-30T10:00:00+05:00",
        "2030-01-02 10:00:00+05:00",
        CANARY,
        None,
        7,
    ],
)
def test_bad_times_are_422_for_create_and_patch_and_preserve_history(clinic, starts_at):
    doctors, patients = _people(clinic)
    appointment = _book(clinic, doctors[0], patients[0])
    payload = {
        "doctor_id": doctors[0]["id"],
        "patient_id": patients[0]["id"],
        "starts_at": starts_at,
    }
    _error(clinic.request("POST", "/api/appointments", payload), 422)
    path = f"/api/appointments/{appointment['id']}"
    _error(clinic.request("PATCH", path, {"starts_at": starts_at}), 422)
    assert clinic.expect("GET", path) == appointment
    assert clinic.expect("GET", "/api/appointments") == [appointment]


def test_appointment_patch_changes_only_supplied_fields(clinic):
    doctors, patients = _people(clinic, 2)
    appointment = _book(clinic, doctors[0], patients[0])
    path = f"/api/appointments/{appointment['id']}"
    changed = _appointment(clinic.expect("PATCH", path, {"doctor_id": doctors[1]["id"]}))
    assert changed == appointment | {"doctor_id": doctors[1]["id"]}
    previous = changed
    changed = _appointment(clinic.expect("PATCH", path, {"patient_id": patients[1]["id"]}))
    assert changed == previous | {"patient_id": patients[1]["id"]}
    previous = changed
    changed = _appointment(clinic.expect("PATCH", path, {"starts_at": NEXT_SLOT}))
    assert changed["id"] == previous["id"]
    assert changed["doctor_id"] == previous["doctor_id"]
    assert changed["patient_id"] == previous["patient_id"]
    assert changed["status"] == previous["status"]
    assert datetime.fromisoformat(changed["starts_at"].replace("Z", "+00:00")) == datetime(
        2030, 1, 2, 5, 30, tzinfo=UTC
    )
    assert clinic.expect("GET", path) == changed


@pytest.mark.parametrize("reference", ["doctor_id", "patient_id"])
def test_missing_reference_is_404_and_a_failed_reschedule_is_atomic(clinic, reference):
    doctors, patients = _people(clinic)
    appointment = _book(clinic, doctors[0], patients[0])
    missing = str(uuid4())
    payload = {
        "doctor_id": doctors[0]["id"],
        "patient_id": patients[0]["id"],
        "starts_at": NEXT_SLOT,
    }
    payload[reference] = missing
    _error(clinic.request("POST", "/api/appointments", payload), 404)
    path = f"/api/appointments/{appointment['id']}"
    _error(clinic.request("PATCH", path, {reference: missing, "starts_at": NEXT_SLOT}), 404)
    assert clinic.expect("GET", path) == appointment
    assert clinic.expect("GET", "/api/appointments") == [appointment]


def test_unknown_resource_is_404_and_uuid_format_is_422(clinic):
    missing = str(uuid4())
    operations = [
        ("/api/doctors", {"name": "Changed"}),
        ("/api/patients", {"full_name": "Changed"}),
        ("/api/appointments", {"starts_at": NEXT_SLOT}),
    ]
    for base, payload in operations:
        _error(clinic.request("GET", f"{base}/{missing}"), 404)
        _error(clinic.request("PATCH", f"{base}/{missing}", payload), 404)
        _error(clinic.request("GET", f"{base}/{CANARY}"), 422)
        _error(clinic.request("PATCH", f"{base}/{CANARY}", payload), 422)
    _error(clinic.request("POST", f"/api/appointments/{missing}/cancel", {}), 404)
    _error(clinic.request("POST", f"/api/appointments/{CANARY}/cancel", {}), 422)


@pytest.mark.parametrize("reference", ["doctor_id", "patient_id"])
def test_reference_uuid_format_is_422(clinic, reference):
    doctors, patients = _people(clinic)
    appointment = _book(clinic, doctors[0], patients[0])
    payload = {
        "doctor_id": doctors[0]["id"],
        "patient_id": patients[0]["id"],
        "starts_at": NEXT_SLOT,
    }
    payload[reference] = CANARY
    _error(clinic.request("POST", "/api/appointments", payload), 422)
    path = f"/api/appointments/{appointment['id']}"
    _error(clinic.request("PATCH", path, {reference: CANARY}), 422)
    assert clinic.expect("GET", path) == appointment


def test_distinct_doctors_and_patients_can_share_one_slot(clinic):
    doctors, patients = _people(clinic, 2)
    first = _book(clinic, doctors[0], patients[0])
    second = _book(clinic, doctors[1], patients[1])
    assert first["id"] != second["id"]
    assert len(clinic.expect("GET", "/api/appointments")) == 2


def test_changing_only_a_reference_enforces_its_slot_constraint(clinic):
    doctors, patients = _people(clinic, 2)
    first = _book(clinic, doctors[0], patients[0])
    second = _book(clinic, doctors[1], patients[1])
    path = f"/api/appointments/{second['id']}"
    _error(clinic.request("PATCH", path, {"doctor_id": doctors[0]["id"]}), 409)
    assert clinic.expect("GET", path) == second
    _error(clinic.request("PATCH", path, {"patient_id": patients[0]["id"]}), 409)
    assert clinic.expect("GET", path) == second
    clinic.expect("POST", f"/api/appointments/{first['id']}/cancel", {})
    changed = _appointment(
        clinic.expect(
            "PATCH", path, {"doctor_id": doctors[0]["id"], "patient_id": patients[0]["id"]}
        )
    )
    assert changed == second | {"doctor_id": doctors[0]["id"], "patient_id": patients[0]["id"]}


@pytest.mark.parametrize("dimension", ["doctor", "patient"])
def test_concurrent_creates_have_one_success_and_one_slot_conflict(clinic, dimension):
    doctors, patients = _people(clinic, 2)
    payloads = []
    for index, starts_at in enumerate(("2030-01-02T10:00:00+05:00", SLOT)):
        payloads.append(
            {
                "doctor_id": doctors[0 if dimension == "doctor" else index]["id"],
                "patient_id": patients[0 if dimension == "patient" else index]["id"],
                "starts_at": starts_at,
            }
        )
    results = _parallel(clinic, [("POST", "/api/appointments", payload) for payload in payloads])
    assert sorted(response.status for response in results) == [201, 409]
    for response in results:
        if response.status == 409:
            _error(response, 409)
        else:
            _appointment(response.body)
    appointments = clinic.expect("GET", "/api/appointments")
    assert len(appointments) == 1
    assert appointments[0]["id"] == next(item.body["id"] for item in results if item.status == 201)


@pytest.mark.parametrize("dimension", ["doctor", "patient"])
def test_concurrent_reschedules_have_one_success_and_preserve_the_loser(clinic, dimension):
    doctors, patients = _people(clinic, 2)
    originals = [
        _book(
            clinic,
            doctors[0 if dimension == "doctor" else index],
            patients[0 if dimension == "patient" else index],
            start,
        )
        for index, start in enumerate((SLOT, NEXT_SLOT))
    ]
    results = _parallel(
        clinic,
        [
            ("PATCH", f"/api/appointments/{appointment['id']}", {"starts_at": THIRD_SLOT})
            for appointment in originals
        ],
    )
    assert sorted(response.status for response in results) == [200, 409]
    for original, response in zip(originals, results, strict=True):
        current = _appointment(clinic.expect("GET", f"/api/appointments/{original['id']}"))
        if response.status == 409:
            _error(response, 409)
            assert current == original
        else:
            assert current == _appointment(response.body)
            assert datetime.fromisoformat(current["starts_at"].replace("Z", "+00:00")) == datetime(
                2030, 1, 2, 6, tzinfo=UTC
            )
    assert len(clinic.expect("GET", "/api/appointments")) == 2


def test_cancellation_is_idempotent_keeps_history_and_frees_both_constraints(clinic):
    doctors, patients = _people(clinic, 2)
    original = _book(clinic, doctors[0], patients[0])
    path = f"/api/appointments/{original['id']}"
    cancelled = _appointment(clinic.expect("POST", path + "/cancel", {}))
    assert cancelled == original | {"status": "cancelled"}
    assert clinic.expect("POST", path + "/cancel", {}) == cancelled
    assert clinic.expect("GET", path) == cancelled
    _book(clinic, doctors[0], patients[1])
    _book(clinic, doctors[1], patients[0])
    appointments = clinic.expect("GET", "/api/appointments")
    assert len(appointments) == 3
    assert cancelled in appointments
    assert sum(item["status"] == "scheduled" for item in appointments) == 2
    _error(clinic.request("PATCH", path, {"starts_at": NEXT_SLOT}), 409)
    assert clinic.expect("GET", path) == cancelled


def test_concurrent_repeated_cancel_returns_the_same_cancelled_history(clinic):
    doctors, patients = _people(clinic)
    original = _book(clinic, doctors[0], patients[0])
    path = f"/api/appointments/{original['id']}"
    responses = _parallel(clinic, [("POST", path + "/cancel", {}), ("POST", path + "/cancel", {})])
    assert [item.status for item in responses] == [200, 200]
    assert responses[0].body == responses[1].body == original | {"status": "cancelled"}
    assert clinic.expect("GET", "/api/appointments") == [responses[0].body]
    replacement = _book(clinic, doctors[0], patients[0])
    assert replacement["id"] != original["id"]


def test_past_scheduled_appointment_cannot_be_cancelled_or_rescheduled(clinic):
    doctors, patients = _people(clinic)
    original = _book(clinic, doctors[0], patients[0])
    clinic.restart("2030-01-03T00:00:00Z")
    path = f"/api/appointments/{original['id']}"
    assert clinic.expect("GET", path) == original
    _error(clinic.request("POST", path + "/cancel", {}), 409)
    _error(clinic.request("PATCH", path, {"starts_at": "2030-01-04T05:00:00Z"}), 409)
    assert clinic.expect("GET", path) == original
    assert clinic.expect("GET", "/api/appointments") == [original]
