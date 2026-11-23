"""Trusted entry point; application behavior belongs to generated clinic modules."""

import os
from datetime import UTC, datetime
from pathlib import Path

import uvicorn
from clinic_api import create_app

CANDIDATE_ROOT = Path(__file__).resolve().parents[1]


def _database_path() -> Path:
    configured = Path(os.environ.get("CLINIC_DATABASE_PATH", ".data/clinic.sqlite3"))
    path = (configured if configured.is_absolute() else CANDIDATE_ROOT / configured).resolve()
    if not path.is_relative_to(CANDIDATE_ROOT):
        raise ValueError("Clinic data must remain inside its candidate workspace.")
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


def _fixed_now() -> datetime | None:
    configured = os.environ.get("CLINIC_TEST_NOW")
    if configured is None:
        return None
    try:
        parsed = datetime.fromisoformat(configured.replace("Z", "+00:00"))
    except ValueError as error:
        raise ValueError("The trusted Clinic test clock must be an offset timestamp.") from error
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ValueError("The trusted Clinic test clock must include its UTC offset.")
    return parsed.astimezone(UTC)


app = create_app(database_path=_database_path(), fixed_now=_fixed_now())

if __name__ == "__main__":
    uvicorn.run(
        app, host="127.0.0.1", port=int(os.environ.get("CLINIC_PORT", "8081")), access_log=False
    )
