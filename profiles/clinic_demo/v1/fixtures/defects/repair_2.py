# Insufficient slot repair fixture v2; uniqueness remains absent.
"""Deliberately defective test fixture: check-then-insert without slot uniqueness."""

import sqlite3
import threading
from collections.abc import Iterator
from contextlib import closing, contextmanager
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

from clinic_models import AppointmentCreate, AppointmentPatch, ClinicError

_DIRECTORY_FIELDS = {
    "doctors": ("id", "name", "specialty"),
    "patients": ("id", "full_name"),
}
_APPOINTMENT_FIELDS = "id, doctor_id, patient_id, starts_at_utc AS starts_at, status"
_SCHEMA = (
    """CREATE TABLE IF NOT EXISTS doctors (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        specialty TEXT NOT NULL
    )""",
    """CREATE TABLE IF NOT EXISTS patients (
        id TEXT PRIMARY KEY,
        full_name TEXT NOT NULL
    )""",
    """CREATE TABLE IF NOT EXISTS appointments (
        id TEXT PRIMARY KEY,
        doctor_id TEXT NOT NULL REFERENCES doctors(id),
        patient_id TEXT NOT NULL REFERENCES patients(id),
        starts_at_utc TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('scheduled', 'cancelled'))
    )""",
)


class ClinicStorage:
    def __init__(self, database_path: Path, fixed_now: datetime | None = None):
        self.database_path = database_path.resolve()
        if fixed_now is not None:
            if fixed_now.tzinfo is None or fixed_now.utcoffset() is None:
                raise ValueError("The trusted clock must include its UTC offset.")
            fixed_now = fixed_now.astimezone(UTC)
        self.fixed_now = fixed_now
        self._barrier_lock = threading.Lock()
        self._barriers = {}
        self.database_path.parent.mkdir(parents=True, exist_ok=True)
        with closing(self._connect()) as connection:
            connection.execute("PRAGMA journal_mode = WAL")
        with self._transaction() as connection:
            for statement in _SCHEMA:
                connection.execute(statement)

    def _now(self) -> datetime:
        return self.fixed_now if self.fixed_now is not None else datetime.now(UTC)

    def _connect(self, *, read_only: bool = False) -> sqlite3.Connection:
        target = self.database_path.as_uri() + "?mode=ro" if read_only else self.database_path
        connection = sqlite3.connect(target, timeout=4, isolation_level=None, uri=read_only)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        return connection

    @contextmanager
    def _transaction(self) -> Iterator[sqlite3.Connection]:
        with closing(self._connect()) as connection:
            try:
                with connection:
                    # The lock covers reference/time checks and the subsequent state change.
                    connection.execute("BEGIN IMMEDIATE")
                    yield connection
            except sqlite3.IntegrityError as error:
                if error.sqlite_errorcode == sqlite3.SQLITE_CONSTRAINT_UNIQUE:
                    raise ClinicError(
                        409, "slot_conflict", "The doctor or patient already has this slot."
                    ) from None
                if error.sqlite_errorcode == sqlite3.SQLITE_CONSTRAINT_FOREIGNKEY:
                    raise ClinicError(
                        404, "reference_not_found", "The doctor or patient was not found."
                    ) from None
                raise

    def check_ready(self) -> None:
        # A health response requires accessible storage and the expected application tables.
        with closing(self._connect(read_only=True)) as connection:
            for table, fields in _DIRECTORY_FIELDS.items():
                connection.execute(f"SELECT {', '.join(fields)} FROM {table} LIMIT 1").fetchone()
            connection.execute(f"SELECT {_APPOINTMENT_FIELDS} FROM appointments LIMIT 1").fetchone()

    @staticmethod
    def _directory_row(
        connection: sqlite3.Connection, table: str, identifier: str
    ) -> dict[str, str]:
        fields = _DIRECTORY_FIELDS[table]
        row = connection.execute(
            f"SELECT {', '.join(fields)} FROM {table} WHERE id = ?", (identifier,)
        ).fetchone()
        if row is None:
            raise ClinicError(404, "resource_not_found", "The requested resource was not found.")
        return dict(row)

    def list_directory(self, table: str) -> list[dict[str, str]]:
        fields = _DIRECTORY_FIELDS[table]
        with closing(self._connect(read_only=True)) as connection:
            return [
                dict(row)
                for row in connection.execute(
                    f"SELECT {', '.join(fields)} FROM {table} ORDER BY rowid"
                )
            ]

    def get_directory(self, table: str, identifier: str) -> dict[str, str]:
        with closing(self._connect(read_only=True)) as connection:
            return self._directory_row(connection, table, identifier)

    def create_directory(self, table: str, values: dict[str, str]) -> dict[str, str]:
        fields = _DIRECTORY_FIELDS[table]
        identifier = str(uuid4())
        parameters = [identifier, *(values[field] for field in fields[1:])]
        placeholders = ", ".join("?" for _ in fields)
        with self._transaction() as connection:
            connection.execute(
                f"INSERT INTO {table} ({', '.join(fields)}) VALUES ({placeholders})", parameters
            )
            return self._directory_row(connection, table, identifier)

    def patch_directory(
        self, table: str, identifier: str, changes: dict[str, str]
    ) -> dict[str, str]:
        fields = [field for field in _DIRECTORY_FIELDS[table][1:] if field in changes]
        with self._transaction() as connection:
            self._directory_row(connection, table, identifier)
            assignments = ", ".join(f"{field} = ?" for field in fields)
            connection.execute(
                f"UPDATE {table} SET {assignments} WHERE id = ?",
                [*(changes[field] for field in fields), identifier],
            )
            return self._directory_row(connection, table, identifier)

    @staticmethod
    def _appointment_row(connection: sqlite3.Connection, identifier: str) -> dict[str, str]:
        row = connection.execute(
            f"SELECT {_APPOINTMENT_FIELDS} FROM appointments WHERE id = ?", (identifier,)
        ).fetchone()
        if row is None:
            raise ClinicError(404, "resource_not_found", "The requested resource was not found.")
        return dict(row)

    @staticmethod
    def _references(connection: sqlite3.Connection, doctor_id: str, patient_id: str) -> None:
        doctor = connection.execute("SELECT id FROM doctors WHERE id = ?", (doctor_id,)).fetchone()
        patient = connection.execute(
            "SELECT id FROM patients WHERE id = ?", (patient_id,)
        ).fetchone()
        if doctor is None or patient is None:
            raise ClinicError(404, "reference_not_found", "The doctor or patient was not found.")

    @staticmethod
    def _future(starts_at: datetime, now: datetime) -> None:
        if starts_at <= now:
            raise ClinicError(
                422, "invalid_start", "The start must be later than the server clock."
            )

    @staticmethod
    def _changeable(appointment: dict[str, str], now: datetime) -> None:
        if (
            appointment["status"] != "scheduled"
            or datetime.fromisoformat(appointment["starts_at"]) <= now
        ):
            raise ClinicError(
                409, "appointment_inactive", "Only a scheduled future appointment can be changed."
            )

    def list_appointments(self) -> list[dict[str, str]]:
        with closing(self._connect(read_only=True)) as connection:
            return [
                dict(row)
                for row in connection.execute(
                    f"SELECT {_APPOINTMENT_FIELDS} FROM appointments ORDER BY starts_at_utc, rowid"
                )
            ]

    def get_appointment(self, identifier: str) -> dict[str, str]:
        with closing(self._connect(read_only=True)) as connection:
            return self._appointment_row(connection, identifier)

    def create_appointment(self, body: AppointmentCreate) -> dict[str, str]:
        identifier = str(uuid4())
        # This read intentionally occurs outside the insert transaction in the defect fixture.
        with closing(self._connect(read_only=True)) as checked:
            self._future(body.starts_at, self._now())
            self._references(checked, body.doctor_id, body.patient_id)
            occupied = checked.execute(
                """SELECT id FROM appointments WHERE status = 'scheduled' AND starts_at_utc = ?
                    AND (doctor_id = ? OR patient_id = ?)""",
                (body.starts_at.isoformat(), body.doctor_id, body.patient_id),
            ).fetchone()
            if occupied is not None:
                raise ClinicError(
                    409, "slot_conflict", "The doctor or patient already has this slot."
                )
        if self.fixed_now is not None:
            slot = body.starts_at.isoformat()
            with self._barrier_lock:
                barrier = self._barriers.setdefault(slot, threading.Barrier(2))
            try:
                barrier.wait(timeout=1)
            except threading.BrokenBarrierError:
                # Sequential fixture calls have no peer; only synchronization times out.
                pass
            finally:
                with self._barrier_lock:
                    if self._barriers.get(slot) is barrier:
                        self._barriers.pop(slot)
        with self._transaction() as connection:
            self._future(body.starts_at, self._now())
            self._references(connection, body.doctor_id, body.patient_id)
            connection.execute(
                """INSERT INTO appointments (id, doctor_id, patient_id, starts_at_utc, status)
                    VALUES (?, ?, ?, ?, 'scheduled')""",
                (identifier, body.doctor_id, body.patient_id, body.starts_at.isoformat()),
            )
            return self._appointment_row(connection, identifier)

    def patch_appointment(self, identifier: str, body: AppointmentPatch) -> dict[str, str]:
        changes = body.model_dump(exclude_unset=True)
        with self._transaction() as connection:
            current = self._appointment_row(connection, identifier)
            now = self._now()
            self._changeable(current, now)
            doctor_id = changes.get("doctor_id", current["doctor_id"])
            patient_id = changes.get("patient_id", current["patient_id"])
            starts_at = changes.get("starts_at", datetime.fromisoformat(current["starts_at"]))
            self._future(starts_at, now)
            self._references(connection, doctor_id, patient_id)
            connection.execute(
                """UPDATE appointments SET doctor_id = ?, patient_id = ?, starts_at_utc = ?
                    WHERE id = ?""",
                (doctor_id, patient_id, starts_at.isoformat(), identifier),
            )
            return self._appointment_row(connection, identifier)

    def cancel_appointment(self, identifier: str) -> dict[str, str]:
        with self._transaction() as connection:
            current = self._appointment_row(connection, identifier)
            if current["status"] == "cancelled":
                return current
            self._changeable(current, self._now())
            connection.execute(
                "UPDATE appointments SET status = 'cancelled' "
                "WHERE id = ? AND status = 'scheduled'",
                (identifier,),
            )
            return self._appointment_row(connection, identifier)
