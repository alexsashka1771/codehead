"""Local browser command protection and safe problem responses."""

import hmac
import logging
from uuid import uuid4

from fastapi import FastAPI, Request, WebSocket
from fastapi.exceptions import RequestValidationError, WebSocketRequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy.exc import OperationalError
from starlette.exceptions import HTTPException

from codehead.contracts import ApiProblem
from codehead.errors import DomainError
from codehead.settings import Settings

logger = logging.getLogger(__name__)


def problem(request, code, message, *, status=409, retriable=False):
    correlation_id = getattr(request.state, "correlation_id", str(uuid4()))
    body = ApiProblem(
        code=code, message=message, correlation_id=correlation_id, retriable=retriable
    )
    return JSONResponse(
        body.model_dump(),
        status_code=status,
        headers={"X-Correlation-ID": correlation_id, "Cache-Control": "no-store"},
    )


def install_security(app: FastAPI, settings: Settings):
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(settings.allowed_origins),
        allow_methods=["GET", "POST"],
        allow_headers=["Content-Type", "Idempotency-Key", "X-CodeHead-Client", "X-CodeHead-Token"],
    )

    @app.middleware("http")
    async def local_boundary(request: Request, call_next):
        request.state.correlation_id = str(uuid4())
        host = request.headers.get("host", "").split(":")[0].lower()
        origin = request.headers.get("origin")
        if host not in settings.allowed_hosts:
            return problem(request, "host_forbidden", "Недопустимый адрес сервера.", status=403)
        if origin and origin not in settings.allowed_origins:
            return problem(request, "origin_forbidden", "Источник запроса не разрешён.", status=403)
        if request.method not in {"GET", "HEAD", "OPTIONS"}:
            if request.headers.get("x-codehead-client") != "browser":
                return problem(
                    request,
                    "command_forbidden",
                    "Отсутствует заголовок команды CodeHead.",
                    status=403,
                )
            if request.headers.get("content-type", "").split(";")[0] != "application/json":
                return problem(
                    request, "validation_error", "Команда должна содержать JSON.", status=415
                )
            expected = settings.command_token.get_secret_value()
            if not expected:
                return problem(
                    request, "dependency_unavailable", "Токен команд не настроен.", status=503
                )
            provided = request.headers.get("x-codehead-token", "")
            if not hmac.compare_digest(provided.encode(), expected.encode()):
                return problem(
                    request, "invalid_command_token", "Обновите токен локальной сессии.", status=403
                )
        response = await call_next(request)
        response.headers["X-Correlation-ID"] = request.state.correlation_id
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        return response

    @app.exception_handler(DomainError)
    async def domain_failure(request: Request, exc: DomainError):
        return problem(request, exc.code, exc.message, status=exc.status, retriable=exc.retriable)

    @app.exception_handler(OperationalError)
    async def database_failure(request: Request, exc: OperationalError):
        return problem(
            request,
            "dependency_unavailable",
            "PostgreSQL временно недоступен.",
            status=503,
            retriable=True,
        )

    @app.exception_handler(RequestValidationError)
    async def invalid_request(request: Request, exc: RequestValidationError):
        return problem(
            request, "validation_error", "Проверьте поля запроса и ключ команды.", status=422
        )

    @app.exception_handler(WebSocketRequestValidationError)
    async def invalid_websocket(websocket: WebSocket, exc: WebSocketRequestValidationError):
        await websocket.close(code=1008, reason="validation_error")

    @app.exception_handler(Exception)
    async def unexpected_failure(request: Request, exc: Exception):
        logger.error(
            "Request failed: correlation_id=%s type=%s",
            getattr(request.state, "correlation_id", "unknown"),
            type(exc).__name__,
        )
        return problem(
            request,
            "internal_error",
            "Внутренняя ошибка сервера. Сохраните код запроса.",
            status=500,
        )

    @app.exception_handler(HTTPException)
    async def http_failure(request: Request, exc: HTTPException):
        return problem(
            request,
            "not_found" if exc.status_code == 404 else "http_error",
            "Ресурс не найден." if exc.status_code == 404 else "Запрос не поддерживается.",
            status=exc.status_code,
        )
