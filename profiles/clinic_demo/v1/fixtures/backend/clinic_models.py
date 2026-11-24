"""Clinic Demo v1 request models and safe domain failures for the test fixture."""

import re
from datetime import UTC, datetime
from typing import Annotated, Self
from uuid import UUID
from zoneinfo import ZoneInfo

from pydantic import BaseModel, BeforeValidator, ConfigDict, StringConstraints, model_validator

CLINIC_TIMEZONE = ZoneInfo("Asia/Yekaterinburg")
_UUID_PATTERN = re.compile(r"[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}")
_TIMESTAMP_PATTERN = re.compile(
    r"[0-9]{4}-[0-9]{2}-[0-9]{2}[Tt][0-9]{2}:[0-9]{2}:[0-9]{2}"
    r"(?:\.(?P<fraction>[0-9]+))?"
    r"(?:[Zz]|[+-](?P<offset_hour>[0-9]{2}):(?P<offset_minute>[0-9]{2}))"
)


class ClinicError(Exception):
    """An application-owned error whose public fields contain no request data."""

    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


def _identifier(value: object) -> str:
    if not isinstance(value, str) or _UUID_PATTERN.fullmatch(value) is None:
        raise ValueError("A canonical UUID is required.")
    return str(UUID(value))


def _text(value: object) -> str:
    if not isinstance(value, str):
        raise ValueError("A string is required.")
    # The profile bounds the raw input; normalization must use Python whitespace rules.
    if len(value) > 120:
        raise ValueError("Text fields cannot exceed 120 characters.")
    normalized = value.strip()
    if not normalized:
        raise ValueError("Text fields cannot be blank.")
    return normalized


def _timestamp(value: object) -> datetime:
    if not isinstance(value, str):
        raise ValueError("An offset timestamp is required.")
    match = _TIMESTAMP_PATTERN.fullmatch(value)
    if match is None:
        raise ValueError("An RFC3339 timestamp with an explicit offset is required.")
    fraction = match.group("fraction")
    # Check the original digits before datetime can truncate sub-microsecond input.
    if fraction is not None and any(digit != "0" for digit in fraction):
        raise ValueError("Fractional seconds must be zero.")
    offset_hour, offset_minute = match.group("offset_hour", "offset_minute")
    if offset_hour is not None and (int(offset_hour) > 23 or int(offset_minute) > 59):
        raise ValueError("The UTC offset is invalid.")
    try:
        instant = datetime.fromisoformat(value.upper().replace("Z", "+00:00")).astimezone(UTC)
        local = instant.astimezone(CLINIC_TIMEZONE)
    except (ValueError, OverflowError) as error:
        raise ValueError("The timestamp is invalid.") from error
    if local.minute not in {0, 30} or local.second != 0 or local.microsecond != 0:
        raise ValueError("The start must align with a thirty-minute clinic slot.")
    return instant


Identifier = Annotated[str, BeforeValidator(_identifier)]
StartsAt = Annotated[datetime, BeforeValidator(_timestamp)]
Text = Annotated[
    str,
    StringConstraints(strict=True, min_length=1, max_length=120),
    BeforeValidator(_text),
]


class RequestBody(BaseModel):
    model_config = ConfigDict(extra="forbid")


class PatchBody(RequestBody):
    @model_validator(mode="after")
    def require_changes(self) -> Self:
        if not self.model_fields_set:
            raise ValueError("At least one field must be supplied.")
        if any(getattr(self, name) is None for name in self.model_fields_set):
            raise ValueError("Supplied fields cannot be null.")
        return self


class DoctorCreate(RequestBody):
    name: Text
    specialty: Text


class DoctorPatch(PatchBody):
    name: Text | None = None
    specialty: Text | None = None


class PatientCreate(RequestBody):
    full_name: Text


class PatientPatch(PatchBody):
    full_name: Text | None = None


class AppointmentCreate(RequestBody):
    doctor_id: Identifier
    patient_id: Identifier
    starts_at: StartsAt


class AppointmentPatch(PatchBody):
    doctor_id: Identifier | None = None
    patient_id: Identifier | None = None
    starts_at: StartsAt | None = None


class CancelBody(RequestBody):
    pass
