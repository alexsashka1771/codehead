"""Fixed Clinic Demo HTTP handlers supplied by the explicit versioned test provider."""

import sqlite3
from datetime import datetime
from pathlib import Path

from clinic_models import (
    AppointmentCreate,
    AppointmentPatch,
    CancelBody,
    ClinicError,
    DoctorCreate,
    DoctorPatch,
    Identifier,
    PatientCreate,
    PatientPatch,
)
from clinic_storage import ClinicStorage
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException


def create_app(database_path: Path, fixed_now: datetime | None = None) -> FastAPI:
    """Build an application using only its candidate-local data and trusted clock."""
    storage = ClinicStorage(database_path, fixed_now)
    app = FastAPI(title="Clinic Demo", version="1", docs_url=None, redoc_url=None, openapi_url=None)

    @app.exception_handler(ClinicError)
    async def domain_failure(request: Request, error: ClinicError) -> JSONResponse:
        return JSONResponse(
            status_code=error.status, content={"code": error.code, "message": error.message}
        )

    @app.exception_handler(RequestValidationError)
    async def invalid_request(request: Request, error: RequestValidationError) -> JSONResponse:
        return JSONResponse(
            status_code=422,
            content={
                "code": "validation_error",
                "message": "Check the request fields and formats.",
            },
        )

    @app.exception_handler(sqlite3.DatabaseError)
    async def database_failure(request: Request, error: sqlite3.DatabaseError) -> JSONResponse:
        return JSONResponse(
            status_code=503,
            content={"code": "database_unavailable", "message": "Clinic storage is unavailable."},
        )

    @app.exception_handler(HTTPException)
    async def http_failure(request: Request, error: HTTPException) -> JSONResponse:
        return JSONResponse(
            status_code=error.status_code,
            content={
                "code": "resource_not_found" if error.status_code == 404 else "http_error",
                "message": "The resource was not found or the request is unsupported.",
            },
        )

    @app.exception_handler(Exception)
    async def unexpected_failure(request: Request, error: Exception) -> JSONResponse:
        return JSONResponse(
            status_code=500,
            content={"code": "internal_error", "message": "The request could not be completed."},
        )

    @app.get("/health")
    def health() -> dict[str, str]:
        storage.check_ready()
        return {"status": "ok"}

    @app.get("/api/doctors")
    def list_doctors() -> list[dict[str, str]]:
        return storage.list_directory("doctors")

    @app.post("/api/doctors", status_code=201)
    def create_doctor(body: DoctorCreate) -> dict[str, str]:
        return storage.create_directory("doctors", body.model_dump())

    @app.get("/api/doctors/{id}")
    def get_doctor(id: Identifier) -> dict[str, str]:
        return storage.get_directory("doctors", id)

    @app.patch("/api/doctors/{id}")
    def patch_doctor(id: Identifier, body: DoctorPatch) -> dict[str, str]:
        return storage.patch_directory("doctors", id, body.model_dump(exclude_unset=True))

    @app.get("/api/patients")
    def list_patients() -> list[dict[str, str]]:
        return storage.list_directory("patients")

    @app.post("/api/patients", status_code=201)
    def create_patient(body: PatientCreate) -> dict[str, str]:
        return storage.create_directory("patients", body.model_dump())

    @app.get("/api/patients/{id}")
    def get_patient(id: Identifier) -> dict[str, str]:
        return storage.get_directory("patients", id)

    @app.patch("/api/patients/{id}")
    def patch_patient(id: Identifier, body: PatientPatch) -> dict[str, str]:
        return storage.patch_directory("patients", id, body.model_dump(exclude_unset=True))

    @app.get("/api/appointments")
    def list_appointments() -> list[dict[str, str]]:
        return storage.list_appointments()

    @app.post("/api/appointments", status_code=201)
    def create_appointment(body: AppointmentCreate) -> dict[str, str]:
        return storage.create_appointment(body)

    @app.get("/api/appointments/{id}")
    def get_appointment(id: Identifier) -> dict[str, str]:
        return storage.get_appointment(id)

    @app.patch("/api/appointments/{id}")
    def patch_appointment(id: Identifier, body: AppointmentPatch) -> dict[str, str]:
        return storage.patch_appointment(id, body)

    @app.post("/api/appointments/{id}/cancel")
    def cancel_appointment(id: Identifier, body: CancelBody) -> dict[str, str]:
        return storage.cancel_appointment(id)

    return app
