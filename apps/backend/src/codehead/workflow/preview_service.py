"""Fence internal Runner work and retain ownership of preview transitions."""

import math
from dataclasses import dataclass
from datetime import timedelta
from re import fullmatch

from sqlalchemy import or_, select

from codehead.contracts import DeliveryView, ToolRunView
from codehead.errors import DomainError
from codehead.llm.delivery_provider import smoke_passed
from codehead.llm.redaction import redact
from codehead.persistence.delivery import DELIVERY_VERSION, RUNTIME_TOOLS
from codehead.persistence.models import PreviewSession, Run, ToolRun, WorkerHeartbeat
from codehead.persistence.tools import PIN_FIELDS

_PREVIEW_TIMEOUT = "Срок подтверждённого владения процессами preview истёк."
_UNKNOWN_OUTCOME = "Исход операции preview неизвестен после потери worker."


@dataclass(frozen=True)
class RuntimeLease:
    owner: str
    tool: ToolRunView
    delivery: DeliveryView
    owner_boot: str

    @property
    def run_id(self):
        return self.tool.run_id


def _matches_run(lease, delivery, tool):
    return (
        tool.delivery_id == delivery.id
        and tool.run_id == delivery.run_id
        and tool.workspace_id == delivery.candidate_id
        and tool.snapshot_version == delivery.revision
        and all(
            getattr(tool, name) == getattr(delivery, name)
            for name in (*PIN_FIELDS, "manifest_artifact_id", "manifest_hash", "tree_hash")
        )
        and (
            lease is None
            or DeliveryView.model_validate(delivery) == lease.delivery
            and all(
                getattr(tool, name) == getattr(lease.tool, name)
                for name in (
                    "operation_id",
                    "preview_session_id",
                    "timeout_seconds",
                    "output_limit_bytes",
                )
            )
        )
    )


def valid_ready_result(result):
    match = fullmatch(r"http://127\.0\.0\.1:([1-9][0-9]{0,4})", result.origin or "")
    return (
        result.status == "ready"
        and result.error_code is None
        and match is not None
        and int(match[1]) <= 65535
        and type(result.backend_pid) is int
        and type(result.bridge_pid) is int
        and result.backend_pid > 0
        and result.bridge_pid > 0
        and result.backend_pid != result.bridge_pid
    )


def _runtime_status(operation, result, package_tree_hash):
    if result.error_code is None and (
        operation == "smoke_test"
        and result.status == "passed"
        and smoke_passed(result.report, package_tree_hash)
        or operation == "start_preview"
        and valid_ready_result(result)
        or operation == "stop_preview"
        and result.status == "stopped"
    ):
        return "succeeded"
    if operation != "stop_preview" and result.status in {"failed", "timed_out", "cancelled"}:
        return result.status
    return "uncertain"


