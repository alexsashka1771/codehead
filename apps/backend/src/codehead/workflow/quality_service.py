"""QA checkpoints and repair scheduling inside the caller's locked Run transaction."""

import json

from sqlalchemy import select

from codehead.clinic.files import InvalidFile, text_hash, tree_hash
from codehead.contracts import Bug, QualityPins
from codehead.llm.provider import ProviderFailure
from codehead.llm.quality_provider import evidence_status, validate_output
from codehead.persistence.candidates import candidate_view
from codehead.persistence.models import Agent, Artifact, QualityCycle, Task, ToolRun
from codehead.persistence.service import identifier
from codehead.persistence.tools import PIN_FIELDS, SUPPORTED_TOOLS

QUALITY_BOUNDARY = "Следующий этап Clinic Demo ещё не подключён: DevOps и preview. QA пройден."


class QualityTransactions:
    @staticmethod
    def _cycle(session, task_id):
        return session.scalar(select(QualityCycle).where(QualityCycle.task_id == task_id))

    def _quality_artifact(
        self,
        session,
        run,
        kind,
        document,
        *,
        task_id=None,
        producer_id=None,
        origin="test",
        input_versions=None,
    ):
        content = json.dumps(document, ensure_ascii=False, sort_keys=True, indent=2) + "\n"
        artifact = Artifact(
            id=identifier(),
            run_id=run.id,
            task_id=task_id,
            artifact_type=kind,
            version=1,
            content_hash=text_hash(content),
            relative_path="",
            author_role="qa" if task_id else None,
            input_versions=dict(input_versions or {}),
            created_at=self.clock(),
            provenance={"origin": origin, "producer_id": producer_id, "parent_artifact_id": None},
            media_type="application/json",
            byte_size=len(content.encode("utf-8")),
            content_text=content,
        )
        artifact.relative_path = f"runs/{run.id}/artifacts/{artifact.id}.json"
        session.add(artifact)
        return artifact

    def _quality_ready(self, session, run, candidate):
        if run.test_scenario != "standard" and not run.injection_done:
            from codehead.clinic.quality_fixtures import storage_fixture

            fixture = storage_fixture()
            before, after = self.candidates.inject_test_file(session, run, fixture)
            run.injection_done = True
            self._quality_artifact(
                session,
                run,
                "test_injection",
                {
                    "run_id": run.id,
                    "candidate_id": candidate.id,
                    "test_scenario": run.test_scenario,
                    "before": before,
                    "after": after,
                    "fixture_id": fixture.fixture_id,
                    "fixture_version": fixture.version,
                    "fixture_hash": fixture.content_hash,
                    "relative_path": fixture.relative_path,
                    **{name: getattr(candidate, name) for name in PIN_FIELDS},
                },
                input_versions={before["manifest_artifact_id"]: before["revision"]},
            )
            self._emit_workflow(session, run, "candidate.test_injected")
            return
        succeeded = {task.id for task in self._tasks(session, run.id) if task.status == "succeeded"}
        task = next(
            (
                task
                for task in self._tasks(session, run.id)
                if task.role == "qa"
                and task.status == "queued"
                and all(dependency in succeeded for dependency in task.dependencies)
            ),
            None,
        )
        if task is None:
            return
        if self._cycle(session, task.id) is not None:
            return
        view = candidate_view(session, run.id)
        if not self._candidate_pins(run, view):
            raise InvalidFile("QA требует готовый закреплённый кандидат.")
        cycle = QualityCycle(
            id=identifier(),
            run_id=run.id,
            task_id=task.id,
            candidate_id=candidate.id,
            iteration=task.iteration,
            revision=candidate.revision,
            tree_hash=candidate.tree_hash,
            manifest_artifact_id=candidate.manifest_artifact_id,
            manifest_hash=view.manifest_hash,
            **{name: getattr(candidate, name) for name in PIN_FIELDS},
            status="created",
            tool_run_ids=[],
            tool_report_artifact_ids=[],
            bug_artifact_ids=[],
            created_at=self.clock(),
        )
        session.add(cycle)
        session.flush()
        tools = []
        for operation in SUPPORTED_TOOLS:
            tool = ToolRun(
                id=identifier(),
                run_id=run.id,
                qa_cycle_id=cycle.id,
                operation_id=operation,
                workspace_id=candidate.id,
                snapshot_version=candidate.revision,
                required_isolation="process_only",
                status="created",
                created_at=self.clock(),
                tree_hash=candidate.tree_hash,
                manifest_artifact_id=candidate.manifest_artifact_id,
                manifest_hash=view.manifest_hash,
                **{name: getattr(candidate, name) for name in PIN_FIELDS},
                timeout_seconds=180,
                output_limit_bytes=262144,
            )
            session.add(tool)
            tools.append(tool.id)
        cycle.tool_run_ids = tools
        self._emit_workflow(session, run, "quality.created", task_id=task.id)

    def _quality_tool_started(self, session, run, tool):
        if tool.qa_cycle_id is None:
            return
        cycle = session.get(QualityCycle, tool.qa_cycle_id)
        task = session.get(Task, cycle.task_id)
        if task.status == "queued":
            task.status = "running"
            task.record_version += 1
        cycle.status = "testing"
        agent = session.scalar(select(Agent).where(Agent.run_id == run.id, Agent.role == "qa"))
        agent.lifecycle, agent.activity, agent.location, agent.current_task_id = (
            "busy",
            "testing",
            "qa",
            task.id,
        )

    def _quality_tool_finished(self, session, run, tool):
        if tool.qa_cycle_id is None:
            return
        cycle = session.get(QualityCycle, tool.qa_cycle_id)
        existing = [
            session.get(Artifact, artifact_id) for artifact_id in cycle.tool_report_artifact_ids
        ]
        if not any(
            artifact and artifact.provenance.get("producer_id") == tool.id for artifact in existing
        ):
            excerpt = (
                (tool.stderr + "\n" + tool.stdout)
                .encode("utf-8")[:8192]
                .decode("utf-8", errors="ignore")
            )
            artifact = self._quality_artifact(
                session,
                run,
                "tool_report",
                {
                    "tool_run_id": tool.id,
                    "cycle_id": cycle.id,
                    "operation_id": tool.operation_id,
                    "status": tool.status,
                    "exit_code": tool.exit_code,
                    "error_code": tool.error_code,
                    "error_message": tool.error_message,
                    "diagnostic_excerpt": excerpt,
                    "full_output_url": f"/api/runs/{run.id}/tools",
                    **{name: getattr(cycle, name) for name in QualityPins.model_fields},
                },
                task_id=cycle.task_id,
                producer_id=tool.id,
                origin="tool",
                input_versions={cycle.manifest_artifact_id: cycle.revision},
            )
            cycle.tool_report_artifact_ids = [*cycle.tool_report_artifact_ids, artifact.id]
        tools = [session.get(ToolRun, tool_id) for tool_id in cycle.tool_run_ids]
        if cycle.status in {"blocked", "cancelled"}:
            return
        agent = session.scalar(select(Agent).where(Agent.run_id == run.id, Agent.role == "qa"))
        if not any(item.status == "running" for item in tools):
            agent.lifecycle, agent.activity = "idle", "waiting"
        if (
            tool.status not in {"succeeded", "failed"}
            or tool.status == "failed"
            and tool.error_code != "tool_failed"
        ):
            if run.cancel_requested:
                cycle.status, cycle.finished_at = "cancelled", self.clock()
            else:
                self._quality_block(
                    session,
                    run,
                    cycle,
                    tool.error_message or "Проверка имеет технический или неизвестный исход.",
                )
            return
        if any(item.status in {"created", "running"} for item in tools):
            return
        if run.cancel_requested:
            cycle.status, cycle.finished_at = "cancelled", self.clock()
            return
        try:
            evidence_status(self._quality_context(session, run, session.get(Task, cycle.task_id)))
        except (ProviderFailure, InvalidFile) as failure:
            self._quality_block(session, run, cycle, str(failure))
        else:
            cycle.status = "analyzing"
            agent = session.scalar(select(Agent).where(Agent.run_id == run.id, Agent.role == "qa"))
            agent.lifecycle, agent.activity = "idle", "waiting"

    def _quality_block(self, session, run, cycle, reason):
        cycle.status, cycle.blocked_reason, cycle.finished_at = "blocked", reason, self.clock()
        task = session.get(Task, cycle.task_id)
        if task.status not in {"succeeded", "failed", "cancelled"}:
            task.status, task.blocked_reason = "blocked", reason
            task.record_version += 1
        run.status, run.blocked_reason = "blocked", reason
        agent = session.scalar(select(Agent).where(Agent.run_id == run.id, Agent.role == "qa"))
        agent.lifecycle, agent.activity, agent.current_task_id = "blocked", "waiting", task.id

    def _quality_context(self, session, run, task):
        cycle = self._cycle(session, task.id)
        if cycle is None or cycle.run_id != run.id or cycle.iteration != task.iteration:
            raise ProviderFailure(
                "invalid_quality_evidence", "Цикл QA отсутствует или принадлежит другой задаче."
            )
        view = candidate_view(session, run.id)
        pins = {name: getattr(cycle, name) for name in QualityPins.model_fields}
        current = {
            "run_id": run.id,
            "task_id": task.id,
            "candidate_id": view.id,
            "revision": view.revision,
            "tree_hash": view.tree_hash,
            "manifest_artifact_id": view.manifest_artifact_id,
            "manifest_hash": view.manifest_hash,
            **{name: getattr(view, name) for name in PIN_FIELDS},
        }
        if pins != current or not self._candidate_pins(run, view):
            raise ProviderFailure(
                "invalid_quality_evidence", "QA ссылается на устаревший кандидат."
            )
        self._tool_contents(session, run, view)
        tools = []
        summaries = {}
        for artifact_id in cycle.tool_report_artifact_ids:
            artifact = session.get(Artifact, artifact_id)
            if (
                artifact is None
                or artifact.run_id != run.id
                or artifact.task_id != task.id
                or artifact.artifact_type != "tool_report"
                or artifact.content_text is None
                or text_hash(artifact.content_text) != artifact.content_hash
                or len(artifact.content_text.encode("utf-8")) != artifact.byte_size
                or artifact.provenance.get("origin") != "tool"
            ):
                raise ProviderFailure(
                    "invalid_quality_evidence", "Immutable отчёт инструмента изменился."
                )
            try:
                document = json.loads(artifact.content_text)
                tool_id = document["tool_run_id"]
                if (
                    tool_id in summaries
                    or tool_id not in cycle.tool_run_ids
                    or artifact.provenance.get("producer_id") != tool_id
                    or document["cycle_id"] != cycle.id
                    or any(document.get(name) != value for name, value in pins.items())
                ):
                    raise ValueError("Foreign tool summary")
                summaries[tool_id] = (artifact.id, document)
            except (ValueError, KeyError, TypeError) as failure:
                raise ProviderFailure(
                    "invalid_quality_evidence", "Отчёт инструмента принадлежит другой проверке."
                ) from failure
        for tool_id in cycle.tool_run_ids:
            tool = session.get(ToolRun, tool_id)
            if (
                tool is None
                or tool.run_id != run.id
                or tool.qa_cycle_id != cycle.id
                or not self._candidate_pins(run, view, tool)
            ):
                raise ProviderFailure(
                    "invalid_quality_evidence", "Чужая или изменённая проверка QA."
                )
            if tool.status in {"succeeded", "failed", "timed_out", "cancelled", "uncertain"}:
                summary = summaries.get(tool.id)
                if summary is None or any(
                    summary[1].get(name) != getattr(tool, name)
                    for name in (
                        "operation_id",
                        "status",
                        "exit_code",
                        "error_code",
                        "error_message",
                    )
                ):
                    raise ProviderFailure(
                        "invalid_quality_evidence",
                        "Исход инструмента изменился после immutable отчёта.",
                    )
            report_fields = {
                "status",
                "exit_code",
                "profile_hash",
                "profile_hash_after",
                "suite_hash",
                "suite_hash_after",
                "candidate_hash",
                "candidate_hash_after",
                "isolation_level",
            }
            tools.append(
                {
                    "id": tool.id,
                    "operation_id": tool.operation_id,
                    "status": tool.status,
                    "exit_code": tool.exit_code,
                    "error_code": tool.error_code,
                    "report": {
                        name: value for name, value in tool.report.items() if name in report_fields
                    }
                    if isinstance(tool.report, dict)
                    else None,
                    "tool_report_artifact_id": summaries.get(tool.id, (None,))[0],
                }
            )
        prior = list(
            session.scalars(
                select(QualityCycle)
                .where(QualityCycle.run_id == run.id, QualityCycle.iteration < cycle.iteration)
                .order_by(QualityCycle.iteration)
            )
        )
        prior_bug_ids = []
        for previous in prior:
            if previous.status != "failed" or len(previous.bug_artifact_ids) != 1:
                raise ProviderFailure(
                    "invalid_quality_evidence", "История repair не содержит подтверждённый Bug."
                )
            for artifact_id in previous.bug_artifact_ids:
                artifact = session.get(Artifact, artifact_id)
                if (
                    artifact is None
                    or artifact.run_id != run.id
                    or artifact.task_id != previous.task_id
                    or artifact.artifact_type != "bug"
                    or artifact.content_text is None
                    or text_hash(artifact.content_text) != artifact.content_hash
                ):
                    raise ProviderFailure(
                        "invalid_quality_evidence",
                        "Ссылка repair принадлежит чужому или изменённому Bug.",
                    )
                try:
                    bug = Bug.model_validate_json(artifact.content_text, strict=True)
                    if (
                        bug.cycle_id != previous.id
                        or bug.iteration != previous.iteration
                        or any(
                            getattr(bug, name) != getattr(previous, name)
                            for name in QualityPins.model_fields
                        )
                        or not set(bug.tool_run_ids).issubset(previous.tool_run_ids)
                    ):
                        raise ValueError("Foreign historical bug pins")
                except ValueError as failure:
                    raise ProviderFailure(
                        "invalid_quality_evidence", "Bug ссылается на другую историческую версию."
                    ) from failure
                prior_bug_ids.append(artifact_id)
        return {
            "cycle_id": cycle.id,
            "iteration": cycle.iteration,
            "pins": pins,
            "tools": tools,
            "prior_bug_ids": prior_bug_ids,
            "execution_tree_hash": tree_hash(
                {file.relative_path: file.content_hash for file in view.files}
                | {".codehead/manifest.json": view.manifest_hash}
            ),
        }

    def _validate_quality_result(self, session, run, task, result):
        try:
            context = self._quality_context(session, run, task)
            return validate_output(context, result.artifacts)
        except (ProviderFailure, InvalidFile) as failure:
            raise ProviderFailure(
                failure.code,
                str(failure),
                dispatched=True,
                raw_response=result.raw_response,
                stop_reason=result.stop_reason,
            ) from failure

    def _quality_completed(self, session, run, task, artifact_ids):
        cycle = self._cycle(session, task.id)
        report_artifact = next(
            session.get(Artifact, artifact_id)
            for artifact_id in artifact_ids
            if session.get(Artifact, artifact_id).artifact_type == "test_report"
        )
        report = json.loads(report_artifact.content_text)
        cycle.report_artifact_id = report_artifact.id
        cycle.bug_artifact_ids = [
            artifact_id
            for artifact_id in artifact_ids
            if session.get(Artifact, artifact_id).artifact_type == "bug"
        ]
        cycle.status, cycle.finished_at = report["status"], self.clock()
        if cycle.status == "passed":
            self._block(
                session,
                run,
                [
                    task
                    for task in self._tasks(session, run.id)
                    if task.role == "devops" and task.status == "queued"
                ],
                QUALITY_BOUNDARY,
                "stage.unavailable",
            )
            return
        if cycle.iteration >= run.limits["max_repair_iterations"]:
            run.status, run.blocked_reason = (
                "blocked",
                "Исчерпан лимит repair iterations: HTTP-проверки всё ещё не проходят.",
            )
            cycle.blocked_reason = run.blocked_reason
            return
        iteration = cycle.iteration + 1
        repair = Task(
            id=identifier(),
            run_id=run.id,
            role="backend",
            task_type="backend_repair",
            status="queued",
            dependencies=[task.id],
            input_versions={},
            iteration=iteration,
            attempt=0,
            record_version=1,
            created_at=self.clock(),
        )
        frontend = next(item for item in self._tasks(session, run.id) if item.role == "frontend")
        followup = Task(
            id=identifier(),
            run_id=run.id,
            role="qa",
            task_type="quality_assurance",
            status="queued",
            dependencies=[repair.id, frontend.id],
            input_versions={},
            iteration=iteration,
            attempt=0,
            record_version=1,
            created_at=self.clock(),
        )
        session.add_all([repair, followup])
        session.flush()
        cycle.repair_task_id, cycle.followup_task_id = repair.id, followup.id
        for devops in self._tasks(session, run.id):
            if devops.role == "devops" and devops.status == "queued":
                devops.dependencies = [followup.id]
                devops.record_version += 1
