"""Short, fenced worker transactions; provider calls never hold these sessions."""

from dataclasses import dataclass
from datetime import timedelta
from decimal import Decimal
from pathlib import Path

from sqlalchemy import select

from codehead.clinic.files import (
    ROLE_PATHS,
    FileConflict,
    InvalidFile,
    normalize_relative_path,
    validate_text,
)
from codehead.clinic.profile import REPOSITORY_ROOT, load_profile
from codehead.clinic.workspace import materialize
from codehead.errors import DomainError
from codehead.llm.provider import LiveProviderUnavailable, ProviderFailure, ProviderRequest
from codehead.llm.redaction import redact
from codehead.llm.test_provider import TestProvider
from codehead.persistence.candidates import CandidateStore
from codehead.persistence.models import (
    Agent,
    AgentRun,
    Artifact,
    Candidate,
    Decision,
    Project,
    Run,
    Task,
    WorkerHeartbeat,
)
from codehead.persistence.service import ProjectService, identifier, now
from codehead.workflow.publication import NEXT_STAGE_REASON, PublicationTransactions

DOCUMENT_ROLES = ("product_manager", "architect", "cto")
SOURCE_ROLES = ("backend", "frontend")
SUPPORTED_ROLES = DOCUMENT_ROLES + SOURCE_ROLES
ARTIFACT_KINDS = {
    "product_manager": {"requirements"},
    "architect": {"architecture", "api_contract"},
    "cto": {"decision"},
}


@dataclass(frozen=True)
class Lease:
    run_id: str
    task_id: str
    attempt_id: str
    owner: str
    fencing_token: int
    input_versions: dict[str, int]
    request: ProviderRequest
    provider: object


