"""Short HTTP operations. No workflow or LLM calls are executed here."""

from typing import Annotated

from fastapi import APIRouter, Depends, Header, Query, Request
from sqlalchemy.exc import OperationalError

from codehead.api.parameters import ResourceId
from codehead.contracts import (
    AgentRunView,
    ArtifactContent,
    ArtifactView,
    AttemptTrace,
    CapabilitiesResponse,
    Capability,
    CreateProject,
    DecisionResolution,
    DecisionView,
    EventsPage,
    ProjectView,
    RunCommand,
    RunView,
    SessionInfo,
    Snapshot,
    StartRun,
    UsageSummary,
)
from codehead.errors import DomainError
from codehead.persistence.service import ProjectService
from codehead.workflow.definition import ROLE_DEFINITIONS

router = APIRouter()


def get_service(request: Request) -> ProjectService:
    if request.app.state.service is None:
        raise DomainError(
            "dependency_unavailable",
            "PostgreSQL не настроен. Запустите npm run dev.",
            status=503,
            retriable=True,
        )
    return request.app.state.service


Service = Annotated[ProjectService, Depends(get_service)]
CommandKey = Annotated[
    str,
    Header(alias="Idempotency-Key", min_length=8, max_length=128, pattern=r"^[A-Za-z0-9._:-]+$"),
]


def database_status(request: Request) -> str:
    database = request.app.state.database
    if database is None:
        return "unconfigured"
    try:
        database.ping()
    except OperationalError:
        return "unavailable"
    return "ready"


def worker_ready(request: Request) -> bool:
    service = request.app.state.service
    if service is None:
        return False
    try:
        return service.worker_connected()
    except OperationalError:
        return False


@router.get("/health")
def health(request: Request):
    return {
        "status": "ok",
        "service": "codehead",
        "version": "0.1.0",
        "stage": "worker" if worker_ready(request) else "foundation",
        "database": database_status(request),
        "command_security": "ready"
        if request.app.state.settings.command_token.get_secret_value()
        else "unconfigured",
    }


@router.get("/api/capabilities", response_model=CapabilitiesResponse)
def capabilities(request: Request):
    ready = database_status(request) == "ready"
    persistence = "available" if ready else "degraded"
    reason = None if ready else "Нет подключения к PostgreSQL."
    connected = ready and worker_ready(request)
    return CapabilitiesResponse(
        stage="worker" if connected else "foundation",
        roles=list(ROLE_DEFINITIONS),
        capabilities=[
            Capability(id="persistence", status=persistence, reason=reason),
            Capability(id="event_stream", status=persistence, reason=reason),
            Capability(id="durable_queue", status=persistence, reason=reason),
            Capability(
                id="worker",
                status="available" if connected else "disabled",
                reason=None
                if connected
                else "Worker не подключён. Запустите приложение через npm run dev.",
            ),
            Capability(
                id="test_execution",
                status="available" if connected else "disabled",
                reason="Ответы заглушки, без внешних LLM-вызовов."
                if connected
                else "Для тестового процесса нужен worker.",
            ),
            Capability(
                id="first_roles",
                status="available" if connected else "disabled",
                reason="Тестовая цепочка PM → Architect → CTO с решением автора.",
            ),
            Capability(
                id="live_generation",
                status="disabled",
                reason="Live-провайдер не подключён. Заглушка доступна в тестовом режиме.",
            ),
            Capability(
                id="runner", status="planned", reason="Проверки и preview ещё не реализованы."
            ),
            Capability(
                id="replay",
                status="planned",
                reason="Воспроизведение появится после рабочего workflow.",
            ),
            Capability(
                id="security", status="planned", reason="Security Agent относится к диплому."
            ),
            Capability(id="research", status="planned", reason="Исследования относятся к диплому."),
            Capability(
                id="meetings", status="planned", reason="Обсуждения агентов относятся к диплому."
            ),
            Capability(id="git", status="planned", reason="GitGateway ещё не подключён."),
            Capability(
                id="semantic_memory",
                status="planned",
                reason="Семантическая память ещё не подключена.",
            ),
        ],
    )


@router.get("/api/session", response_model=SessionInfo)
def session_info(request: Request):
    if request.headers.get("sec-fetch-site") in {"cross-site", "same-site"}:
        raise DomainError("origin_forbidden", "Контекст страницы не разрешён.", status=403)
    token = request.app.state.settings.command_token.get_secret_value()
    if not token:
        raise DomainError(
            "dependency_unavailable",
            "Токен команд не настроен. Используйте npm run dev.",
            status=503,
        )
    return SessionInfo(command_token=token)


@router.post("/api/projects", response_model=ProjectView, status_code=201)
def create_project(command: CreateProject, service: Service, idempotency_key: CommandKey):
    return service.create_project(command, idempotency_key)


@router.get("/api/projects", response_model=list[ProjectView])
def list_projects(service: Service):
    return service.list_projects()


@router.get("/api/projects/{project_id}/runs", response_model=list[RunView])
def list_runs(project_id: ResourceId, service: Service):
    return service.list_runs(project_id)


@router.post("/api/projects/{project_id}/runs", response_model=RunView, status_code=201)
def start_run(
    project_id: ResourceId,
    command: StartRun,
    request: Request,
    service: Service,
    idempotency_key: CommandKey,
):
    return service.start_run(project_id, command, idempotency_key, request.state.correlation_id)


@router.get("/api/runs/{run_id}/snapshot", response_model=Snapshot)
def snapshot(run_id: ResourceId, service: Service):
    return service.snapshot(run_id)


@router.get("/api/runs/{run_id}/events", response_model=EventsPage)
def events(
    run_id: ResourceId,
    service: Service,
    after_seq: Annotated[int, Query(ge=0)] = 0,
    limit: Annotated[int, Query(ge=1, le=200)] = 100,
):
    return service.events(run_id, after_seq, limit)


@router.post("/api/runs/{run_id}/commands", response_model=RunView)
def run_command(
    run_id: ResourceId,
    command: RunCommand,
    request: Request,
    service: Service,
    idempotency_key: CommandKey,
):
    return service.run_command(run_id, command, idempotency_key, request.state.correlation_id)


@router.get("/api/runs/{run_id}/usage", response_model=UsageSummary)
def usage(run_id: ResourceId, service: Service):
    return service.usage(run_id)


@router.get("/api/runs/{run_id}/agent-runs", response_model=list[AgentRunView])
def agent_runs(run_id: ResourceId, service: Service):
    return service.agent_runs(run_id)


@router.get("/api/agent-runs/{attempt_id}/trace", response_model=AttemptTrace)
def attempt_trace(attempt_id: ResourceId, service: Service):
    return service.attempt_trace(attempt_id)


@router.get("/api/runs/{run_id}/decisions", response_model=list[DecisionView])
def decisions(run_id: ResourceId, service: Service):
    return service.decisions(run_id)


@router.post("/api/decisions/{decision_id}/resolve", response_model=RunView)
def resolve_decision(
    decision_id: ResourceId,
    command: DecisionResolution,
    request: Request,
    service: Service,
    idempotency_key: CommandKey,
):
    return service.resolve_decision(
        decision_id, command, idempotency_key, request.state.correlation_id
    )


@router.get("/api/artifacts/{artifact_id}", response_model=ArtifactView)
def artifact(artifact_id: ResourceId, service: Service):
    return service.artifact(artifact_id)


@router.get("/api/artifacts/{artifact_id}/content", response_model=ArtifactContent)
def artifact_content(artifact_id: ResourceId, service: Service):
    return service.artifact_content(artifact_id)
