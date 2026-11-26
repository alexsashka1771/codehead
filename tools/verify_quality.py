"""Verify persisted QA and bounded repairs using the unchanged real HTTP suite."""

import argparse
import json
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from sqlalchemy.engine import make_url
from verify_clinic_candidate import _save

from codehead.clinic.files import text_hash, tree_hash
from codehead.clinic.profile import load_profile
from codehead.contracts import (
    Bug,
    CreateProject,
    DecisionResolution,
    QualityPins,
    StartRun,
    TestReport,
)
from codehead.persistence.database import Database
from codehead.runner.execution import RestrictedProcessRunner
from codehead.workflow.worker import Worker
from codehead.workflow.worker_service import WorkerService

SCENARIOS = {
    "standard": (6, ["passed"]),
    "repair_success": (8, ["failed", "passed"]),
    "repair_blocked": (10, ["failed", "failed", "failed"]),
}
TERMINAL_TASKS = {"succeeded", "failed", "cancelled"}


def settle(service, run, workers, report, *, final_statuses=("blocked",)):
    stopped = threading.Event()
    history = {}

    def consume(worker):
        while not stopped.is_set():
            worker.run_once()
            stopped.wait(0.05)

    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(consume, worker) for worker in workers]
        deadline = time.monotonic() + 900
        last_progress = None
        last_print = 0
        try:
            while time.monotonic() < deadline:
                for future in futures:
                    if future.done():
                        future.result()
                        raise RuntimeError("A QA worker stopped before the boundary.")
                snapshot = service.snapshot(run.id)
                for task in snapshot.tasks:
                    state = task.model_dump(mode="json")
                    if task.id in history and history[task.id] != state:
                        raise AssertionError("A completed Task was reopened or modified.")
                    if task.status in TERMINAL_TASKS:
                        history[task.id] = state
                approval = next(
                    (
                        item
                        for item in snapshot.decisions
                        if item.status == "open" and item.kind == "architecture_approval"
                    ),
                    None,
                )
                if approval:
                    service.resolve_decision(
                        approval.id,
                        DecisionResolution(version=approval.version, choice="approve"),
                        "qa-check-approve",
                        "qa-check",
                    )
                progress = (
                    snapshot.run.status,
                    len(snapshot.agent_runs),
                    tuple((cycle.iteration, cycle.status) for cycle in snapshot.quality_cycles),
                    tuple((tool.operation_id, tool.status) for tool in snapshot.tool_runs),
                )
                now = time.monotonic()
                if progress != last_progress or now - last_print >= 30:
                    print(
                        f"{run.test_scenario}: calls={len(snapshot.agent_runs)} "
                        f"cycles={progress[2]} tools={progress[3]}",
                        flush=True,
                    )
                    last_progress, last_print = progress, now
                active = any(tool.status in {"created", "running"} for tool in snapshot.tool_runs)
                active |= any(
                    attempt.status in {"created", "running"} for attempt in snapshot.agent_runs
                )
                if snapshot.run.status in final_statuses and not active and not approval:
                    return snapshot
                time.sleep(0.1)
            raise TimeoutError("QA did not reach its bounded final checkpoint in 900 seconds.")
        finally:
            stopped.set()
            for future in futures:
                future.result()
            _save(report / "last-snapshot.json", service.snapshot(run.id).model_dump(mode="json"))


def document(service, artifact):
    content = service.artifact_content(artifact.id)
    assert text_hash(content.content) == artifact.content_hash == content.content_hash
    return json.loads(content.content)