class PreviewWorkflow:
    def _active_preview(self, session, tool):
        return (
            session.get(PreviewSession, tool.preview_session_id)
            if tool.preview_session_id
            else None
        )

    def _advance_preview(self, preview, status, *, code=None, message=None):
        preview.status = status
        preview.version += 1
        preview.fencing_token += 1
        preview.updated_at = self.clock()
        preview.error_code, preview.error_message = code, message
        if status != "ready":
            preview.origin = preview.health_checked_at = None
        if status in {"stopped", "failed", "uncertain"}:
            preview.finished_at = self.clock()
            preview.lease_expires_at = None

    def _finish_runtime_row(self, tool, status, *, code=None, message=None):
        tool.status, tool.finished_at = status, None if status == "uncertain" else self.clock()
        tool.fencing_token += 1
        tool.lease_owner = tool.lease_expires_at = None
        tool.error_code, tool.error_message = code, message

    def _eligible_preview_tool(self, session, owner, preview, tool):
        if tool.operation_id == "start_preview":
            return preview.status == "created" and preview.start_tool_run_id == tool.id
        if (
            preview.status != "stopping"
            or preview.stop_tool_run_id != tool.id
            or preview.worker_boot_id not in {None, owner}
        ):
            return False
        starter = session.get(ToolRun, preview.start_tool_run_id)
        return starter is not None and starter.status != "running"

    def claim_runtime_tool(self, owner):
        with self.database.sessions.begin() as session:
            runs = session.scalars(
                select(Run)
                .where(
                    Run.mode == "test",
                    Run.workflow_version == DELIVERY_VERSION,
                    or_(Run.status == "running", Run.status == "succeeded"),
                    select(ToolRun.id)
                    .where(
                        ToolRun.run_id == Run.id,
                        ToolRun.status == "created",
                        ToolRun.operation_id.in_(RUNTIME_TOOLS),
                    )
                    .exists(),
                )
                .order_by(Run.created_at)
                .with_for_update(of=Run, skip_locked=True)
            )
            for run in runs:
                delivery = self._delivery(session, run.id)
                if delivery is None:
                    continue
                for tool in self._tools(session, run.id):
                    if tool.status != "created" or tool.operation_id not in RUNTIME_TOOLS:
                        continue
                    if not _matches_run(None, delivery, tool):
                        continue
                    preview = self._active_preview(session, tool)
                    if tool.operation_id == "smoke_test":
                        if (
                            delivery.status != "smoking"
                            or delivery.smoke_tool_run_id != tool.id
                            or run.status != "running"
                            or run.pause_requested
                            or run.cancel_requested
                            or self._occupied_slots(session, run)
                            >= run.limits["max_parallel_tasks"]
                        ):
                            continue
                        remaining = math.floor(self._remaining_duration(run))
                        if remaining < 1:
                            self._finish_runtime_row(
                                tool, "cancelled", code="run_duration_exceeded"
                            )
                            self._delivery_smoke_finished(session, run, delivery, tool)
                            return None
                        tool.timeout_seconds = min(tool.timeout_seconds, remaining)
                    elif (
                        not self._ready_delivery(run, delivery)
                        or preview is None
                        or not self._package_matches(preview, delivery)
                        or not self._eligible_preview_tool(session, owner, preview, tool)
                    ):
                        continue
                    if preview is not None:
                        if tool.operation_id == "start_preview":
                            self._advance_preview(preview, "starting")
                        else:
                            starter = session.get(ToolRun, preview.start_tool_run_id)
                            if starter.status == "created":
                                self._finish_runtime_row(
                                    starter, "cancelled", code="stopped_before_dispatch"
                                )
                        preview.worker_boot_id = owner
                        preview.lease_expires_at = self.clock() + timedelta(
                            seconds=self.lease_seconds
                        )
                    tool.status, tool.started_at, tool.lease_owner = "running", self.clock(), owner
                    tool.fencing_token += 1
                    tool.lease_expires_at = self.clock() + timedelta(seconds=self.lease_seconds)
                    self._emit_workflow(session, run, "tool.started", actor_id=owner)
                    return RuntimeLease(
                        owner,
                        ToolRunView.model_validate(tool),
                        DeliveryView.model_validate(delivery),
                        owner,
                    )
        return None

    def _check_runtime_tool(self, session, run, lease):
        tool = session.get(ToolRun, lease.tool.id)
        delivery = self._delivery(session, run.id)
        if (
            tool is None
            or delivery is None
            or tool.status != "running"
            or tool.fencing_token != lease.tool.fencing_token
            or tool.lease_owner != lease.owner
            or tool.lease_expires_at <= self.clock()
            or not _matches_run(lease, delivery, tool)
        ):
            raise DomainError("stale_runtime_tool", "Lease операции preview больше не актуален.")
        preview = self._active_preview(session, tool)
        if tool.operation_id == "smoke_test":
            allowed = delivery.smoke_tool_run_id == tool.id and run.status in {
                "running",
                "pausing",
                "blocked",
            }
        else:
            allowed = (
                self._ready_delivery(run, delivery)
                and preview is not None
                and self._package_matches(preview, delivery)
                and preview.worker_boot_id == lease.owner_boot
                and preview.lease_expires_at is not None
                and preview.lease_expires_at > self.clock()
                and (
                    tool.operation_id == "start_preview"
                    and preview.start_tool_run_id == tool.id
                    and preview.status in {"starting", "stopping"}
                    or tool.operation_id == "stop_preview"
                    and preview.stop_tool_run_id == tool.id
                    and preview.status == "stopping"
                )
            )
        if not allowed:
            raise DomainError(
                "stale_runtime_tool", "Закреплённая сессия preview больше не актуальна."
            )
        return tool, delivery, preview

    def heartbeat_runtime_tool(self, lease):
        with self.database.sessions.begin() as session:
            run = self._run(session, lease.run_id, for_update=True)
            tool, _, preview = self._check_runtime_tool(session, run, lease)
            self._register(session, lease.owner)
            tool.lease_expires_at = self.clock() + timedelta(seconds=self.lease_seconds)
            if preview is not None:
                preview.lease_expires_at = tool.lease_expires_at
            self._emit_workflow(session, run, "tool.renewed", actor_id=lease.owner)

    def runtime_tool_should_stop(self, lease):
        with self.database.read() as session:
            run = self._run(session, lease.run_id)
            tool, _, preview = self._check_runtime_tool(session, run, lease)
            if tool.operation_id == "smoke_test":
                return (
                    run.pause_requested
                    or run.cancel_requested
                    or self._remaining_duration(run) <= 0
                )
            return tool.operation_id == "start_preview" and preview.status == "stopping"

    def runtime_stop_before_start(self, lease):
        with self.database.read() as session:
            run = self._run(session, lease.run_id)
            _, _, preview = self._check_runtime_tool(session, run, lease)
            start = session.get(ToolRun, preview.start_tool_run_id)
            return start.started_at is None or (
                start.status in {"cancelled", "failed", "timed_out"} and start.report is None
            )

    def finish_runtime_tool(self, lease, result):
        with self.database.sessions.begin() as session:
            run = self._run(session, lease.run_id, for_update=True)
            tool, delivery, preview = self._check_runtime_tool(session, run, lease)
            operation = tool.operation_id
            status = _runtime_status(operation, result, delivery.package_tree_hash)
            success = status == "succeeded"
            code = None if success else result.error_code or "runtime_operation_failed"
            message = (
                None
                if success
                else redact(
                    result.error_message or "Операция preview не подтвердила ожидаемый результат.",
                    self.secrets,
                )
            )
            self._finish_runtime_row(tool, status, code=code, message=message)
            tool.process_id = result.backend_pid
            tool.exit_code = 0 if success else None
            if operation == "smoke_test":
                tool.report = result.report if success else None
                self._delivery_smoke_finished(session, run, delivery, tool)
                self._settle_control(session, run)
            elif operation == "start_preview" and preview.status == "stopping":
                if success:
                    tool.report = {"started": True}
                elif status == "uncertain":
                    tool.report = {"started": None}
            elif operation == "start_preview" and success:
                self._advance_preview(preview, "ready")
                preview.origin = result.origin
                preview.backend_pid, preview.bridge_pid = result.backend_pid, result.bridge_pid
                preview.ready_at = preview.health_checked_at = self.clock()
                preview.lease_expires_at = self.clock() + timedelta(seconds=self.lease_seconds)
                self._register(session, lease.owner)
            else:
                terminal = (
                    "stopped" if success else "uncertain" if status == "uncertain" else "failed"
                )
                self._advance_preview(preview, terminal, code=code, message=message)
            self._emit_workflow(session, run, f"tool.{status}", actor_id=lease.owner)

    def _recover_runtime_smoke(self, session, run, tool):
        delivery = self._delivery(session, run.id)
        self._finish_runtime_row(
            tool,
            "uncertain",
            code="lease_expired_after_dispatch",
            message="Исход smoke-проверки неизвестен после потери worker.",
        )
        self._delivery_smoke_finished(session, run, delivery, tool)
        self._settle_control(session, run)
        self._emit_workflow(session, run, "tool.uncertain")

    def recover_previews(self, *, disconnected_owner=None):
        recovered = 0
        with self.database.sessions.begin() as session:
            runs = list(
                session.scalars(
                    select(Run)
                    .join(PreviewSession, PreviewSession.run_id == Run.id)
                    .where(PreviewSession.status.in_(("starting", "ready", "stopping")))
                    .order_by(PreviewSession.created_at)
                    .with_for_update(of=Run, skip_locked=disconnected_owner is None)
                )
            )
            for run in runs:
                for preview in self._previews(session, run.id):
                    if (
                        preview.status not in {"starting", "ready", "stopping"}
                        or preview.worker_boot_id is None
                        or disconnected_owner is not None
                        and preview.worker_boot_id != disconnected_owner
                    ):
                        continue
                    owner = session.get(WorkerHeartbeat, preview.worker_boot_id)
                    if (
                        disconnected_owner is None
                        and owner is not None
                        and owner.expires_at > self.clock()
                        and preview.lease_expires_at is not None
                        and preview.lease_expires_at > self.clock()
                    ):
                        continue
                    for tool_id in (preview.start_tool_run_id, preview.stop_tool_run_id):
                        tool = session.get(ToolRun, tool_id) if tool_id else None
                        if tool is None or tool.status not in {"running", "created"}:
                            continue
                        self._finish_runtime_row(
                            tool,
                            "uncertain" if tool.status == "running" else "cancelled",
                            code="preview_lease_expired",
                            message=_UNKNOWN_OUTCOME,
                        )
                    self._advance_preview(
                        preview, "uncertain", code="preview_lease_expired", message=_PREVIEW_TIMEOUT
                    )
                    self._emit_workflow(session, run, "preview.uncertain")
                    recovered += 1
        return recovered

    def preview_probe_targets(self, owner, *, shutdown=False):
        with self.database.read() as session:
            query = select(PreviewSession).where(
                PreviewSession.worker_boot_id == owner,
                PreviewSession.status.in_(
                    ("ready", "stopping", "uncertain") if shutdown else ("ready", "uncertain")
                ),
            )
            return list(session.scalars(query))

    def record_preview_probe(self, target, result):
        with self.database.sessions.begin() as session:
            run = self._run(session, target.run_id, for_update=True)
            preview = session.get(PreviewSession, target.id)
            if (
                preview is None
                or preview.version != target.version
                or preview.fencing_token != target.fencing_token
                or preview.worker_boot_id != target.worker_boot_id
            ):
                return False
            if result.status == "ready" and (
                preview.status == "ready"
                and valid_ready_result(result)
                and preview.origin == result.origin
                and preview.backend_pid == result.backend_pid
                and preview.bridge_pid == result.bridge_pid
                and preview.lease_expires_at > self.clock()
            ):
                preview.health_checked_at = self.clock()
                preview.lease_expires_at = self.clock() + timedelta(seconds=self.lease_seconds)
                return False
            status = (
                "stopped"
                if result.status == "stopped"
                else "failed"
                if result.status == "failed"
                else "uncertain"
            )
            if preview.status == "uncertain" and status == "uncertain":
                return False
            if status == "stopped" and preview.stop_tool_run_id:
                tool = session.get(ToolRun, preview.stop_tool_run_id)
                if tool.status in {"created", "uncertain"}:
                    if tool.status == "uncertain":
                        self._finish_runtime_row(tool, "succeeded")
                        tool.exit_code = 0
                    else:
                        self._finish_runtime_row(tool, "cancelled", code="worker_shutdown")
            self._advance_preview(
                preview,
                status,
                code=result.error_code,
                message=redact(result.error_message, self.secrets)
                if result.error_message
                else None,
            )
            self._emit_workflow(session, run, f"preview.{status}", actor_id=target.worker_boot_id)
            return True
