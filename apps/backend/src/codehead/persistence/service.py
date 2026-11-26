"""Atomic commands and consistent read models for the persisted foundation."""

import hashlib
import json
from datetime import UTC, datetime
from decimal import Decimal
from uuid import uuid4

from pydantic import TypeAdapter
from sqlalchemy import select, text

from codehead.clinic.profile import load_profile
from codehead.contracts import (
    AgentRunView,
    AgentView,
    ArtifactContent,
    ArtifactView,
    AttemptTrace,
    CommandReceiptView,
    CreateProject,
    DecisionResolution,
    DecisionView,
    DeliveryView,
    DomainEvent,
    EventsPage,
    PreviewSessionView,
    ProjectView,
    QualityCycleView,
    RunCancelledEvent,
    RunCommand,
    RunCreatedEvent,
    RunCreatedPayload,
    RunPausedEvent,
    RunPausingEvent,
    RunResumedEvent,
    RunStatePayload,
    RunView,
    Snapshot,
    StartRun,
    TaskQueuedEvent,
    TaskQueuedPayload,
    TaskView,
    ToolRunView,
    UsageSummary,
    WorkflowUpdatedEvent,
    WorkflowUpdatedPayload,
)
from codehead.errors import DomainError
from codehead.persistence.candidates import candidate_view
from codehead.persistence.database import Database
from codehead.persistence.delivery import DeliveryTransactions
from codehead.persistence.models import (
    Agent,
    AgentRun,
    Artifact,
    Candidate,
    CommandReceipt,
    Decision,
    Delivery,
    Event,
    Project,
    QualityCycle,
    Run,
    Task,
    WorkerHeartbeat,
)
from codehead.persistence.preview import PreviewTransactions
from codehead.persistence.tools import ToolTransactions
from codehead.workflow.definition import (
    CANDIDATE_WORKFLOW_VERSIONS,
    DEPENDENCIES,
    QUALITY_WORKFLOW_VERSIONS,
    ROLE_DEFINITIONS,
    ROLE_ORDER,
    TASK_TYPES,
)
from codehead.workflow.transitions import transition_run

EVENT_ADAPTER = TypeAdapter(DomainEvent)
TERMINAL_RUNS = ("succeeded", "failed", "cancelled")
COMMAND_LOCK = 731204181
COMMAND_PARAMS_CONFLICT = "Этот ключ команды уже использован с другими параметрами."


def now() -> datetime:
    return datetime.now(UTC)


def identifier() -> str:
    return str(uuid4())


def payload_hash(payload) -> str:
    value = payload.model_dump(mode="json")
    if isinstance(payload, StartRun):
        if value.get("workflow_version") in QUALITY_WORKFLOW_VERSIONS:
            value.pop("workflow_version", None)
        if value.get("test_scenario") == "standard":
            value.pop("test_scenario", None)
        file_defaults = {
            "max_file_bytes": 65536,
            "max_files_per_proposal": 4,
            "max_proposal_bytes": 262144,
        }
        if all(value["limits"].get(name) == default for name, default in file_defaults.items()):
            for name in file_defaults:
                value["limits"].pop(name, None)
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode()).hexdigest()


