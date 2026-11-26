"""Queue and fence trusted checks in short locked Run transactions."""

import json
import math
from dataclasses import dataclass
from datetime import timedelta

from sqlalchemy import select

from codehead.clinic.files import InvalidFile, tree_hash
from codehead.clinic.profile import load_profile
from codehead.clinic.workspace import _manifest_document, _unique_json
from codehead.contracts import CandidateView, RunView, ToolCommand, ToolRunView
from codehead.errors import DomainError
from codehead.llm.redaction import redact
from codehead.persistence.candidates import candidate_view
from codehead.persistence.models import Artifact, Decision, QualityCycle, Run, ToolRun
from codehead.workflow.definition import CANDIDATE_WORKFLOW_VERSIONS
from codehead.workflow.publication import PublicationTransactions

SUPPORTED_TOOLS = ("validate_backend", "test_backend", "build_frontend")
PIN_FIELDS = ("profile_version", "profile_hash", "acceptance_suite_hash", "template_hash")


@dataclass(frozen=True)
class ToolLease:
    run_id: str
    owner: str
    fencing_token: int
    tool: ToolRunView
    candidate: CandidateView
    contents: dict[str, str]
    manifest_content: str


class ToolTransactions:
    def _quality_tool_remaining(self, run, tool):
        if tool.qa_cycle_id is None:
            return None
        return run.limits["max_duration_seconds"] - (self.clock() - run.created_at).total_seconds()

    def _expire_quality_tool(self, session, run, tool, owner):
        cycle = session.get(QualityCycle, tool.qa_cycle_id)
        self._quality_block(
            session, run, cycle, "Исчерпан лимит времени запуска во время автоматического QA."
        )
        if tool.status == "created":
            tool.status, tool.finished_at = "cancelled", self.clock()
            tool.error_code, tool.error_message = "run_duration_exceeded", run.blocked_reason
            tool.fencing_token += 1
            tool.lease_owner, tool.lease_expires_at = None, None
            self._quality_tool_finished(session, run, tool)
        self._emit_workflow(session, run, "budget.exceeded", actor_id=owner)

    def _occupied_slots(self, session, run):
        return (
            sum(
                attempt.status in {"created", "running"}
                for attempt in self._attempts(session, run.id)
            )
            + sum(
                tool.status == "running"
                or tool.status == "created"
                and tool.lease_owner is not None
                for tool in self._tools(session, run.id)
            )
            + int(self._has_active_delivery_publication(session, run.id))
        )

    @staticmethod
    def _tools(session, run_id):
        return list(
            session.scalars(
                select(ToolRun)
                .where(ToolRun.run_id == run_id)
                .order_by(ToolRun.created_at, ToolRun.id)
            )
        )

    def tool_runs(self, run_id):
        with self.database.read() as session:
            self._run(session, run_id)
            return [ToolRunView.model_validate(tool) for tool in self._tools(session, run_id)]

    @staticmethod
    def _candidate_pins(run, candidate, tool=None):
        if candidate is None or candidate.status != "ready" or not candidate.workspace_path:
            return False
        if any(getattr(run, name) != getattr(candidate, name) for name in PIN_FIELDS):
            return False
        if tool is not None and (
            candidate.id != tool.workspace_id
            or candidate.revision != tool.snapshot_version
            or candidate.tree_hash != tool.tree_hash
            or candidate.manifest_artifact_id != tool.manifest_artifact_id
            or candidate.manifest_hash != tool.manifest_hash
            or any(getattr(candidate, name) != getattr(tool, name) for name in PIN_FIELDS)
        ):
            return False
        return True

    def queue_tool(self, run_id, command: ToolCommand, key, correlation_id):
        from codehead.persistence.service import identifier, payload_hash

        scope, digest = f"tools:{run_id}", payload_hash(command)
        with self.database.sessions.begin() as session:
            self._lock_commands(session)
            run = self._run(session, run_id, for_update=True)
            existing = self._receipt(session, scope, key, digest)
            if existing:
                return ToolRunView.model_validate(existing)
            if command.required_isolation != "process_only":
                raise DomainError(
                    "runner_unavailable", "Требуемый уровень изоляции Runner недоступен."
                )
            if (
                run.mode != "test"
                or run.workflow_version not in CANDIDATE_WORKFLOW_VERSIONS
                or run.status not in {"running", "blocked"}
                or run.cancel_requested
                or run.pause_requested
            ):
                raise DomainError(
                    "conflict",
                    "Проверки доступны для готового тестового кандидата активного запуска.",
                )
            try:
                candidate = candidate_view(session, run.id)
            except InvalidFile as failure:
                raise DomainError(
                    "conflict", "Закреплённая версия кандидата недоступна."
                ) from failure
            if (
                not self._candidate_pins(run, candidate)
                or candidate.id != command.workspace_id
                or candidate.revision != command.snapshot_version
            ):
                raise DomainError(
                    "conflict", "Кандидат или его версия изменились. Обновите состояние."
                )
            if any(tool.status == "uncertain" for tool in self._tools(session, run.id)):
                raise DomainError(
                    "conflict", "Сначала уточните неизвестный исход предыдущей проверки."
                )
            if session.scalar(
                select(ToolRun.id)
                .where(
                    ToolRun.workspace_id == candidate.id,
                    ToolRun.operation_id == command.operation_id,
                    ToolRun.status.in_(["created", "running", "uncertain"]),
                )
                .limit(1)
            ):
                raise DomainError(
                    "conflict", "Такая проверка кандидата уже ожидает или выполняется."
                )
            tool = ToolRun(
                id=identifier(),
                run_id=run.id,
                **command.model_dump(),
                status="created",
                created_at=self.clock(),
                tree_hash=candidate.tree_hash,
                manifest_artifact_id=candidate.manifest_artifact_id,
                manifest_hash=candidate.manifest_hash,
                **{name: getattr(candidate, name) for name in PIN_FIELDS},
            )
            session.add(tool)
            session.flush()
            result = ToolRunView.model_validate(tool)
            self._emit_workflow(
                session, run, "tool.created", actor_id="local_user", correlation_id=correlation_id
            )
            self._save_receipt(session, scope, key, digest, result)
            return result

    @staticmethod
    def _tool_contents(session, run, view):
        profile = load_profile()
        expected_pins = (
            profile.id,
            profile.profile_hash,
            profile.suite_hash,
            profile.template_hash,
        )
        if tuple(getattr(view, name) for name in PIN_FIELDS) != expected_pins:
            raise InvalidFile("Закреплённый профиль, шаблон или acceptance suite изменились.")
        contents = {}
        for file in view.files:
            artifact = session.get(Artifact, file.artifact_id)
            if (
                artifact is None
                or artifact.relative_path != file.relative_path
                or artifact.media_type != file.media_type
            ):
                raise InvalidFile("Дескриптор immutable файла кандидата изменился.")
            contents[file.relative_path] = PublicationTransactions._content(
                session,
                run.id,
                file.artifact_id,
                kind="source_code",
                version=file.version,
                digest=file.content_hash,
                byte_size=file.byte_size,
            )
        if (
            len(contents) != len(view.files)
            or tree_hash({file.relative_path: file.content_hash for file in view.files})
            != view.tree_hash
        ):
            raise InvalidFile("Дерево кандидата не соответствует закреплённой версии.")
        manifest = PublicationTransactions._content(
            session,
            run.id,
            view.manifest_artifact_id,
            kind="candidate_manifest",
            version=view.revision,
            digest=view.manifest_hash,
            byte_size=view.manifest_byte_size,
        )
        try:
            document = json.loads(manifest, object_pairs_hook=_unique_json)
        except json.JSONDecodeError as failure:
            raise InvalidFile("Manifest кандидата повреждён.") from failure
        if document != _manifest_document(view):
            raise InvalidFile("Manifest описывает другую версию кандидата.")
        return contents, manifest

    def claim_tool(self, owner):
        self.register(owner)
        with self.database.sessions.begin() as session:
            run = session.scalar(
                select(Run)
                .where(
                    Run.mode == "test",
                    Run.workflow_version.in_(CANDIDATE_WORKFLOW_VERSIONS),
                    Run.status.in_(["running", "blocked"]),
                    Run.pause_requested.is_(False),
                    Run.cancel_requested.is_(False),
                )
                .order_by(Run.created_at)
                .with_for_update(skip_locked=True)
            )
            if run is None:
                return None
            tools = self._tools(session, run.id)
            if any(tool.status == "uncertain" for tool in tools):
                return None
            if self._occupied_slots(session, run) >= run.limits["max_parallel_tasks"]:
                return None
            pending = [
                tool
                for tool in tools
                if tool.operation_id in SUPPORTED_TOOLS
                and tool.status == "created"
                and tool.lease_owner is None
                and (
                    tool.qa_cycle_id is None
                    or session.get(QualityCycle, tool.qa_cycle_id).status
                    not in {"blocked", "cancelled"}
                )
            ]
            if not pending:
                return None
            tool = pending[0]
            remaining = self._quality_tool_remaining(run, tool)
            if remaining is not None:
                if remaining < 1:
                    self._expire_quality_tool(session, run, tool, owner)
                    return None
                tool.timeout_seconds = min(tool.timeout_seconds, math.floor(remaining))
            try:
                view = candidate_view(session, run.id)
                if not self._candidate_pins(run, view, tool):
                    raise InvalidFile("Закреплённый кандидат или его версия изменились.")
                contents, manifest = self._tool_contents(session, run, view)
            except InvalidFile as failure:
                tool.status, tool.finished_at = "failed", self.clock()
                tool.error_code, tool.error_message = "input_version_conflict", str(failure)
                if hasattr(self, "_quality_tool_finished"):
                    self._quality_tool_finished(session, run, tool)
                self._emit_workflow(session, run, "tool.failed", actor_id=owner)
                return None
            tool.fencing_token += 1
            tool.lease_owner = owner
            tool.lease_expires_at = self.clock() + timedelta(seconds=self.lease_seconds)
            self._emit_workflow(session, run, "tool.claimed", actor_id=owner)
            return ToolLease(
                run.id,
                owner,
                tool.fencing_token,
                ToolRunView.model_validate(tool),
                view,
                contents,
                manifest,
            )

    def _tool_current(self, session, run, lease, *, status="running"):
        tool = session.get(ToolRun, lease.tool.id)
        try:
            candidate = candidate_view(session, run.id)
        except InvalidFile as failure:
            raise DomainError(
                "stale_tool", "Закреплённый manifest проверки больше не актуален."
            ) from failure
        valid = (
            tool is not None
            and tool.run_id == run.id
            and tool.status == status
            and tool.lease_owner == lease.owner
            and tool.fencing_token == lease.fencing_token
            and tool.lease_expires_at is not None
            and tool.lease_expires_at > self.clock()
            and run.mode == "test"
            and run.workflow_version in CANDIDATE_WORKFLOW_VERSIONS
            and run.status in {"running", "blocked", "pausing"}
            and self._candidate_pins(run, candidate, tool)
            and self._candidate_pins(run, candidate, lease.tool)
            and candidate.files == lease.candidate.files
            and candidate.workspace_path == lease.candidate.workspace_path
            and all(
                getattr(tool, name) == getattr(lease.tool, name)
                for name in ToolCommand.model_fields
            )
        )
        if not valid:
            raise DomainError(
                "stale_tool", "Lease или закреплённая версия проверки больше не актуальны."
            )
        return tool

    def begin_tool(self, lease):
        with self.database.sessions.begin() as session:
            run = self._run(session, lease.run_id, for_update=True)
            if run.pause_requested or run.cancel_requested:
                self._settle_control(session, run)
                return False
            if run.status not in {"running", "blocked"}:
                return False
            tool = self._tool_current(session, run, lease, status="created")
            remaining = self._quality_tool_remaining(run, tool)
            if remaining is not None and remaining < 1:
                self._expire_quality_tool(session, run, tool, lease.owner)
                return False
            if tool.qa_cycle_id is not None and session.get(
                QualityCycle, tool.qa_cycle_id
            ).status in {"blocked", "cancelled"}:
                tool.status, tool.finished_at = "cancelled", self.clock()
                tool.error_code, tool.error_message = (
                    "quality_blocked_before_dispatch",
                    "Цикл QA заблокирован до dispatch проверки.",
                )
                tool.fencing_token += 1
                tool.lease_owner, tool.lease_expires_at = None, None
                self._quality_tool_finished(session, run, tool)
                self._emit_workflow(session, run, "tool.cancelled", actor_id=lease.owner)
                return False
            tool.status, tool.started_at = "running", self.clock()
            if hasattr(self, "_quality_tool_started"):
                self._quality_tool_started(session, run, tool)
            self._emit_workflow(session, run, "tool.started", actor_id=lease.owner)
            return True

    def heartbeat_tool(self, lease):
        with self.database.sessions.begin() as session:
            run = self._run(session, lease.run_id, for_update=True)
            tool = self._tool_current(session, run, lease)
            self._register(session, lease.owner)
            tool.lease_expires_at = self.clock() + timedelta(seconds=self.lease_seconds)
            self._emit_workflow(session, run, "tool.renewed", actor_id=lease.owner)

    def tool_should_stop(self, lease):
        with self.database.read() as session:
            run = self._run(session, lease.run_id)
            tool = self._tool_current(session, run, lease)
            cycle_blocked = tool.qa_cycle_id is not None and session.get(
                QualityCycle, tool.qa_cycle_id
            ).status in {"blocked", "cancelled"}
            remaining = self._quality_tool_remaining(run, tool)
            return bool(
                run.pause_requested
                or run.cancel_requested
                or tool.status != "running"
                or cycle_blocked
                or remaining is not None
                and remaining <= 0
            )

    def finish_tool(self, lease, result):
        with self.database.sessions.begin() as session:
            run = self._run(session, lease.run_id, for_update=True)
            tool = self._tool_current(session, run, lease)
            try:
                contents, manifest = self._tool_contents(
                    session, run, candidate_view(session, run.id)
                )
                if contents != lease.contents or manifest != lease.manifest_content:
                    raise InvalidFile("Immutable содержимое кандидата изменилось после claim.")
            except InvalidFile as failure:
                raise DomainError(
                    "stale_tool", "Immutable содержимое проверки больше не актуально."
                ) from failure
            if result.status not in {"succeeded", "failed", "timed_out", "cancelled"}:
                raise ValueError("A Runner result must have a known terminal status")
            tool.status, tool.finished_at = result.status, self.clock()
            tool.commands = [list(command) for command in result.commands]
            secrets = getattr(self, "secrets", ())
            tool.stdout, tool.stderr = (
                redact(result.stdout, secrets),
                redact(result.stderr, secrets),
            )
            tool.exit_code, tool.process_id = result.exit_code, result.process_id
            tool.error_code = result.error_code
            tool.error_message = (
                redact(result.error_message, secrets) if result.error_message else None
            )
            tool.report = (
                json.loads(redact(json.dumps(result.report, ensure_ascii=False), secrets))
                if result.report is not None
                else None
            )
            tool.lease_owner, tool.lease_expires_at = None, None
            remaining = self._quality_tool_remaining(run, tool)
            if remaining is not None and remaining <= 0 and not run.cancel_requested:
                self._expire_quality_tool(session, run, tool, lease.owner)
            if hasattr(self, "_quality_tool_finished"):
                self._quality_tool_finished(session, run, tool)
            self._settle_control(session, run)
            action = f"tool.{tool.status}"
            if self._finish_ready_run(session, run, self._delivery(session, run.id)):
                action = "run.succeeded"
            self._emit_workflow(session, run, action, actor_id=lease.owner)
            return ToolRunView.model_validate(tool)

    def _recover_tools(self, session, run):
        recovered = 0
        for tool in self._tools(session, run.id):
            if tool.status not in {"created", "running"} or tool.lease_owner is None:
                continue
            if tool.lease_expires_at is not None and tool.lease_expires_at > self.clock():
                continue
            if tool.operation_id == "smoke_test":
                self._recover_runtime_smoke(session, run, tool)
                recovered += 1
                continue
            if tool.operation_id not in SUPPORTED_TOOLS:
                continue
            sent = tool.status == "running"
            tool.fencing_token += 1
            tool.lease_owner, tool.lease_expires_at = None, None
            tool.status = "uncertain" if sent else "cancelled"
            tool.finished_at = None if sent else self.clock()
            tool.error_code = (
                "lease_expired_after_dispatch" if sent else "lease_expired_before_dispatch"
            )
            tool.error_message = (
                "Исход проверки неизвестен после потери worker."
                if sent
                else "Проверка остановлена до запуска процесса."
            )
            if sent:
                self._tool_uncertain_decision(session, run, tool)
            if hasattr(self, "_quality_tool_finished"):
                self._quality_tool_finished(session, run, tool)
            self._settle_control(session, run)
            self._emit_workflow(session, run, "tool.uncertain" if sent else "tool.cancelled")
            recovered += 1
        return recovered

    def _tool_uncertain_decision(self, session, run, tool):
        from codehead.persistence.service import identifier

        run.status, run.blocked_reason = "blocked", tool.error_message
        session.add(
            Decision(
                id=identifier(),
                run_id=run.id,
                task_id=None,
                attempt_id=None,
                tool_run_id=tool.id,
                kind="tool_uncertain_outcome",
                status="open",
                version=1,
                blocking=True,
                title="Уточнить исход проверки Runner",
                summary=tool.error_message,
                choices=["confirm_failed"],
                artifact_ids=[],
                created_at=self.clock(),
            )
        )

    def abandon_tool(self, lease, *, process_id=None, commands=None):
        with self.database.sessions.begin() as session:
            run = self._run(session, lease.run_id, for_update=True)
            tool = self._tool_current(session, run, lease)
            tool.status, tool.error_code = "uncertain", "runner_unknown_outcome"
            if isinstance(process_id, int) and process_id > 0:
                tool.process_id = process_id
            if commands is not None:
                secrets = getattr(self, "secrets", ())
                tool.commands = [
                    [redact(argument, secrets) for argument in command] for command in commands
                ]
            tool.error_message = (
                "Runner прерван после dispatch; "
                "исход собственного дерева процессов требует проверки."
            )
            tool.fencing_token += 1
            tool.lease_owner, tool.lease_expires_at = None, None
            self._tool_uncertain_decision(session, run, tool)
            if hasattr(self, "_quality_tool_finished"):
                self._quality_tool_finished(session, run, tool)
            self._settle_control(session, run)
            self._emit_workflow(session, run, "tool.uncertain", actor_id=lease.owner)

    def _resolve_tool_decision(self, session, run, decision, command, correlation_id):
        tool = session.get(ToolRun, decision.tool_run_id) if decision.tool_run_id else None
        if (
            decision.kind != "tool_uncertain_outcome"
            or decision.task_id is not None
            or decision.attempt_id is not None
            or command.choice != "confirm_failed"
            or tool is None
            or tool.run_id != run.id
            or tool.status != "uncertain"
        ):
            raise DomainError("conflict", "Неизвестный исход проверки уже изменился.")
        decision.status, decision.choice = "resolved", command.choice
        decision.comment = redact(command.comment)
        decision.version += 1
        decision.resolved_at = self.clock()
        tool.status, tool.finished_at = "failed", self.clock()
        tool.error_code = "confirmed_failed"
        tool.error_message = "Пользователь подтвердил остановку или отказ: " + decision.comment
        run.status, run.blocked_reason = (
            "blocked",
            "Исход проверки уточнён. Можно отменить запуск и начать заново.",
        )
        self._settle_control(session, run)
        self._emit_workflow(
            session, run, "decision.resolved", actor_id="local_user", correlation_id=correlation_id
        )
        return RunView.model_validate(run)
