"""Seal the QA-approved candidate, then use the exact passing smoke evidence."""

import json
from dataclasses import dataclass
from datetime import timedelta

from sqlalchemy import select

from codehead.clinic.files import InvalidFile, text_hash
from codehead.contracts import DeliveryView, QualityPins
from codehead.delivery.package import PackageRequest, document_hash
from codehead.errors import DomainError
from codehead.llm.delivery_provider import smoke_passed
from codehead.llm.provider import ProviderFailure
from codehead.llm.quality_provider import evidence_status
from codehead.persistence.candidates import candidate_view
from codehead.persistence.delivery import DELIVERY_VERSION, PACKAGE_FIELDS
from codehead.persistence.models import Artifact, Delivery, QualityCycle, Run, Task, ToolRun
from codehead.persistence.service import identifier
from codehead.persistence.tools import PIN_FIELDS

DELIVERY_BUDGET_REASON = "Исчерпан лимит времени при подготовке доставки."
DELIVERY_INPUT_ERROR = "Изменились или недоступны подтверждённые источники доставки."


@dataclass(frozen=True)
class DeliveryLease:
    run_id: str
    owner: str
    fencing_token: int
    request: PackageRequest


def _input(artifact):
    return {
        "id": artifact.id,
        "version": artifact.version,
        "artifact_type": artifact.artifact_type,
        "content": artifact.content_text,
        "content_hash": artifact.content_hash,
        "relative_path": artifact.relative_path,
    }