def verify(service, snapshot, scenario, roots):
    calls, expected = SCENARIOS[scenario]
    assert snapshot.run.workflow_version == "clinic-v3"
    assert snapshot.run.status == "blocked"
    assert snapshot.usage.request_count == len(snapshot.agent_runs) == calls
    assert snapshot.usage.source == "test" and snapshot.usage.cost_usd == 0
    assert all(
        attempt.provider == "test" and attempt.status == "succeeded"
        for attempt in snapshot.agent_runs
    )
    assert [cycle.status for cycle in snapshot.quality_cycles] == expected
    assert len(snapshot.tool_runs) == 3 * len(expected)
    tasks = {task.id: task for task in snapshot.tasks}
    repairs = [task for task in snapshot.tasks if task.task_type == "backend_repair"]
    assert [task.iteration for task in repairs] == list(range(1, len(expected)))
    assert all(task.status == "succeeded" for task in repairs)
    assert all(
        task.attempt == 1 for task in snapshot.tasks if task.role in {"backend", "frontend", "qa"}
    )
    artifacts = {artifact.id: artifact for artifact in snapshot.artifacts}
    tools = {tool.id: tool for tool in snapshot.tool_runs}
    prior_bugs = []
    frontend_hashes = None
    for iteration, cycle in enumerate(snapshot.quality_cycles):
        assert cycle.iteration == tasks[cycle.task_id].iteration == iteration
        assert tasks[cycle.task_id].status == "succeeded"
        manifest_artifact = artifacts[cycle.manifest_artifact_id]
        manifest = document(service, manifest_artifact)
        assert manifest_artifact.content_hash == cycle.manifest_hash
        assert manifest["revision"] == cycle.revision
        assert manifest["tree_hash"] == cycle.tree_hash
        source_hashes = {}
        for file in manifest["files"]:
            source = service.artifact_content(file["artifact_id"])
            assert text_hash(source.content) == file["content_hash"] == source.content_hash
            source_hashes[file["relative_path"]] = file["content_hash"]
            if file["parent_artifact_id"]:
                assert artifacts[file["parent_artifact_id"]].content_hash == file["parent_hash"]
        assert tree_hash(source_hashes) == cycle.tree_hash
        current_frontend = {
            path: digest for path, digest in source_hashes.items() if path.startswith("frontend/")
        }
        if frontend_hashes is None:
            frontend_hashes = current_frontend
        assert current_frontend == frontend_hashes, "Backend repair lost frontend files."
        execution_hash = tree_hash(source_hashes | {".codehead/manifest.json": cycle.manifest_hash})
        report = TestReport.model_validate(document(service, artifacts[cycle.report_artifact_id]))
        assert report.status == expected[iteration]
        assert report.model_dump(include=set(QualityPins.model_fields)) == cycle.model_dump(
            include=set(QualityPins.model_fields)
        )
        assert report.tool_run_ids == cycle.tool_run_ids
        assert len(report.requirements) == 8
        assert all(item.status == "proposed" for item in report.proposed_tests)
        if report.status == "passed" and prior_bugs:
            assert set(report.resolves_bug_ids) == set(prior_bugs)
        cycle_tools = [tools[tool_id] for tool_id in cycle.tool_run_ids]
        assert {tool.operation_id for tool in cycle_tools} == {
            "validate_backend",
            "test_backend",
            "build_frontend",
        }
        assert len(cycle.tool_report_artifact_ids) == 3
        for tool in cycle_tools:
            assert tool.qa_cycle_id == cycle.id
            assert tool.tree_hash == cycle.tree_hash and tool.manifest_hash == cycle.manifest_hash
            assert (
                tool.snapshot_version == cycle.revision and tool.workspace_id == cycle.candidate_id
            )
            assert tool.isolation_level == "process_only"
            summaries = [
                artifacts[item]
                for item in cycle.tool_report_artifact_ids
                if artifacts[item].provenance.producer_id == tool.id
            ]
            assert len(summaries) == 1
            summary = document(service, summaries[0])
            assert summary["tool_run_id"] == tool.id and summary["cycle_id"] == cycle.id
            assert summary["status"] == tool.status and summary["exit_code"] == tool.exit_code
            if tool.operation_id != "test_backend":
                assert tool.status == "succeeded" and tool.exit_code == 0
                continue
            raw = tool.report
            assert raw["status"] == expected[iteration]
            assert raw["candidate_hash"] == raw["candidate_hash_after"] == execution_hash
            assert raw["suite_hash"] == raw["suite_hash_after"] == cycle.acceptance_suite_hash
            assert raw["profile_hash"] == raw["profile_hash_after"] == cycle.profile_hash
            data_root = raw["test_data_root"]
            assert data_root not in roots and Path(data_root).is_dir()
            roots.add(data_root)
            assert list(Path(data_root).rglob("*.sqlite*")), "The real suite did not create SQLite."
            if expected[iteration] == "failed":
                assert (
                    tool.status == "failed"
                    and tool.error_code == "tool_failed"
                    and tool.exit_code == 1
                )
                assert "[201, 201]" in raw["output"], (
                    "The red was not the concurrent booking defect."
                )
            else:
                assert tool.status == "succeeded" and tool.exit_code == 0
        assert len(cycle.bug_artifact_ids) == (expected[iteration] == "failed")
        for bug_id in cycle.bug_artifact_ids:
            bug = Bug.model_validate(document(service, artifacts[bug_id]))
            assert bug.cycle_id == cycle.id and bug.iteration == iteration
            assert set(bug.tool_run_ids).issubset(cycle.tool_run_ids)
        prior_bugs.extend(cycle.bug_artifact_ids)
        if iteration < len(expected) - 1:
            assert cycle.repair_task_id == repairs[iteration].id
            assert cycle.followup_task_id == snapshot.quality_cycles[iteration + 1].task_id
        else:
            assert cycle.repair_task_id is None and cycle.followup_task_id is None
    injections = [
        artifact for artifact in snapshot.artifacts if artifact.artifact_type == "test_injection"
    ]
    assert len(injections) == (scenario != "standard")
    assert snapshot.run.injection_done == (scenario != "standard")
    assert snapshot.candidate.revision == (3 if scenario == "standard" else 3 + len(expected))
    if injections:
        injection = document(service, injections[0])
        assert injections[0].provenance.producer_id is None
        assert injection["fixture_id"] == "check-then-insert"
        before, after = injection["before"], injection["after"]
        assert before["revision"] == 3 and after["revision"] == 4
        assert before["storage_hash"] != after["storage_hash"] == injection["fixture_hash"]
        injected_manifest = artifacts[after["manifest_artifact_id"]]
        assert injected_manifest.provenance.parent_artifact_id == before["manifest_artifact_id"]
        assert artifacts[before["manifest_artifact_id"]].content_hash == before["manifest_hash"]
        assert injected_manifest.content_hash == after["manifest_hash"]
        injected_files = document(service, injected_manifest)["files"]
        storage = next(
            file for file in injected_files if file["relative_path"] == injection["relative_path"]
        )
        assert storage["origin"] == "test_injected" and storage["source"] == "test"
        assert storage["producer_id"] is None and storage["parent_hash"] == before["storage_hash"]
        assert storage["content_hash"] == after["storage_hash"]
    if expected[-1] == "passed":
        assert "DevOps" in snapshot.run.blocked_reason and "preview" in snapshot.run.blocked_reason
    else:
        assert "repair" in snapshot.run.blocked_reason.lower()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--schema", required=True)
    parser.add_argument("--report-root", type=Path, required=True)
    parser.add_argument("--scenario", choices=SCENARIOS, default="standard")
    args = parser.parse_args()
    url = os.environ["CODEHEAD_TEST_DATABASE_URL"]
    if not (make_url(url).database or "").endswith("_test"):
        raise SystemExit("Only an explicit isolated test database is allowed.")
    report = args.report_root.absolute()
    report.mkdir(parents=True, exist_ok=True)
    database = Database(url, schema=args.schema)
    profile = load_profile()
    roots, results = set(), []
    try:
        for scenario in (args.scenario,):
            target = report / scenario
            target.mkdir()
            service = WorkerService(
                database,
                workspace_root=target / "candidates",
                tool_runner=RestrictedProcessRunner(workspace_root=target / "tools"),
            )
            project = service.create_project(
                CreateProject(name=f"QA {scenario}", description="Synthetic clinic acceptance."),
                f"qa-project-{scenario}",
            )
            run = service.start_run(
                project.id,
                StartRun(mode="test", workflow_version="clinic-v3", test_scenario=scenario),
                f"qa-start-{scenario}",
                "qa-check",
            )
            workers = [Worker(service, owner=f"qa-{scenario}-{index}") for index in range(2)]
            try:
                final = settle(service, run, workers, target)
                verify(service, final, scenario, roots)
                _save(target / "snapshot.json", final.model_dump(mode="json"))
                events, cursor = [], 0
                while True:
                    page = service.events(run.id, after_seq=cursor, limit=73)
                    events.extend(page.events)
                    if not page.has_more:
                        break
                    assert page.next_after_seq > cursor
                    cursor = page.next_after_seq
                assert [event.seq for event in events] == list(range(1, final.last_event_seq + 1))
                workflow = next(
                    event.payload
                    for event in reversed(events)
                    if event.event_type == "workflow.updated"
                )
                assert workflow.quality_cycles == final.quality_cycles
                assert workflow.tool_runs == final.tool_runs
                assert service.snapshot(run.id) == final, "Reading events caused external effects."
                _save(target / "events.json", [event.model_dump(mode="json") for event in events])
                result = {
                    "scenario": scenario,
                    "status": "passed",
                    "run_id": run.id,
                    "calls": final.usage.request_count,
                    "cycles": len(final.quality_cycles),
                    "tools": len(final.tool_runs),
                    "preview": "unavailable",
                    "live": "unavailable",
                }
                results.append(result)
                print(f"QA verified: {result}", flush=True)
            finally:
                for worker in workers:
                    service.disconnect(worker.owner)
        after = load_profile()
        assert (profile.profile_hash, profile.suite_hash, profile.template_hash) == (
            after.profile_hash,
            after.suite_hash,
            after.template_hash,
        )
        _save(
            report / args.scenario / "summary.json",
            {
                "status": "passed",
                "schema": args.schema,
                "scenarios": results,
                "fresh_sqlite_roots": sorted(roots),
                "suite_hash": profile.suite_hash,
            },
        )
        print("QA verified: selected scenarios; unchanged suite; immutable history.", flush=True)
        return 0
    finally:
        database.close()


if __name__ == "__main__":
    raise SystemExit(main())