class ProjectService(PreviewTransactions, DeliveryTransactions, ToolTransactions):
    def __init__(self, database: Database, *, package_compiler=None):
        from codehead.delivery.package import PackageCompiler

        self.database = database
        self.clock = now
        self.package_compiler = package_compiler or PackageCompiler()

    @staticmethod
    def _lock_commands(session):
        session.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": COMMAND_LOCK})

    @staticmethod
    def _receipt(session, scope, key, digest):
        receipt = session.get(CommandReceipt, (scope, key))
        if receipt and receipt.params_hash != digest:
            raise DomainError("conflict", COMMAND_PARAMS_CONFLICT)
        return receipt.response if receipt else None

    def _start_receipt(self, session, scope, key, digest, command: StartRun) -> RunView | None:
        receipt = session.get(CommandReceipt, (scope, key))
        if receipt is None:
            return None
        response = RunView.model_validate(receipt.response)
        historical = self._run(session, response.id)
        if (
            "workflow_version" in command.model_fields_set
            and command.workflow_version != historical.workflow_version
        ):
            raise DomainError("conflict", COMMAND_PARAMS_CONFLICT)
        allowed_digests = {digest}
        if historical.workflow_version == "clinic-v2":
            # The same v2 workflow was implicit before v3 and explicit afterward.
            allowed_digests.update(
                payload_hash(command.model_copy(update={"workflow_version": version}))
                for version in ("clinic-v2", "clinic-v3")
            )
        if receipt.params_hash not in allowed_digests:
            raise DomainError("conflict", COMMAND_PARAMS_CONFLICT)
        return response

    @staticmethod
    def _save_receipt(session, scope, key, digest, response):
        receipt = CommandReceiptView(
            scope=scope, key=key, params_hash=digest, response=response, created_at=now()
        )
        session.add(
            CommandReceipt(
                scope=receipt.scope,
                key=receipt.key,
                params_hash=receipt.params_hash,
                response=receipt.response.model_dump(mode="json"),
                created_at=receipt.created_at,
            )
        )

    @staticmethod
    def _project(session, project_id):
        project = session.get(Project, project_id)
        if not project:
            raise DomainError("not_found", "Проект не найден.", status=404)
        return project

    @staticmethod
    def _run(session, run_id, *, for_update=False):
        query = select(Run).where(Run.id == run_id)
        if for_update:
            query = query.with_for_update()
        run = session.scalar(query)
        if not run:
            raise DomainError("not_found", "Запуск не найден.", status=404)
        return run

    @staticmethod
    def _tasks(session, run_id):
        tasks = list(session.scalars(select(Task).where(Task.run_id == run_id)))
        return sorted(
            tasks, key=lambda task: (task.iteration, ROLE_ORDER[task.role], task.created_at)
        )

    @staticmethod
    def _agents(session, run_id):
        agents = list(session.scalars(select(Agent).where(Agent.run_id == run_id)))
        return sorted(agents, key=lambda agent: ROLE_ORDER[agent.role])

    def _record_event(
        self,
        session,
        run,
        event_class,
        payload,
        correlation_id,
        *,
        task_id=None,
        causation_id=None,
        actor_id="local_user",
    ):
        # Callers hold the Run row lock (or have just inserted it) until commit.
        run.last_event_seq += 1
        if isinstance(payload, RunCreatedPayload | RunStatePayload):
            payload = payload.model_copy(update={"run": RunView.model_validate(run)})
        event = event_class(
            event_id=identifier(),
            project_id=run.project_id,
            run_id=run.id,
            seq=run.last_event_seq,
            occurred_at=now(),
            actor_id=actor_id,
            task_id=task_id,
            correlation_id=correlation_id,
            causation_id=causation_id,
            payload=payload,
        )
        values = event.model_dump(mode="json")
        values["occurred_at"] = event.occurred_at
        session.add(Event(**values))
        session.flush()
        return event

    @staticmethod
    def _attempts(session, run_id):
        return list(
            session.scalars(
                select(AgentRun)
                .where(AgentRun.run_id == run_id)
                .order_by(AgentRun.created_at, AgentRun.id)
            )
        )

    @staticmethod
    def _decisions(session, run_id):
        return list(
            session.scalars(
                select(Decision)
                .where(Decision.run_id == run_id)
                .order_by(Decision.created_at, Decision.id)
            )
        )

    def _usage(self, session, run):
        attempts = [
            attempt
            for attempt in self._attempts(session, run.id)
            if attempt.started_at is not None and attempt.parameters.get("dispatched") is not False
        ]
        is_test = run.mode == "test"

        def total(attribute):
            values = [getattr(attempt, attribute) for attempt in attempts]
            if not values:
                return 0 if is_test else None
            if any(value is None for value in values):
                return None
            return (
                sum(Decimal(str(value)) for value in values)
                if attribute == "cost_usd"
                else sum(values)
            )

        return UsageSummary(
            request_count=len(attempts),
            input_tokens=total("input_tokens"),
            output_tokens=total("output_tokens"),
            cost_usd=total("cost_usd"),
            provider=attempts[-1].provider if attempts else "test" if is_test else None,
            model=attempts[-1].model if attempts else "clinic-fixture-v1" if is_test else None,
            latency_ms=total("latency_ms"),
            cached_tokens=0 if is_test else None,
            source="test" if is_test else "live" if attempts else "unconfigured",
        )

    def _workflow_payload(self, session, run, action):
        session.flush()
        return WorkflowUpdatedPayload(
            action=action,
            run=RunView.model_validate(run),
            tasks=[TaskView.model_validate(task) for task in self._tasks(session, run.id)],
            agents=[AgentView.model_validate(agent) for agent in self._agents(session, run.id)],
            artifacts=[
                ArtifactView.model_validate(artifact)
                for artifact in session.scalars(
                    select(Artifact)
                    .where(Artifact.run_id == run.id)
                    .order_by(Artifact.created_at, Artifact.id)
                )
            ],
            agent_runs=[
                AgentRunView.model_validate(attempt) for attempt in self._attempts(session, run.id)
            ],
            decisions=[
                DecisionView.model_validate(decision)
                for decision in self._decisions(session, run.id)
            ],
            usage=self._usage(session, run),
            candidate=candidate_view(session, run.id),
            tool_runs=[ToolRunView.model_validate(tool) for tool in self._tools(session, run.id)],
            quality_cycles=self._quality_views(session, run.id),
            delivery=self._delivery_view(session, run.id),
            preview_sessions=self._preview_views(session, run.id),
        )

    @staticmethod
    def _quality_views(session, run_id):
        return [
            QualityCycleView.model_validate(cycle)
            for cycle in session.scalars(
                select(QualityCycle)
                .where(QualityCycle.run_id == run_id)
                .order_by(QualityCycle.iteration)
            )
        ]

    @staticmethod
    def _delivery_view(session, run_id):
        row = session.scalar(select(Delivery).where(Delivery.run_id == run_id))
        return DeliveryView.model_validate(row) if row is not None else None

    def _preview_views(self, session, run_id):
        return [
            PreviewSessionView.model_validate(preview)
            for preview in self._previews(session, run_id)
        ]

    def _emit_workflow(
        self, session, run, action, *, actor_id="worker", task_id=None, correlation_id=None
    ):
        return self._record_event(
            session,
            run,
            WorkflowUpdatedEvent,
            self._workflow_payload(session, run, action),
            correlation_id or identifier(),
            actor_id=actor_id,
            task_id=task_id,
        )

    def _settle_control(self, session, run):
        attempts = self._attempts(session, run.id)
        tools = self._tools(session, run.id)
        if run.pause_requested or run.cancel_requested:
            for tool in tools:
                if tool.status == "created":
                    if (
                        (tool.qa_cycle_id is not None or tool.operation_id == "smoke_test")
                        and run.pause_requested
                        and not run.cancel_requested
                    ):
                        if tool.lease_owner is not None:
                            tool.lease_owner, tool.lease_expires_at = None, None
                            tool.fencing_token += 1
                        continue
                    tool.status, tool.finished_at = "cancelled", self.clock()
                    tool.lease_owner, tool.lease_expires_at = None, None
                    tool.fencing_token += 1
            candidate = session.scalar(select(Candidate).where(Candidate.run_id == run.id))
            if candidate is not None:
                if candidate.publication_owner is not None:
                    candidate.publication_owner, candidate.publication_expires_at = None, None
                    candidate.publication_fence += 1
                if run.cancel_requested and candidate.status != "ready":
                    candidate.status = "blocked"
                    candidate.blocked_reason = (
                        "Создание кандидата остановлено после запроса отмены."
                    )
                    candidate.updated_at = self.clock()
            for attempt in attempts:
                if attempt.status != "created":
                    continue
                attempt.status, attempt.finished_at = "cancelled", now()
                task = session.get(Task, attempt.task_id)
                if task.active_attempt_id == attempt.id:
                    task.active_attempt_id = None
                    task.lease_owner, task.lease_expires_at = None, None
                    task.fencing_token += 1
                    task.record_version += 1
                    agent = session.get(Agent, attempt.agent_id)
                    agent.lifecycle, agent.activity, agent.current_task_id = "idle", None, None
        running = (
            any(attempt.status == "running" for attempt in attempts)
            or any(tool.status == "running" for tool in tools)
            or self._has_active_delivery_publication(session, run.id)
        )
        uncertain = any(attempt.status == "uncertain" for attempt in attempts) or any(
            tool.status == "uncertain" for tool in tools
        )
        self._settle_delivery_control(session, run, running=running, uncertain=uncertain)
        if run.cancel_requested:
            if uncertain:
                run.status, run.blocked_reason = (
                    "blocked",
                    "Отмена запрошена, но исход операции ещё неизвестен.",
                )
            elif running:
                run.status = "pausing"
            else:
                run.status, run.finished_at = "cancelled", now()
                run.blocked_reason = None
                for cycle in session.scalars(
                    select(QualityCycle).where(QualityCycle.run_id == run.id)
                ):
                    if cycle.status in {"created", "testing", "analyzing", "blocked"}:
                        cycle.status, cycle.finished_at = "cancelled", self.clock()
                for task in self._tasks(session, run.id):
                    if task.status not in TERMINAL_RUNS:
                        task.status = "cancelled"
                        task.record_version += 1
                        task.active_attempt_id = None
                        task.lease_owner, task.lease_expires_at = None, None
                for attempt in attempts:
                    if attempt.status == "created":
                        attempt.status, attempt.finished_at = "cancelled", now()
                for decision in self._decisions(session, run.id):
                    if decision.status == "open":
                        decision.status, decision.resolved_at = "resolved", now()
                        decision.version += 1
                        decision.comment = "Запуск отменён пользователем."
                for agent in self._agents(session, run.id):
                    agent.current_task_id, agent.activity = None, None
                    if agent.lifecycle == "busy":
                        agent.lifecycle = "idle"
        elif run.pause_requested:
            open_decisions = any(
                decision.status == "open" and decision.blocking
                for decision in self._decisions(session, run.id)
            )
            blocked = any(
                task.status in {"blocked", "failed"} for task in self._tasks(session, run.id)
            )
            run.status = (
                "blocked"
                if open_decisions or uncertain or blocked
                else "pausing"
                if running
                else "paused"
            )
            if uncertain:
                run.blocked_reason = "Пауза запрошена, но исход предыдущей операции ещё неизвестен."

    def _candidate_progress(self, session, run):
        candidate = session.scalar(select(Candidate).where(Candidate.run_id == run.id))
        if candidate is None or candidate.status == "ready":
            return
        tasks = [
            task for task in self._tasks(session, run.id) if task.role in {"backend", "frontend"}
        ]
        conflicts = [
            item
            for item in self._decisions(session, run.id)
            if item.kind == "file_conflict" and item.status == "open" and item.blocking
        ]
        blocked = [task for task in tasks if task.status in {"blocked", "failed"}]
        if conflicts:
            candidate.status, candidate.blocked_reason = "conflict", conflicts[0].summary
        elif blocked:
            candidate.status, candidate.blocked_reason = "blocked", blocked[0].blocked_reason
        else:
            candidate.status = (
                "materializing"
                if all(task.status == "succeeded" for task in tasks)
                else "assembling"
            )
            candidate.blocked_reason = None
        candidate.updated_at = self.clock()

    def create_project(self, command: CreateProject, key: str) -> ProjectView:
        digest = payload_hash(command)
        with self.database.sessions.begin() as session:
            self._lock_commands(session)
            existing = self._receipt(session, "create_project", key, digest)
            if existing:
                return ProjectView.model_validate(existing)
            project = Project(
                id=identifier(), **command.model_dump(), requirements_version=1, created_at=now()
            )
            session.add(project)
            session.flush()
            result = ProjectView.model_validate(project)
            self._save_receipt(session, "create_project", key, digest, result)
            return result

    def list_projects(self) -> list[ProjectView]:
        with self.database.read() as session:
            projects = session.scalars(
                select(Project).order_by(Project.created_at.desc()).limit(100)
            )
            return [ProjectView.model_validate(project) for project in projects]

    def list_runs(self, project_id: str) -> list[RunView]:
        with self.database.read() as session:
            self._project(session, project_id)
            runs = session.scalars(
                select(Run)
                .where(Run.project_id == project_id)
                .order_by(Run.created_at.desc())
                .limit(100)
            )
            return [RunView.model_validate(run) for run in runs]

    def start_run(
        self, project_id: str, command: StartRun, key: str, correlation_id: str
    ) -> RunView:
        scope, digest = f"start:{project_id}", payload_hash(command)
        with self.database.sessions.begin() as session:
            self._lock_commands(session)
            project = self._project(session, project_id)
            existing = self._start_receipt(session, scope, key, digest, command)
            if existing is not None:
                return existing
            if session.scalar(select(Run.id).where(Run.status.not_in(TERMINAL_RUNS)).limit(1)):
                raise DomainError(
                    "conflict", "Уже есть незавершённый запуск. Завершите или отмените его."
                )
            profile = load_profile()
            run = Run(
                id=identifier(),
                project_id=project_id,
                mode=command.mode,
                workflow_version=command.workflow_version,
                test_scenario=command.test_scenario,
                injection_done=False,
                requirements_version=project.requirements_version,
                profile_version=profile.id,
                profile_hash=profile.profile_hash,
                acceptance_suite_hash=profile.suite_hash,
                template_hash=profile.template_hash,
                status="created",
                limits=command.limits.model_dump(mode="json"),
                last_event_seq=0,
                created_at=now(),
                started_at=None,
                finished_at=None,
                blocked_reason=None,
            )
            session.add(run)
            session.flush()
            run = self._run(session, run.id, for_update=True)
            task_ids = {definition.role: identifier() for definition in ROLE_DEFINITIONS}
            tasks, agents = [], []
            for definition in ROLE_DEFINITIONS:
                task = Task(
                    id=task_ids[definition.role],
                    run_id=run.id,
                    role=definition.role,
                    task_type=TASK_TYPES[definition.role],
                    status="queued",
                    dependencies=[task_ids[role] for role in DEPENDENCIES[definition.role]],
                    input_versions={"requirements": project.requirements_version},
                    iteration=0,
                    attempt=0,
                    record_version=1,
                    lease_owner=None,
                    lease_expires_at=None,
                    created_at=now(),
                )
                agent = Agent(
                    id=identifier(),
                    run_id=run.id,
                    role=definition.role,
                    instructions_version=definition.instructions_version,
                    appearance_id=definition.appearance_id,
                    lifecycle="offline",
                    activity=None,
                    location=definition.location,
                    current_task_id=None,
                )
                tasks.append(task)
                agents.append(agent)
            session.add_all(tasks)
            session.flush()
            session.add_all(agents)
            session.flush()
            created = self._record_event(
                session,
                run,
                RunCreatedEvent,
                RunCreatedPayload(
                    project=ProjectView.model_validate(project),
                    run=RunView.model_validate(run),
                    agents=[AgentView.model_validate(agent) for agent in agents],
                    usage=self._usage(session, run),
                ),
                correlation_id,
            )
            for task in tasks:
                self._record_event(
                    session,
                    run,
                    TaskQueuedEvent,
                    TaskQueuedPayload(task=TaskView.model_validate(task)),
                    correlation_id,
                    task_id=task.id,
                    causation_id=created.event_id,
                )
            result = RunView.model_validate(run)
            self._save_receipt(session, scope, key, digest, result)
            return result

    def run_command(
        self, run_id: str, command: RunCommand, key: str, correlation_id: str
    ) -> RunView:
        if command.command == "retry_failed":
            raise DomainError(
                "capability_unavailable", "Повтор задач будет доступен после подключения worker."
            )
        scope, digest = f"command:{run_id}", payload_hash(command)
        with self.database.sessions.begin() as session:
            self._lock_commands(session)
            run = self._run(session, run_id, for_update=True)
            existing = self._receipt(session, scope, key, digest)
            if existing:
                return RunView.model_validate(existing)
            tasks, agents = self._tasks(session, run_id), self._agents(session, run_id)
            attempts = self._attempts(session, run_id)
            tools = self._tools(session, run_id)
            tool_resume = (
                command.command == "resume"
                and run.status == "blocked"
                and run.pause_requested
                and bool(tools)
                and not any(tool.status in {"created", "running", "uncertain"} for tool in tools)
            )
            try:
                if (
                    command.command == "pause"
                    and run.status == "blocked"
                    and any(tool.status in {"created", "running"} for tool in tools)
                ):
                    next_status = "pausing"
                elif tool_resume:
                    next_status = "blocked"
                else:
                    next_status = transition_run(
                        run.status,
                        command.command,
                        has_running_tasks=any(t.status == "running" for t in tasks)
                        or any(tool.status == "running" for tool in tools),
                    )
            except ValueError as exc:
                raise DomainError(
                    "conflict", "Команда недоступна в текущем состоянии запуска."
                ) from exc
            if command.command == "pause":
                run.pause_requested = True
            elif command.command == "resume":
                run.pause_requested = False
                next_status = (
                    "blocked"
                    if tool_resume
                    else "running"
                    if run.started_at is not None
                    else "created"
                )
            elif command.command == "cancel":
                run.cancel_requested = True
                if any(attempt.status == "uncertain" for attempt in attempts):
                    next_status = "blocked"
                    run.blocked_reason = "Отмена запрошена, но исход операции ещё неизвестен."
                elif any(attempt.status == "running" for attempt in attempts):
                    next_status = "pausing"
            run.status = next_status
            if attempts or tools:
                self._settle_control(session, run)
                next_status = run.status
            if next_status == "cancelled":
                run.finished_at = now()
                for task in tasks:
                    if task.status not in TERMINAL_RUNS:
                        task.status = "cancelled"
                        task.record_version += 1
                        task.lease_owner = None
                        task.lease_expires_at = None
                        task.active_attempt_id = None
                        task.fencing_token += 1
                for agent in agents:
                    agent.current_task_id = None
                    agent.activity = None
                    if agent.lifecycle == "busy":
                        agent.lifecycle = "idle"
                self._settle_control(session, run)
            event_class = {
                "pause": RunPausedEvent,
                "resume": RunResumedEvent,
                "cancel": RunCancelledEvent,
            }[command.command]
            if next_status == "pausing":
                event_class = RunPausingEvent
            previous = session.scalar(
                select(Event.event_id)
                .where(Event.run_id == run_id)
                .order_by(Event.seq.desc())
                .limit(1)
            )
            if attempts or tools or self._decisions(session, run_id):
                action = (
                    "run.cancelling"
                    if command.command == "cancel" and next_status != "cancelled"
                    else event_class.model_fields["event_type"].default
                )
                if command.command == "pause":
                    action = (
                        "run.paused"
                        if run.status == "paused"
                        else "run.pausing"
                        if run.status == "pausing"
                        else "run.blocked"
                    )
                self._emit_workflow(
                    session, run, action, actor_id="local_user", correlation_id=correlation_id
                )
            else:
                self._record_event(
                    session,
                    run,
                    event_class,
                    RunStatePayload(
                        run=RunView.model_validate(run),
                        tasks=[TaskView.model_validate(t) for t in tasks],
                        agents=[AgentView.model_validate(agent) for agent in agents],
                    ),
                    correlation_id,
                    causation_id=previous,
                )
            result = RunView.model_validate(run)
            self._save_receipt(session, scope, key, digest, result)
            return result

    def snapshot(self, run_id: str) -> Snapshot:
        self.refresh_worker_presence()
        with self.database.read() as session:
            run = self._run(session, run_id)
            project = self._project(session, run.project_id)
            artifacts = session.scalars(
                select(Artifact)
                .where(Artifact.run_id == run_id)
                .order_by(Artifact.created_at, Artifact.id)
            )
            return Snapshot(
                project=ProjectView.model_validate(project),
                run=RunView.model_validate(run),
                tasks=[TaskView.model_validate(task) for task in self._tasks(session, run_id)],
                agents=[AgentView.model_validate(agent) for agent in self._agents(session, run_id)],
                artifacts=[ArtifactView.model_validate(artifact) for artifact in artifacts],
                last_event_seq=run.last_event_seq,
                agent_runs=[
                    AgentRunView.model_validate(attempt)
                    for attempt in self._attempts(session, run_id)
                ],
                decisions=[
                    DecisionView.model_validate(decision)
                    for decision in self._decisions(session, run_id)
                ],
                usage=self._usage(session, run),
                candidate=candidate_view(session, run.id),
                tool_runs=[
                    ToolRunView.model_validate(tool) for tool in self._tools(session, run.id)
                ],
                quality_cycles=self._quality_views(session, run.id),
                delivery=self._delivery_view(session, run.id),
                preview_sessions=self._preview_views(session, run.id),
            )

    def usage(self, run_id: str) -> UsageSummary:
        with self.database.read() as session:
            return self._usage(session, self._run(session, run_id))

    def agent_runs(self, run_id):
        with self.database.read() as session:
            self._run(session, run_id)
            return [
                AgentRunView.model_validate(attempt) for attempt in self._attempts(session, run_id)
            ]

    def decisions(self, run_id):
        with self.database.read() as session:
            self._run(session, run_id)
            return [
                DecisionView.model_validate(decision)
                for decision in self._decisions(session, run_id)
            ]

    def attempt_trace(self, attempt_id):
        with self.database.read() as session:
            attempt = session.get(AgentRun, attempt_id)
            if attempt is None:
                raise DomainError("not_found", "Попытка не найдена.", status=404)
            return AttemptTrace(
                attempt_id=attempt.id,
                prompt=attempt.redacted_prompt,
                raw_response=attempt.redacted_response,
                parameters=attempt.parameters,
                input_versions=attempt.input_versions,
                stop_reason=attempt.stop_reason,
                redaction_version=attempt.redaction_version,
            )

    def artifact(self, artifact_id):
        with self.database.read() as session:
            artifact = session.get(Artifact, artifact_id)
            if artifact is None:
                raise DomainError("not_found", "Артефакт не найден.", status=404)
            return ArtifactView.model_validate(artifact)

    def artifacts(self, run_id):
        with self.database.read() as session:
            self._run(session, run_id)
            return [
                ArtifactView.model_validate(artifact)
                for artifact in session.scalars(
                    select(Artifact)
                    .where(Artifact.run_id == run_id)
                    .order_by(Artifact.created_at, Artifact.id)
                )
            ]

    def candidate(self, run_id):
        with self.database.read() as session:
            self._run(session, run_id)
            return candidate_view(session, run_id)

    def artifact_content(self, artifact_id):
        with self.database.read() as session:
            artifact = session.get(Artifact, artifact_id)
            if artifact is None:
                raise DomainError("not_found", "Артефакт не найден.", status=404)
            if artifact.content_text is None:
                raise DomainError(
                    "capability_unavailable", "Содержимое этой версии артефакта недоступно."
                )
            data = artifact.content_text.encode("utf-8")
            if (
                hashlib.sha256(data).hexdigest() != artifact.content_hash
                or len(data) != artifact.byte_size
            ):
                raise DomainError(
                    "artifact_corrupt", "Хэш или размер артефакта не совпадает.", status=409
                )
            return ArtifactContent(
                artifact_id=artifact.id,
                content_hash=artifact.content_hash,
                media_type=artifact.media_type,
                byte_size=artifact.byte_size,
                content=artifact.content_text,
            )

    def worker_connected(self, *, required_roles=(), required_tools=(), require_single=False):
        self.refresh_worker_presence()
        with self.database.read() as session:
            workers = list(
                session.scalars(select(WorkerHeartbeat).where(WorkerHeartbeat.expires_at > now()))
            )
            if require_single:
                return any(
                    set(required_roles) <= set(worker.supported_roles)
                    and set(required_tools) <= set(worker.supported_tools)
                    for worker in workers
                )
            roles = {role for worker in workers for role in worker.supported_roles}
            tools = {tool for worker in workers for tool in worker.supported_tools}
            return bool(workers) and set(required_roles) <= roles and set(required_tools) <= tools

    def refresh_worker_presence(self):
        # Expiry is a bounded system observation; it never executes a provider.
        with self.database.sessions.begin() as session:
            connected = session.scalar(
                select(WorkerHeartbeat.owner).where(WorkerHeartbeat.expires_at > now()).limit(1)
            )
            if connected is not None:
                return
            for run in session.scalars(
                select(Run)
                .where(Run.status.in_(["created", "running", "pausing", "paused", "blocked"]))
                .with_for_update(skip_locked=True)
            ):
                connected = session.scalar(
                    select(WorkerHeartbeat.owner).where(WorkerHeartbeat.expires_at > now()).limit(1)
                )
                if connected is not None:
                    return
                changed = False
                for agent in self._agents(session, run.id):
                    if agent.lifecycle != "offline":
                        agent.lifecycle, agent.activity = "offline", None
                        changed = True
                if changed:
                    self._emit_workflow(session, run, "worker.disconnected")

    def resolve_decision(self, decision_id, command: DecisionResolution, key, correlation_id):
        from codehead.llm.redaction import redact

        scope, digest = f"decision:{decision_id}", payload_hash(command)
        with self.database.sessions.begin() as session:
            self._lock_commands(session)
            decision = session.get(Decision, decision_id)
            if decision is None:
                raise DomainError("not_found", "Решение не найдено.", status=404)
            run = self._run(session, decision.run_id, for_update=True)
            existing = self._receipt(session, scope, key, digest)
            if existing:
                return RunView.model_validate(existing)
            session.refresh(decision)
            if (
                decision.status != "open"
                or decision.version != command.version
                or run.status in TERMINAL_RUNS
            ):
                raise DomainError("conflict", "Версия решения изменилась. Обновите состояние.")
            if command.choice not in decision.choices:
                raise DomainError(
                    "validation_error", "Этот ответ не разрешён для решения.", status=422
                )
            if (
                command.choice in {"confirm_failed", "retry_with_risk"}
                and len(command.comment.strip()) < 10
            ):
                raise DomainError(
                    "validation_error",
                    "Добавьте подтверждение исхода или согласие с риском дубликата.",
                    status=422,
                )
            if run.cancel_requested and command.choice in {"retry_with_risk", "retry_files"}:
                raise DomainError("conflict", "Повтор недоступен после запроса отмены.")
            if decision.kind == "tool_uncertain_outcome" or decision.tool_run_id is not None:
                response = self._resolve_tool_decision(
                    session, run, decision, command, correlation_id
                )
                self._save_receipt(session, scope, key, digest, response)
                return response
            task = session.get(Task, decision.task_id)
            if command.choice == "retry_files":
                attempt = session.get(AgentRun, decision.attempt_id)
                if (
                    decision.kind != "file_conflict"
                    or run.workflow_version not in CANDIDATE_WORKFLOW_VERSIONS
                    or task.role not in {"backend", "frontend"}
                    or task.status != "waiting_for_decision"
                    or attempt is None
                    or attempt.status != "failed"
                    or attempt.error_code != "file_version_conflict"
                ):
                    raise DomainError("conflict", "Повтор предложения файлов больше не актуален.")
            if (
                command.choice in {"approve", "retry_with_risk", "retry_files", "reject"}
                and task.status in TERMINAL_RUNS
            ):
                raise DomainError(
                    "conflict", "Завершённая задача не может быть переоткрыта решением."
                )
            decision.status, decision.choice, decision.comment = (
                "resolved",
                command.choice,
                redact(command.comment),
            )
            decision.version += 1
            decision.resolved_at = now()
            if decision.blocking:
                task.record_version += 1
            if command.choice in {"approve", "retry_with_risk", "retry_files"}:
                task.status, task.blocked_reason = "queued", None
                if command.choice == "retry_with_risk":
                    session.add(
                        Decision(
                            id=identifier(),
                            run_id=run.id,
                            task_id=task.id,
                            attempt_id=decision.attempt_id,
                            kind="uncertain_outcome",
                            status="open",
                            version=1,
                            blocking=False,
                            title="Уточнить исход предыдущей попытки",
                            summary=(
                                "Повтор с риском дубликата разрешён. "
                                "Подтвердите отказ старой попытки после проверки её исхода."
                            ),
                            choices=["confirm_failed"],
                            artifact_ids=[],
                            created_at=now(),
                        )
                    )
            elif command.choice == "confirm_failed":
                attempt = session.get(AgentRun, decision.attempt_id)
                if attempt.status != "uncertain":
                    raise DomainError("conflict", "Неизвестный исход уже изменился.")
                attempt.status, attempt.finished_at = "failed", now()
                attempt.error_message = "Пользователь подтвердил отказ: " + decision.comment
                if decision.blocking:
                    task.blocked_reason = (
                        "Подтверждён отказ операции. Можно отменить запуск и начать заново."
                    )
            else:
                task.status, task.blocked_reason = (
                    "blocked",
                    (
                        "Автор отклонил повтор предложения файлов."
                        if decision.kind == "file_conflict"
                        else "Автор отклонил архитектуру."
                    ),
                )
            if decision.kind == "file_conflict":
                self._candidate_progress(session, run)
            open_decisions = any(
                item.status == "open" and item.blocking for item in self._decisions(session, run.id)
            )
            blockers = [
                item
                for item in self._tasks(session, run.id)
                if item.status in {"blocked", "failed"}
            ]
            if open_decisions or blockers:
                run.status, run.blocked_reason = (
                    "blocked",
                    next((item.blocked_reason for item in blockers if item.blocked_reason), None)
                    or ("Ожидается решение автора." if open_decisions else run.blocked_reason),
                )
            else:
                run.status = (
                    "paused" if run.pause_requested else "running" if run.started_at else "created"
                )
                run.blocked_reason = None
            if run.cancel_requested or run.pause_requested:
                self._settle_control(session, run)
            self._emit_workflow(
                session,
                run,
                "decision.resolved",
                actor_id="local_user",
                task_id=task.id,
                correlation_id=correlation_id,
            )
            response = RunView.model_validate(run)
            self._save_receipt(session, scope, key, digest, response)
            return response

    def events(self, run_id: str, after_seq: int = 0, limit: int = 100) -> EventsPage:
        if after_seq < 0 or not 1 <= limit <= 200:
            raise DomainError(
                "validation_error", "Неверный курсор или размер страницы.", status=422
            )
        self.refresh_worker_presence()
        with self.database.read() as session:
            run = self._run(session, run_id)
            if after_seq > run.last_event_seq:
                raise DomainError("conflict", "Курсор опережает журнал. Загрузите новый снимок.")
            records = list(
                session.scalars(
                    select(Event)
                    .where(Event.run_id == run_id, Event.seq > after_seq)
                    .order_by(Event.seq)
                    .limit(limit + 1)
                )
            )
            events = [
                EVENT_ADAPTER.validate_python(record, from_attributes=True)
                for record in records[:limit]
            ]
            return EventsPage(
                events=events,
                next_after_seq=events[-1].seq if events else after_seq,
                has_more=len(records) > limit,
                last_event_seq=run.last_event_seq,
            )