class WorkerService(PublicationTransactions, ProjectService):
    def __init__(
        self,
        database,
        *,
        clock=now,
        lease_seconds=30,
        secrets=(),
        step_delay=0,
        workspace_root=None,
        materializer=materialize,
    ):
        super().__init__(database)
        if not 1 <= lease_seconds <= 300:
            raise ValueError("Lease duration must be between 1 and 300 seconds")
        self.clock = clock
        self.lease_seconds = lease_seconds
        self.secrets = secrets
        self.step_delay = step_delay
        self.profile = load_profile()
        self.candidates = CandidateStore(self.profile, clock=clock)
        self.workspace_root = Path(
            workspace_root or REPOSITORY_ROOT / ".data" / "candidates"
        ).absolute()
        self.materializer = materializer

    @staticmethod
    def _supported_roles(run):
        return SUPPORTED_ROLES if run.workflow_version == "clinic-v2" else DOCUMENT_ROLES

    def _register(self, session, owner):
        stamp = self.clock()
        heartbeat = session.get(WorkerHeartbeat, owner)
        if heartbeat is None:
            heartbeat = WorkerHeartbeat(owner=owner, supported_roles=list(SUPPORTED_ROLES))
            session.add(heartbeat)
        heartbeat.supported_roles = list(SUPPORTED_ROLES)
        heartbeat.updated_at = stamp
        heartbeat.expires_at = stamp + timedelta(seconds=self.lease_seconds)

    def register(self, owner):
        if not owner or len(owner) > 100:
            raise ValueError("Invalid worker identity")
        with self.database.sessions.begin() as session:
            self._register(session, owner)
            runs = session.scalars(
                select(Run)
                .where(
                    Run.mode == "test",
                    Run.status.in_(["created", "running", "pausing", "paused", "blocked"]),
                )
                .with_for_update(skip_locked=True)
            )
            for run in runs:
                supported = self._supported_roles(run)
                changed = False
                pending = {
                    task.role: task
                    for task in self._tasks(session, run.id)
                    if task.status in {"blocked", "waiting_for_decision"}
                }
                for agent in self._agents(session, run.id):
                    if agent.role in supported:
                        source = agent.role in SOURCE_ROLES
                        version = "worker-test-v2" if source else "worker-test-v1"
                        operations = [
                            "read_inputs",
                            "propose_files" if source else "propose_artifacts",
                        ]
                        if agent.role == "cto":
                            operations.append("request_decision")
                        if (
                            agent.instructions_version != version
                            or agent.allowed_operations != operations
                        ):
                            agent.instructions_version = version
                            agent.allowed_operations = operations
                            changed = True
                    if agent.role in supported and agent.lifecycle == "offline":
                        agent.lifecycle = "idle"
                        task = pending.get(agent.role)
                        agent.activity = "waiting" if task else None
                        agent.current_task_id = task.id if task else None
                        changed = True
                if changed:
                    self._emit_workflow(session, run, "worker.connected", actor_id=owner)

    def disconnect(self, owner):
        with self.database.sessions.begin() as session:
            heartbeat = session.get(WorkerHeartbeat, owner)
            if heartbeat is not None:
                heartbeat.expires_at = self.clock()
            another = session.scalar(
                select(WorkerHeartbeat.owner)
                .where(WorkerHeartbeat.owner != owner, WorkerHeartbeat.expires_at > self.clock())
                .limit(1)
            )
            if another is not None:
                return
            for run in session.scalars(
                select(Run)
                .where(Run.status.in_(["created", "running", "pausing", "paused", "blocked"]))
                .with_for_update()
            ):
                changed = False
                for agent in self._agents(session, run.id):
                    if agent.lifecycle != "offline":
                        agent.lifecycle, agent.activity = "offline", None
                        changed = True
                if changed:
                    self._emit_workflow(session, run, "worker.disconnected", actor_id=owner)

    def _block(self, session, run, tasks, reason, action):
        run.status = "blocked"
        run.blocked_reason = reason
        agents = {agent.role: agent for agent in self._agents(session, run.id)}
        for task in tasks:
            task.status = "blocked"
            task.blocked_reason = reason
            task.record_version += 1
            if task.role in self._supported_roles(run) and agents[task.role].lifecycle == "busy":
                agent = agents[task.role]
                agent.lifecycle = "blocked"
                agent.activity = "waiting"
                agent.current_task_id = task.id
        self._emit_workflow(session, run, action)

    def _request(self, session, run, task):
        project = session.get(Project, run.project_id)
        if project.requirements_version != run.requirements_version:
            raise ProviderFailure("input_version_conflict", "Версия требований изменилась.")
        tasks = {item.id: item for item in self._tasks(session, run.id)}
        ancestors = set()
        pending = list(task.dependencies)
        while pending:
            dependency = pending.pop()
            if dependency in ancestors:
                continue
            if dependency == task.id or dependency not in tasks:
                raise ProviderFailure("invalid_workflow", "Неверные зависимости задачи.")
            ancestors.add(dependency)
            pending.extend(tasks[dependency].dependencies)
        source = run.workflow_version == "clinic-v2" and task.role in SOURCE_ROLES
        inputs = []
        for artifact in session.scalars(
            select(Artifact)
            .where(Artifact.run_id == run.id)
            .order_by(Artifact.created_at, Artifact.id)
        ):
            if artifact.task_id not in ancestors:
                continue
            if source and artifact.artifact_type not in {
                "requirements",
                "architecture",
                "api_contract",
                "decision",
            }:
                continue
            if artifact.content_text is None:
                raise ProviderFailure(
                    "input_unavailable", "Содержимое входного документа недоступно."
                )
            inputs.append(
                {
                    "id": artifact.id,
                    "version": artifact.version,
                    "artifact_type": artifact.artifact_type,
                    "content": artifact.content_text,
                    "content_hash": artifact.content_hash,
                    "relative_path": artifact.relative_path,
                }
            )
        bases = []
        if source:
            candidate = self.candidates.ensure(session, run)
            current = {file["relative_path"]: file for file in candidate.files}
            for path in sorted(ROLE_PATHS[task.role]):
                file = current.get(path)
                bases.append(
                    {
                        "relative_path": path,
                        "base_hash": file["content_hash"] if file else None,
                        "artifact_id": file["artifact_id"] if file else None,
                        "version": file["version"] if file else None,
                    }
                )
                if file is None:
                    continue
                artifact = session.get(Artifact, file["artifact_id"])
                if (
                    artifact is None
                    or artifact.run_id != run.id
                    or artifact.artifact_type != "source_code"
                    or artifact.relative_path != path
                    or artifact.version != file["version"]
                    or artifact.content_text is None
                    or artifact.content_hash != file["content_hash"]
                ):
                    raise ProviderFailure(
                        "input_unavailable", "Основа прикладного файла недоступна."
                    )
                inputs.append(
                    {
                        "id": artifact.id,
                        "version": artifact.version,
                        "artifact_type": artifact.artifact_type,
                        "content": artifact.content_text,
                        "content_hash": artifact.content_hash,
                        "relative_path": artifact.relative_path,
                    }
                )
        return ProviderRequest(
            task.role,
            project.name,
            project.description,
            run.requirements_version,
            tuple(inputs),
            max_output_tokens=65536 if source else 2048,
            candidate_files=tuple(bases),
            profile_version=run.profile_version,
            profile_hash=run.profile_hash,
            acceptance_suite_hash=run.acceptance_suite_hash,
        )

    def claim(self, owner, provider=None):
        self.register(owner)
        with self.database.sessions.begin() as session:
            run = session.scalar(
                select(Run)
                .where(Run.status.in_(["created", "running"]), Run.cancel_requested.is_(False))
                .order_by(Run.created_at)
                .with_for_update(skip_locked=True)
            )
            if run is None:
                return None
            self._accept_in_session(session, run)
            tasks = self._tasks(session, run.id)
            succeeded = {task.id for task in tasks if task.status == "succeeded"}
            ready = [
                task
                for task in tasks
                if task.status == "queued"
                and task.active_attempt_id is None
                and all(dependency in succeeded for dependency in task.dependencies)
            ]
            if not ready:
                return None
            if ready[0].role not in self._supported_roles(run):
                if run.workflow_version == "clinic-v2":
                    candidate = session.scalar(select(Candidate).where(Candidate.run_id == run.id))
                    if candidate is not None and candidate.status == "materializing":
                        return None
                self._block(
                    session,
                    run,
                    ready,
                    NEXT_STAGE_REASON
                    if run.workflow_version == "clinic-v2"
                    else "Следующий этап Clinic Demo ещё не подключён: Backend/Frontend.",
                    "stage.unavailable",
                )
                return None
            task = ready[0]
            attempts = self._attempts(session, run.id)
            limits = run.limits
            if task.role in SOURCE_ROLES and limits["max_files_per_proposal"] < 3:
                self._block(
                    session,
                    run,
                    [task],
                    "Для завершённого предложения инженера нужен лимит хотя бы 3 файла.",
                    "budget.exceeded",
                )
                return None
            reserved = sum(
                attempt.started_at is not None or attempt.status == "created"
                for attempt in attempts
            )
            if (
                reserved >= limits["max_llm_calls"]
                or (self.clock() - run.created_at).total_seconds() >= limits["max_duration_seconds"]
            ):
                self._block(
                    session,
                    run,
                    [task],
                    "Исчерпан лимит запросов или времени запуска.",
                    "budget.exceeded",
                )
                return None
            if (
                sum(attempt.status in {"created", "running"} for attempt in attempts)
                >= limits["max_parallel_tasks"]
            ):
                return None
            selected_provider = provider or (
                TestProvider(
                    secrets=self.secrets,
                    delay_seconds=self.step_delay,
                    with_files=run.workflow_version == "clinic-v2",
                )
                if run.mode == "test"
                else LiveProviderUnavailable()
            )
            if run.mode != "test":
                selected_provider = LiveProviderUnavailable()
            try:
                request = self._request(session, run, task)
                prompt = redact(selected_provider.prepare(request), self.secrets)
            except (ProviderFailure, InvalidFile) as failure:
                reason = (
                    "Live-провайдер не подключён. Для проверки процесса выберите тестовый запуск."
                    if failure.code == "provider_unavailable"
                    else str(failure)
                )
                self._block(session, run, [task], reason, failure.code)
                return None
            task.input_versions = {item["id"]: item["version"] for item in request.inputs}
            task.attempt += 1
            task.fencing_token += 1
            task.record_version += 1
            task.lease_owner = owner
            task.lease_expires_at = self.clock() + timedelta(seconds=self.lease_seconds)
            task.active_attempt_id = identifier()
            agents = self._agents(session, run.id)
            for agent in agents:
                if (
                    run.mode == "test"
                    and agent.role in self._supported_roles(run)
                    and agent.lifecycle == "offline"
                ):
                    agent.lifecycle = "idle"
            agent = next(item for item in agents if item.role == task.role)
            agent.lifecycle = "busy"
            agent.activity = {
                "product_manager": "planning",
                "architect": "analyzing",
                "cto": "reviewing",
                "backend": "coding",
                "frontend": "coding",
            }[task.role]
            agent.location = (
                "development"
                if task.role in SOURCE_ROLES
                else "product"
                if task.role == "product_manager"
                else "architecture"
            )
            agent.current_task_id = task.id
            predecessor = next(
                (
                    decision
                    for decision in reversed(self._decisions(session, run.id))
                    if decision.task_id == task.id
                    and decision.choice in {"retry_with_risk", "retry_files"}
                ),
                None,
            )
            attempt = AgentRun(
                id=task.active_attempt_id,
                run_id=run.id,
                task_id=task.id,
                agent_id=agent.id,
                number=task.attempt,
                fencing_token=task.fencing_token,
                status="created",
                provider=selected_provider.name,
                model=selected_provider.model,
                input_versions=dict(task.input_versions),
                parameters={
                    "mode": run.mode,
                    "max_output_tokens": request.max_output_tokens,
                    "instructions_version": agent.instructions_version,
                    "price_version": "not-billable-test-v1",
                    "dispatched": False,
                    **(
                        {
                            "candidate_files": list(request.candidate_files),
                            "profile_version": request.profile_version,
                            "profile_hash": request.profile_hash,
                            "acceptance_suite_hash": request.acceptance_suite_hash,
                        }
                        if task.role in SOURCE_ROLES
                        else {}
                    ),
                },
                created_at=self.clock(),
                redacted_prompt=prompt,
                retry_of_attempt_id=predecessor.attempt_id if predecessor else None,
                decision_id=predecessor.id if predecessor else None,
            )
            session.add(attempt)
            run.status = "running"
            run.started_at = run.started_at or self.clock()
            run.blocked_reason = None
            self._emit_workflow(session, run, "task.claimed", actor_id=owner, task_id=task.id)
            return Lease(
                run.id,
                task.id,
                attempt.id,
                owner,
                task.fencing_token,
                dict(task.input_versions),
                request,
                selected_provider,
            )

    def _check(self, session, lease, *, statuses=("created", "running")):
        run = self._run(session, lease.run_id, for_update=True)
        task = session.get(Task, lease.task_id)
        attempt = session.get(AgentRun, lease.attempt_id)
        valid = (
            task is not None
            and attempt is not None
            and task.run_id == run.id
            and attempt.task_id == task.id
            and attempt.run_id == run.id
        )
        valid = (
            valid
            and task.active_attempt_id == lease.attempt_id
            and task.lease_owner == lease.owner
            and task.fencing_token == lease.fencing_token
            and attempt.fencing_token == lease.fencing_token
        )
        valid = (
            valid
            and task.lease_expires_at is not None
            and task.lease_expires_at > self.clock()
            and task.input_versions == lease.input_versions
            and attempt.input_versions == lease.input_versions
            and attempt.status in statuses
        )
        valid = valid and task.role == lease.request.role and task.attempt == attempt.number
        if not valid or run.status in {"succeeded", "failed", "cancelled"}:
            raise DomainError("stale_attempt", "Попытка или её lease больше не актуальны.")
        for artifact_id, version in lease.input_versions.items():
            artifact = session.get(Artifact, artifact_id)
            if artifact is None or artifact.run_id != run.id or artifact.version != version:
                raise DomainError("stale_attempt", "Входные версии попытки больше не актуальны.")
        project = session.get(Project, run.project_id)
        if project.requirements_version != run.requirements_version:
            raise DomainError("stale_attempt", "Версия требований изменилась.")
        return run, task, attempt

    @staticmethod
    def _release(task):
        task.active_attempt_id = None
        task.lease_owner = None
        task.lease_expires_at = None
        task.record_version += 1

    def begin(self, lease):
        with self.database.sessions.begin() as session:
            run, task, attempt = self._check(session, lease, statuses=("created",))
            if (self.clock() - run.created_at).total_seconds() >= run.limits[
                "max_duration_seconds"
            ]:
                attempt.status, attempt.finished_at = "cancelled", self.clock()
                self._release(task)
                self._block(
                    session,
                    run,
                    [task],
                    "Исчерпан лимит времени перед отправкой запроса.",
                    "budget.exceeded",
                )
                return False
            if run.status not in {"created", "running"} or run.cancel_requested:
                attempt.status = "cancelled"
                attempt.finished_at = self.clock()
                self._release(task)
                agent = session.get(Agent, attempt.agent_id)
                agent.lifecycle, agent.activity, agent.current_task_id = "idle", None, None
                self._emit_workflow(session, run, "task.released", actor_id=lease.owner)
                return False
            task.status = "running"
            task.record_version += 1
            attempt.status = "running"
            attempt.started_at = self.clock()
            attempt.parameters = {**attempt.parameters, "dispatched": True}
            self._emit_workflow(session, run, "task.started", actor_id=lease.owner, task_id=task.id)
            return True

    def heartbeat(self, lease):
        with self.database.sessions.begin() as session:
            run, task, _ = self._check(session, lease)
            self._register(session, lease.owner)
            task.lease_expires_at = self.clock() + timedelta(seconds=self.lease_seconds)
            task.record_version += 1
            self._emit_workflow(
                session, run, "lease.renewed", actor_id=lease.owner, task_id=task.id
            )

    def _decision(self, session, run, task, attempt, *, kind, summary, artifact_ids=()):
        title, choices = {
            "architecture_approval": ("Принять архитектуру?", ["approve", "reject"]),
            "file_conflict": ("Обновить основу файлов?", ["retry_files", "reject"]),
            "uncertain_outcome": (
                "Исход операции неизвестен",
                ["confirm_failed", "retry_with_risk"],
            ),
        }[kind]
        decision = Decision(
            id=identifier(),
            run_id=run.id,
            task_id=task.id,
            attempt_id=attempt.id,
            kind=kind,
            status="open",
            version=1,
            title=title,
            summary=redact(summary, self.secrets),
            choices=choices,
            artifact_ids=list(artifact_ids),
            created_at=self.clock(),
        )
        session.add(decision)
        return decision

    def _save_result(self, attempt, result):
        attempt.finished_at = self.clock()
        attempt.provider_request_id = result.request_id
        attempt.stop_reason = result.stop_reason
        attempt.input_tokens, attempt.output_tokens = result.input_tokens, result.output_tokens
        attempt.cost_usd, attempt.latency_ms = Decimal(str(result.cost_usd)), result.latency_ms
        attempt.redacted_response = redact(result.raw_response, self.secrets)

    def _file_conflict(self, session, run, task, attempt, failure, owner):
        candidate = self.candidates.ensure(session, run)
        attempt.status = "failed"
        attempt.error_code, attempt.error_message = failure.code, str(failure)
        self._release(task)
        task.status, task.blocked_reason = "waiting_for_decision", str(failure)
        run.status, run.blocked_reason = "blocked", str(failure)
        candidate.status, candidate.blocked_reason = "conflict", str(failure)
        candidate.updated_at = self.clock()
        agent = session.get(Agent, attempt.agent_id)
        agent.lifecycle, agent.activity, agent.current_task_id = "blocked", "waiting", task.id
        references = [candidate.manifest_artifact_id] + [
            file["artifact_id"]
            for file in candidate.files
            if file["relative_path"] in ROLE_PATHS[task.role]
        ]
        self._decision(
            session,
            run,
            task,
            attempt,
            kind="file_conflict",
            summary=str(failure),
            artifact_ids=references,
        )
        self._settle_control(session, run)
        self._emit_workflow(
            session, run, "task.waiting_for_decision", actor_id=owner, task_id=task.id
        )

    def finish(self, lease, result):
        import hashlib
        import math

        if result.stop_reason != "stop":
            raise ProviderFailure(
                "incomplete_provider_output",
                "Ответ провайдера не завершён.",
                dispatched=True,
                raw_response=result.raw_response,
                stop_reason=result.stop_reason,
            )
        source = lease.request.role in SOURCE_ROLES
        kinds = [draft.artifact_type for draft in result.artifacts]
        if source:
            try:
                paths = [
                    normalize_relative_path(file.relative_path).casefold() for file in result.files
                ]
                valid = (
                    not result.artifacts
                    and len(paths) == 3
                    and set(paths) == {path.casefold() for path in ROLE_PATHS[lease.request.role]}
                )
                for file in result.files:
                    validate_text(file.content)
            except InvalidFile:
                valid = False
        else:
            valid = (
                set(kinds) == ARTIFACT_KINDS[lease.request.role]
                and len(kinds) == len(set(kinds))
                and not result.files
            )
        if not valid:
            raise ProviderFailure(
                "invalid_provider_output",
                "Провайдер вернул неполный или недопустимый набор файлов/документов.",
                dispatched=True,
                raw_response=result.raw_response,
                stop_reason=result.stop_reason,
            )
        if (
            any(
                len(draft.content.encode("utf-8")) > 65536
                or draft.media_type not in {"text/markdown", "application/json", "text/plain"}
                for draft in result.artifacts
            )
            or len(result.raw_response.encode("utf-8")) > 262144
        ):
            raise ProviderFailure(
                "invalid_provider_output",
                "Ответ превышает лимит содержимого.",
                dispatched=True,
                stop_reason=result.stop_reason,
            )
        if (
            not math.isfinite(result.latency_ms)
            or result.latency_ms < 0
            or result.cost_usd != 0
            or result.input_tokens != 0
            or result.output_tokens != 0
        ):
            raise ProviderFailure(
                "invalid_provider_output",
                "Тестовый источник вернул неверный usage.",
                dispatched=True,
                stop_reason=result.stop_reason,
            )
        with self.database.sessions.begin() as session:
            run, task, attempt = self._check(session, lease, statuses=("running",))
            self._save_result(attempt, result)
            if source and not run.cancel_requested:
                try:
                    self.candidates.apply(
                        session,
                        run,
                        task,
                        attempt,
                        tuple(
                            file.model_copy(update={"content": redact(file.content, self.secrets)})
                            for file in result.files
                        ),
                        input_versions=lease.input_versions,
                    )
                except FileConflict as failure:
                    self._file_conflict(session, run, task, attempt, failure, lease.owner)
                    return
                except InvalidFile as failure:
                    raise ProviderFailure(
                        failure.code,
                        str(failure),
                        dispatched=True,
                        raw_response=result.raw_response,
                        stop_reason=result.stop_reason,
                    ) from failure
            attempt.status = "succeeded"
            agent = next(
                item for item in self._agents(session, run.id) if item.id == attempt.agent_id
            )
            self._release(task)
            if run.cancel_requested:
                task.status = "cancelled"
                agent.lifecycle, agent.activity, agent.current_task_id = "idle", None, None
                self._settle_control(session, run)
                self._emit_workflow(session, run, "run.cancelled", actor_id=lease.owner)
                return
            artifact_ids = []
            for draft in result.artifacts:
                content = (
                    redact(draft.content, self.secrets)
                    .removeprefix("\ufeff")
                    .replace("\r\n", "\n")
                    .replace("\r", "\n")
                )
                data = content.encode("utf-8")
                artifact_id = identifier()
                extension = "json" if draft.media_type == "application/json" else "md"
                artifact = Artifact(
                    id=artifact_id,
                    run_id=run.id,
                    task_id=task.id,
                    artifact_type=draft.artifact_type,
                    version=1,
                    content_hash=hashlib.sha256(data).hexdigest(),
                    relative_path=f"runs/{run.id}/artifacts/{artifact_id}.{extension}",
                    author_role=task.role,
                    input_versions=dict(lease.input_versions),
                    created_at=self.clock(),
                    provenance={
                        "origin": "test",
                        "producer_id": attempt.id,
                        "parent_artifact_id": None,
                    },
                    media_type=draft.media_type,
                    byte_size=len(data),
                    content_text=content,
                )
                session.add(artifact)
                artifact_ids.append(artifact_id)
            task.status = "succeeded"
            agent.lifecycle, agent.activity, agent.current_task_id = "idle", None, None
            action = "task.succeeded"
            if task.role == "cto":
                task.status = "waiting_for_decision"
                run.status, run.blocked_reason = (
                    "blocked",
                    "Ожидается решение автора об архитектуре.",
                )
                agent.lifecycle, agent.activity, agent.location, agent.current_task_id = (
                    "blocked",
                    "waiting",
                    "meeting",
                    task.id,
                )
                self._decision(
                    session,
                    run,
                    task,
                    attempt,
                    kind="architecture_approval",
                    summary=result.summary,
                    artifact_ids=artifact_ids,
                )
                action = "task.waiting_for_decision"
            elif source:
                self._candidate_progress(session, run)
            self._settle_control(session, run)
            self._emit_workflow(session, run, action, actor_id=lease.owner, task_id=task.id)

    def fail(self, lease, failure):
        with self.database.sessions.begin() as session:
            run, task, attempt = self._check(session, lease)
            attempt.status = (
                "uncertain"
                if failure.uncertain
                else "failed"
                if failure.dispatched
                else "cancelled"
            )
            attempt.finished_at = None if failure.uncertain else self.clock()
            attempt.error_code, attempt.error_message = (
                failure.code,
                redact(failure.message, self.secrets),
            )
            attempt.parameters = {**attempt.parameters, "dispatched": failure.dispatched}
            attempt.stop_reason = failure.stop_reason
            attempt.redacted_response = (
                redact(failure.raw_response, self.secrets)
                if failure.raw_response and len(failure.raw_response.encode("utf-8")) <= 262144
                else None
            )
            self._release(task)
            task.status = "blocked" if failure.uncertain or not failure.dispatched else "failed"
            task.blocked_reason = attempt.error_message
            run.status, run.blocked_reason = "blocked", attempt.error_message
            agent = next(
                item for item in self._agents(session, run.id) if item.id == attempt.agent_id
            )
            agent.lifecycle, agent.activity = (
                "blocked" if failure.uncertain else "failed",
                "waiting",
            )
            if failure.uncertain:
                self._decision(
                    session,
                    run,
                    task,
                    attempt,
                    kind="uncertain_outcome",
                    summary=attempt.error_message,
                )
            if task.role in SOURCE_ROLES:
                self._candidate_progress(session, run)
            self._settle_control(session, run)
            self._emit_workflow(
                session,
                run,
                "run.cancelled"
                if run.status == "cancelled"
                else "attempt.uncertain"
                if failure.uncertain
                else "task.failed",
                actor_id=lease.owner,
                task_id=task.id,
            )

    def recover(self):
        recovered = 0
        with self.database.sessions.begin() as session:
            runs = list(
                session.scalars(
                    select(Run)
                    .where(Run.status.in_(["created", "running", "pausing", "paused", "blocked"]))
                    .with_for_update(skip_locked=True)
                )
            )
            for run in runs:
                recovered += self._recover_publication(session, run)
                connected = (
                    session.scalar(
                        select(WorkerHeartbeat.owner)
                        .where(WorkerHeartbeat.expires_at > self.clock())
                        .limit(1)
                    )
                    is not None
                )
                if not connected:
                    changed = False
                    for agent in self._agents(session, run.id):
                        if agent.lifecycle != "offline":
                            agent.lifecycle, agent.activity = "offline", None
                            changed = True
                    if changed:
                        self._emit_workflow(session, run, "worker.disconnected")
                for task in self._tasks(session, run.id):
                    if (
                        task.active_attempt_id is None
                        or task.lease_expires_at is None
                        or task.lease_expires_at > self.clock()
                    ):
                        continue
                    attempt = session.get(AgentRun, task.active_attempt_id)
                    if attempt is None or attempt.status not in {"created", "running"}:
                        continue
                    agent = next(
                        item
                        for item in self._agents(session, run.id)
                        if item.id == attempt.agent_id
                    )
                    sent = attempt.status == "running"
                    attempt.status = "uncertain" if sent else "cancelled"
                    attempt.finished_at = None if sent else self.clock()
                    attempt.error_code = (
                        "lease_expired_after_dispatch" if sent else "lease_expired_before_dispatch"
                    )
                    attempt.error_message = (
                        "Исход операции неизвестен после потери worker."
                        if sent
                        else "Подготовка прервана до отправки запроса."
                    )
                    task.fencing_token += 1
                    self._release(task)
                    agent.lifecycle, agent.activity, agent.current_task_id = "offline", None, None
                    if sent:
                        task.status, task.blocked_reason = "blocked", attempt.error_message
                        run.status, run.blocked_reason = "blocked", attempt.error_message
                        self._decision(
                            session,
                            run,
                            task,
                            attempt,
                            kind="uncertain_outcome",
                            summary=attempt.error_message,
                        )
                        if task.role in SOURCE_ROLES:
                            self._candidate_progress(session, run)
                    recovered += 1
                    self._settle_control(session, run)
                    self._emit_workflow(
                        session,
                        run,
                        "attempt.uncertain" if sent else "attempt.recovered",
                        task_id=task.id,
                    )
        return recovered

    def accept_decisions(self):
        accepted = 0
        with self.database.sessions.begin() as session:
            for run in session.scalars(
                select(Run)
                .where(Run.status.in_(["created", "running"]))
                .with_for_update(skip_locked=True)
            ):
                accepted += self._accept_in_session(session, run)
        return accepted

    def _accept_in_session(self, session, run):
        accepted = 0
        for decision in self._decisions(session, run.id):
            task = session.get(Task, decision.task_id)
            if (
                decision.kind != "architecture_approval"
                or decision.status != "resolved"
                or decision.choice != "approve"
                or task.status != "queued"
                or task.active_attempt_id is not None
            ):
                continue
            task.status = "running"
            task.record_version += 1
            agent = next(item for item in self._agents(session, run.id) if item.role == task.role)
            agent.lifecycle, agent.activity, agent.current_task_id = "busy", "reviewing", task.id
            self._emit_workflow(session, run, "task.accepted", task_id=task.id)
            task.status, task.blocked_reason = "succeeded", None
            task.record_version += 1
            agent.lifecycle, agent.activity, agent.current_task_id = "idle", None, None
            self._emit_workflow(session, run, "task.succeeded", task_id=task.id)
            accepted += 1
        return accepted