class DeliveryWorkflow:
    @staticmethod
    def _delivery_artifact(session, run, artifact_id, kind, *, producer_id=None, origin=None):
        artifact = session.get(Artifact, artifact_id) if artifact_id else None
        if (
            artifact is None
            or artifact.run_id != run.id
            or artifact.artifact_type != kind
            or artifact.content_text is None
            or text_hash(artifact.content_text) != artifact.content_hash
            or len(artifact.content_text.encode("utf-8")) != artifact.byte_size
            or producer_id is not None
            and artifact.provenance.get("producer_id") != producer_id
            or origin is not None
            and artifact.provenance.get("origin") != origin
        ):
            raise ProviderFailure("invalid_delivery_evidence", DELIVERY_INPUT_ERROR)
        return artifact

    def _delivery_build_evidence(self, session, run, cycle):
        qa_task = session.get(Task, cycle.task_id)
        if (
            cycle.status != "passed"
            or cycle.run_id != run.id
            or qa_task is None
            or qa_task.role != "qa"
            or qa_task.run_id != run.id
            or qa_task.status != "succeeded"
        ):
            raise ProviderFailure("invalid_delivery_evidence", DELIVERY_INPUT_ERROR)
        evidence = self._quality_context(session, run, qa_task)
        if evidence_status(evidence) != "passed":
            raise ProviderFailure("invalid_delivery_evidence", DELIVERY_INPUT_ERROR)
        build = next(item for item in evidence["tools"] if item["operation_id"] == "build_frontend")
        tool = session.get(ToolRun, build["id"])
        report = self._delivery_artifact(
            session,
            run,
            build["tool_report_artifact_id"],
            "tool_report",
            producer_id=tool.id,
            origin="tool",
        )
        try:
            digest = document_hash(tool.report)
            if (
                not isinstance(tool.report, dict)
                or tool.report.get("status") != "passed"
                or json.loads(report.content_text).get("build_report_hash") != digest
            ):
                raise ValueError
        except (TypeError, ValueError) as failure:
            raise ProviderFailure("invalid_delivery_evidence", DELIVERY_INPUT_ERROR) from failure
        return tool, report, digest

    def _prepare_delivery(self, session, run, cycle, qa_report):
        task = next(item for item in self._tasks(session, run.id) if item.role == "devops")
        try:
            if task.status != "queued" or task.dependencies != [cycle.task_id]:
                raise ProviderFailure("invalid_delivery_evidence", DELIVERY_INPUT_ERROR)
            build, _, digest = self._delivery_build_evidence(session, run, cycle)
        except (InvalidFile, ProviderFailure) as failure:
            self._block(session, run, [task], str(failure), "delivery.blocked")
            return
        delivery = Delivery(
            id=identifier(),
            **{
                name: getattr(cycle, name) for name in QualityPins.model_fields if name != "task_id"
            },
            task_id=task.id,
            status="created",
            qa_cycle_id=cycle.id,
            qa_report_artifact_id=qa_report.id,
            qa_report_hash=qa_report.content_hash,
            build_tool_run_id=build.id,
            build_report_hash=digest,
            created_at=self.clock(),
            updated_at=self.clock(),
        )
        session.add(delivery)
        self._emit_workflow(session, run, "delivery.created", task_id=task.id)

    def _delivery_inputs(self, session, run, delivery):
        cycle = session.get(QualityCycle, delivery.qa_cycle_id)
        task = session.get(Task, delivery.task_id)
        if (
            cycle is None
            or task is None
            or task.run_id != run.id
            or task.dependencies != [cycle.task_id]
            or cycle.report_artifact_id != delivery.qa_report_artifact_id
            or any(
                getattr(cycle, name) != getattr(delivery, name)
                for name in QualityPins.model_fields
                if name != "task_id"
            )
        ):
            raise ProviderFailure("invalid_delivery_evidence", DELIVERY_INPUT_ERROR)
        build, report, digest = self._delivery_build_evidence(session, run, cycle)
        qa_report = self._delivery_artifact(
            session, run, delivery.qa_report_artifact_id, "test_report", origin="test"
        )
        manifest = self._delivery_artifact(
            session, run, delivery.manifest_artifact_id, "candidate_manifest"
        )
        if (
            qa_report.task_id != cycle.task_id
            or qa_report.content_hash != delivery.qa_report_hash
            or build.id != delivery.build_tool_run_id
            or digest != delivery.build_report_hash
            or manifest.content_hash != delivery.manifest_hash
        ):
            raise ProviderFailure("invalid_delivery_evidence", DELIVERY_INPUT_ERROR)
        return build, report, qa_report, manifest

    def _package_request(self, session, run, delivery):
        build, _, _, _ = self._delivery_inputs(session, run, delivery)
        candidate = candidate_view(session, run.id)
        contents, manifest = self._tool_contents(session, run, candidate)
        return PackageRequest(
            delivery.id,
            delivery.package_generation,
            candidate,
            contents,
            manifest,
            build.id,
            build.report,
        )

    def claim_delivery(self, owner):
        with self.database.sessions.begin() as session:
            run = session.scalar(
                select(Run)
                .join(Delivery, Delivery.run_id == Run.id)
                .where(
                    Run.mode == "test",
                    Run.workflow_version == DELIVERY_VERSION,
                    Run.status == "running",
                    Run.pause_requested.is_(False),
                    Run.cancel_requested.is_(False),
                    Delivery.status == "created",
                )
                .order_by(Delivery.created_at)
                .with_for_update(of=Run, skip_locked=True)
            )
            if (
                run is None
                or self._occupied_slots(session, run) >= run.limits["max_parallel_tasks"]
            ):
                return None
            delivery = self._delivery(session, run.id)
            if self._remaining_duration(run) <= 0:
                self._delivery_block(
                    session, run, delivery, DELIVERY_BUDGET_REASON, "budget.exceeded"
                )
                return None
            delivery.package_generation += 1
            try:
                request = self._package_request(session, run, delivery)
            except (InvalidFile, ProviderFailure) as failure:
                self._delivery_block(session, run, delivery, str(failure), "delivery.blocked")
                return None
            delivery.status = "publishing"
            delivery.publication_owner = owner
            delivery.publication_fence += 1
            delivery.updated_at = self.clock()
            delivery.publication_expires_at = self.clock() + timedelta(seconds=self.lease_seconds)
            self._emit_workflow(session, run, "delivery.publishing", actor_id=owner)
            return DeliveryLease(run.id, owner, delivery.publication_fence, request)

    def _check_delivery(self, session, lease):
        run = self._run(session, lease.run_id, for_update=True)
        delivery = self._delivery(session, run.id)
        if (
            delivery is None
            or delivery.id != lease.request.package_id
            or delivery.status != "publishing"
            or delivery.publication_owner != lease.owner
            or delivery.publication_fence != lease.fencing_token
            or delivery.package_generation != lease.request.generation
            or delivery.publication_expires_at <= self.clock()
            or run.mode != "test"
            or run.workflow_version != DELIVERY_VERSION
            or run.status not in {"running", "pausing", "blocked"}
        ):
            raise DomainError("stale_delivery", "Версия или lease публикации больше не актуальны.")
        return run, delivery

    def heartbeat_delivery(self, lease):
        with self.database.sessions.begin() as session:
            _, delivery = self._check_delivery(session, lease)
            self._register(session, lease.owner)
            delivery.publication_expires_at = self.clock() + timedelta(seconds=self.lease_seconds)

    def finish_delivery(self, lease, package):
        with self.database.sessions.begin() as session:
            run, delivery = self._check_delivery(session, lease)
            if self._release_delivery_control(session, run, delivery):
                return
            if self._remaining_duration(run) <= 0:
                self._delivery_block(
                    session, run, delivery, DELIVERY_BUDGET_REASON, "budget.exceeded"
                )
                return
            try:
                current = self._package_request(session, run, delivery)
                if (
                    current != lease.request
                    or package.package_id != delivery.id
                    or package.generation != delivery.package_generation
                    or package.run_id != delivery.run_id
                    or package.candidate_id != delivery.candidate_id
                    or package.revision != delivery.revision
                    or any(getattr(package, name) != getattr(delivery, name) for name in PIN_FIELDS)
                ):
                    raise InvalidFile(DELIVERY_INPUT_ERROR)
            except (InvalidFile, ProviderFailure) as failure:
                self._delivery_block(session, run, delivery, str(failure), "delivery.blocked")
                return
            for name in PACKAGE_FIELDS:
                setattr(delivery, f"package_{name}", getattr(package, name))
            tool = self._new_delivery_tool(session, delivery, "smoke_test")
            delivery.status, delivery.smoke_tool_run_id = "smoking", tool.id
            delivery.updated_at = self.clock()
            delivery.publication_owner = delivery.publication_expires_at = None
            self._emit_workflow(session, run, "delivery.smoke_queued", actor_id=lease.owner)

    def fail_delivery(self, lease):
        with self.database.sessions.begin() as session:
            run, delivery = self._check_delivery(session, lease)
            if self._release_delivery_control(session, run, delivery):
                return
            self._delivery_block(
                session,
                run,
                delivery,
                "Публикация закреплённого пакета прервана.",
                "delivery.failed",
                status="failed",
            )

    def _release_delivery_control(self, session, run, delivery):
        if not (run.pause_requested or run.cancel_requested):
            return False
        delivery.status, delivery.updated_at = "created", self.clock()
        delivery.publication_owner = delivery.publication_expires_at = None
        delivery.publication_fence += 1
        self._settle_control(session, run)
        self._emit_workflow(session, run, "delivery.released")
        return True

    def _recover_delivery(self, session, run):
        delivery = self._delivery(session, run.id)
        if (
            delivery is None
            or delivery.status != "publishing"
            or delivery.publication_expires_at > self.clock()
        ):
            return False
        delivery.status, delivery.updated_at = "created", self.clock()
        delivery.publication_owner = delivery.publication_expires_at = None
        delivery.publication_fence += 1
        self._settle_control(session, run)
        self._emit_workflow(session, run, "delivery.recovered")
        return True

    def _mark_delivery_terminal(self, delivery, status, reason):
        delivery.status, delivery.blocked_reason = status, reason
        delivery.finished_at = delivery.updated_at = self.clock()
        delivery.publication_owner = delivery.publication_expires_at = None

    def _delivery_block(self, session, run, delivery, reason, action, *, status="blocked"):
        self._mark_delivery_terminal(delivery, status, reason)
        self._block(session, run, [session.get(Task, delivery.task_id)], reason, action)

    def _delivery_smoke_finished(self, session, run, delivery, tool):
        if (
            tool.status == "cancelled"
            and run.pause_requested
            and not run.cancel_requested
            and self._remaining_duration(run) > 0
        ):
            replacement = self._new_delivery_tool(session, delivery, "smoke_test")
            delivery.smoke_tool_run_id = replacement.id
            delivery.updated_at = self.clock()
            return
        report = self._quality_artifact(
            session,
            run,
            "smoke_report",
            {
                "tool_run_id": tool.id,
                "package_id": delivery.id,
                "package_generation": delivery.package_generation,
                "status": tool.status,
                "error_code": tool.error_code,
                "error_message": tool.error_message,
                "report": tool.report,
                **{name: getattr(delivery, name) for name in QualityPins.model_fields},
            },
            task_id=delivery.task_id,
            author_role=None,
            producer_id=tool.id,
            origin="tool",
            input_versions={delivery.manifest_artifact_id: delivery.revision},
        )
        delivery.smoke_report_artifact_id, delivery.updated_at = report.id, self.clock()
        if tool.status == "uncertain":
            self._tool_uncertain_decision(session, run, tool)
            status = "blocked"
        elif run.cancel_requested:
            self._mark_delivery_terminal(delivery, "cancelled", None)
            return
        elif self._remaining_duration(run) <= 0:
            self._delivery_block(session, run, delivery, DELIVERY_BUDGET_REASON, "budget.exceeded")
            return
        elif tool.status == "succeeded":
            delivery.status = "analyzing"
            return
        else:
            status = "failed"
        self._delivery_block(
            session,
            run,
            delivery,
            tool.error_message or "Smoke-проверка доставки прервана.",
            f"delivery.{status}",
            status=status,
        )

    def _delivery_context(self, session, run, task):
        delivery = self._delivery(session, run.id)
        if delivery is None or delivery.task_id != task.id or delivery.status != "analyzing":
            raise ProviderFailure("invalid_delivery_evidence", DELIVERY_INPUT_ERROR)
        build, build_report, qa_report, manifest = self._delivery_inputs(session, run, delivery)
        tool = session.get(ToolRun, delivery.smoke_tool_run_id)
        smoke = self._delivery_artifact(
            session,
            run,
            delivery.smoke_report_artifact_id,
            "smoke_report",
            producer_id=delivery.smoke_tool_run_id,
            origin="tool",
        )
        if (
            tool is None
            or tool.run_id != run.id
            or tool.delivery_id != delivery.id
            or tool.operation_id != "smoke_test"
            or tool.status != "succeeded"
            or tool.exit_code != 0
            or not self._candidate_pins(run, candidate_view(session, run.id), tool)
            or not smoke_passed(tool.report, delivery.package_tree_hash)
            or json.loads(smoke.content_text)["report"] != tool.report
        ):
            raise ProviderFailure("invalid_delivery_evidence", DELIVERY_INPUT_ERROR)
        context = {
            "package": {
                **{name: getattr(delivery, name) for name in QualityPins.model_fields},
                **{
                    f"package_{name}": getattr(delivery, f"package_{name}")
                    for name in PACKAGE_FIELDS
                },
                "package_id": delivery.id,
                "package_generation": delivery.package_generation,
                "qa_cycle_id": delivery.qa_cycle_id,
                "qa_report_artifact_id": qa_report.id,
                "qa_report_hash": delivery.qa_report_hash,
                "build_tool_run_id": build.id,
                "build_report_artifact_id": build_report.id,
                "build_report_hash": delivery.build_report_hash,
                "smoke_tool_run_id": tool.id,
                "smoke_report_artifact_id": smoke.id,
                "smoke_report_hash": smoke.content_hash,
            },
            "build_report": build.report,
        }
        return context, tuple(
            _input(artifact) for artifact in (manifest, qa_report, build_report, smoke)
        )

    def _verify_devops_package(self, run_id):
        with self.database.read() as session:
            delivery = self._delivery(session, run_id)
            if delivery is None or delivery.status != "analyzing":
                raise InvalidFile(DELIVERY_INPUT_ERROR)
            pinned = DeliveryView.model_validate(delivery)
        self._load_delivery_package(pinned)

    def _delivery_completed(self, session, run, task, artifact_ids):
        delivery = self._delivery(session, run.id)
        artifacts = {session.get(Artifact, key).artifact_type: key for key in artifact_ids}
        delivery.deployment_package_artifact_id = artifacts["deployment_package"]
        delivery.runbook_artifact_id = artifacts["runbook"]
        self._mark_delivery_terminal(delivery, "ready", None)
        if self._finish_ready_run(session, run, delivery):
            return "run.succeeded"
        return "delivery.ready"

    def _finish_ready_run(self, session, run, delivery):
        if (
            delivery is None
            or delivery.status != "ready"
            or run.status != "running"
            or run.pause_requested
            or run.cancel_requested
            or any(task.status != "succeeded" for task in self._tasks(session, run.id))
            or any(attempt.status == "uncertain" for attempt in self._attempts(session, run.id))
            or any(
                tool.status in {"created", "running", "uncertain"}
                for tool in self._tools(session, run.id)
            )
            or any(
                decision.blocking and decision.status == "open"
                for decision in self._decisions(session, run.id)
            )
        ):
            return False
        if self._remaining_duration(run) <= 0:
            reason = DELIVERY_BUDGET_REASON
            self._mark_delivery_terminal(delivery, "blocked", reason)
            run.status, run.blocked_reason = "blocked", reason
            self._emit_workflow(session, run, "budget.exceeded")
            return False
        run.status, run.finished_at, run.blocked_reason = "succeeded", self.clock(), None
        for agent in self._agents(session, run.id):
            if agent.role == "devops":
                agent.location = "production"
        return True
