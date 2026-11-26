"""Run the verified Clinic pipeline and preview lifecycle against a fresh test schema."""

import argparse
import hashlib
import io
import json
import os
from datetime import timedelta
from pathlib import Path
from urllib.error import URLError
from urllib.request import ProxyHandler, build_opener
from uuid import uuid4
from zipfile import ZipFile

from sqlalchemy.engine import make_url
from verify_clinic_candidate import _save
from verify_quality import document, settle

from codehead.clinic.files import text_hash
from codehead.contracts import CreateProject, PreviewCommand, RunCommand, StartRun
from codehead.delivery.package import PackageCompiler, document_hash
from codehead.errors import DomainError
from codehead.persistence.database import Database
from codehead.runner.execution import RestrictedProcessRunner
from codehead.workflow.worker import Worker, WorkerPool
from codehead.workflow.worker_service import WorkerService

SCENARIOS = {
    "standard": (7, ["passed"]),
    "repair_success": (9, ["failed", "passed"]),
    "repair_blocked": (10, ["failed", "failed", "failed"]),
}


def start_run(service, scenario, report):
    project = service.create_project(
        CreateProject(name=f"Preview {scenario}", description="Synthetic Clinic Demo data."),
        f"preview-project-{scenario}",
    )
    run = service.start_run(
        project.id,
        StartRun(mode="test", test_scenario=scenario),
        f"preview-start-{scenario}",
        "preview-check",
    )
    workers = [Worker(service, owner=f"preview-settle-{scenario}-{index}") for index in range(2)]
    try:
        final = settle(
            service, run, workers, report, final_statuses=("succeeded", "blocked", "failed")
        )
    finally:
        for worker in workers:
            service.disconnect(worker.owner)
    calls, cycles = SCENARIOS[scenario]
    assert final.run.workflow_version == "clinic-v4"
    assert final.usage.request_count == len(final.agent_runs) == calls
    assert final.usage.source == "test" and final.usage.cost_usd == 0
    assert [cycle.status for cycle in final.quality_cycles] == cycles
    assert (
        len([task for task in final.tasks if task.task_type == "backend_repair"]) == len(cycles) - 1
    )
    assert final.preview_sessions == [] and service.preview(run.id).access.origin is None
    _save(report / "snapshot.json", final.model_dump(mode="json"))
    if scenario == "repair_blocked":
        assert final.run.status == "blocked" and final.delivery is None
        assert all(tool.operation_id != "smoke_test" for tool in final.tool_runs)
        return final
    assert final.run.status == "succeeded" and all(
        task.status == "succeeded" for task in final.tasks
    )
    delivery = final.delivery
    assert delivery.status == "ready" and delivery.qa_cycle_id == final.quality_cycles[-1].id
    assert (
        delivery.candidate_id == final.candidate.id
        and delivery.revision == final.candidate.revision
    )
    assert delivery.tree_hash == final.candidate.tree_hash
    tools = {tool.id: tool for tool in final.tool_runs}
    build, smoke = tools[delivery.build_tool_run_id], tools[delivery.smoke_tool_run_id]
    assert build.status == smoke.status == "succeeded"
    assert document_hash(build.report) == delivery.build_report_hash
    assert smoke.report["status"] == "passed" and smoke.report["owned_processes_stopped"] is True
    assert smoke.report["package_tree_hash"] == delivery.package_tree_hash
    artifacts = {artifact.id: artifact for artifact in final.artifacts}
    for item in (
        delivery.qa_report_artifact_id,
        delivery.smoke_report_artifact_id,
        delivery.deployment_package_artifact_id,
    ):
        document(service, artifacts[item])
    runbook = service.artifact_content(delivery.runbook_artifact_id)
    assert text_hash(runbook.content) == artifacts[delivery.runbook_artifact_id].content_hash
    verify_archive(service, delivery)
    return final


def verify_archive(service, delivery):
    saved, archive = service.delivery_archive(delivery.run_id, delivery.id)
    assert saved == delivery
    assert hashlib.sha256(archive).hexdigest() == delivery.package_archive_hash
    assert len(archive) == delivery.package_archive_byte_size
    with ZipFile(io.BytesIO(archive)) as zipped:
        manifest = zipped.read(".codehead/package.json")
        assert hashlib.sha256(manifest).hexdigest() == delivery.package_manifest_hash
        payload = json.loads(manifest)
        assert payload["tree_hash"] == delivery.package_tree_hash
        assert payload["build_report_hash"] == delivery.build_report_hash
        assert payload["candidate_manifest_hash"] == delivery.manifest_hash
        for name, descriptor in payload["files"].items():
            raw = zipped.read(name)
            assert len(raw) == descriptor["byte_size"]
            assert hashlib.sha256(raw).hexdigest() == descriptor["sha256"]


def command(service, delivery, operation, version, session_id=None, key=None):
    return service.preview_command(
        delivery.run_id,
        PreviewCommand(
            command=operation,
            package_id=delivery.id,
            expected_version=version,
            preview_session_id=session_id,
        ),
        key or str(uuid4()),
        "preview-check",
    )


def advance(pool, service, run_id, status):
    for _ in range(12):
        pool.run_once()
        result = service.preview(run_id)
        if result.preview_sessions and result.preview_sessions[-1].status == status:
            return result
    raise AssertionError(f"Preview did not reach {status}: {result.model_dump(mode='json')}")


def read_health(origin):
    opener = build_opener(ProxyHandler({}))
    with opener.open(origin + "/health", timeout=2) as response:
        assert response.status == 200
        assert json.load(response) == {"status": "ok"}


def verify_lifecycle(service, deliveries, report):
    with WorkerPool(service, owner="preview-lifecycle", slots=2) as pool:
        running = []
        for delivery in deliveries:
            before = service.snapshot(delivery.run_id)
            assert service.preview(delivery.run_id).preview_sessions == []
            service.events(delivery.run_id)
            assert service.snapshot(delivery.run_id) == before
            key = str(uuid4())
            queued = command(service, delivery, "start", 0, key=key)
            assert queued.status == "created"
            assert service.preview(delivery.run_id).access.origin is None
            assert command(service, delivery, "start", 0, key=key) == queued
            ready = advance(pool, service, delivery.run_id, "ready")
            assert ready.access.status == "available" and ready.access.origin
            assert ready.access.version == ready.preview_sessions[-1].version
            read_health(ready.access.origin)
            assert all(item[1].access.origin != ready.access.origin for item in running)
            running.append((delivery, ready))
        for offset, (delivery, ready) in enumerate(running):
            active = ready.preview_sessions[-1]
            command(service, delivery, "stop", active.version, active.id)
            stopped = advance(pool, service, delivery.run_id, "stopped")
            assert stopped.access.origin is None
            assert service.snapshot(delivery.run_id).run.status == "succeeded"
            for other_delivery, other_ready in running[offset + 1 :]:
                assert (
                    service.preview(other_delivery.run_id).access.origin
                    == other_ready.access.origin
                )
                read_health(other_ready.access.origin)
            try:
                read_health(ready.access.origin)
            except (URLError, TimeoutError):
                pass
            else:
                raise AssertionError("A stopped preview is still serving requests.")
            _save(report / f"lifecycle-{delivery.id}.json", stopped.model_dump(mode="json"))
        delivery, _ = running[0]
        version = service.preview(delivery.run_id).preview_sessions[-1].version
        package = service._load_delivery_package(delivery)
        index = package.root / "frontend/dist/index.html"
        original = index.read_bytes()
        index.write_bytes(b"changed")
        try:
            try:
                verify_archive(service, delivery)
            except DomainError:
                pass
            else:
                raise AssertionError("A changed package was downloaded.")
            command(service, delivery, "start", version)
            failure = advance(pool, service, delivery.run_id, "failed")
            assert failure.access.origin is None
            assert failure.preview_sessions[-1].error_code == "package_changed"
        finally:
            index.write_bytes(original)
        failed = service.preview(delivery.run_id).preview_sessions[-1]
        command(service, delivery, "start", failed.version)
        ready = advance(pool, service, delivery.run_id, "ready")
        read_health(ready.access.origin)
        original_clock = service.clock
        expired = original_clock() + timedelta(seconds=service.lease_seconds + 11)
        try:
            service.clock = lambda: expired
            before = service.snapshot(delivery.run_id)
            assert service.preview(delivery.run_id).access.origin is None
            assert service.snapshot(delivery.run_id) == before
            assert service.recover_previews() == 1
            uncertain = service.preview(delivery.run_id)
            assert uncertain.preview_sessions[-1].status == "uncertain"
            assert uncertain.access.origin is None
            _save(report / "expired-preview.json", uncertain.model_dump(mode="json"))
        finally:
            service.clock = original_clock
    assert service.preview(delivery.run_id).access.origin is None
    remaining = service.snapshot(delivery.run_id)
    assert remaining.run.status == "succeeded" and remaining.delivery == delivery
    try:
        read_health(ready.access.origin)
    except (URLError, TimeoutError):
        pass
    else:
        raise AssertionError("The original worker did not close its own expired preview.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--schema", required=True)
    parser.add_argument("--report-root", type=Path, required=True)
    parser.add_argument("--scenario", action="append", choices=SCENARIOS)
    args = parser.parse_args()
    url = os.environ["CODEHEAD_TEST_DATABASE_URL"]
    if not (make_url(url).database or "").endswith("_test") or not args.schema.startswith("test_"):
        raise SystemExit("The preview verifier requires a dedicated test database and schema.")
    scenarios = args.scenario or list(SCENARIOS)
    if len(set(scenarios)) != len(scenarios):
        raise SystemExit("Select each scenario once.")
    report = args.report_root.absolute()
    database = Database(url, schema=args.schema)
    compiler = PackageCompiler(report / "tools", report / "packages")
    service = WorkerService(
        database,
        workspace_root=report / "candidates",
        tool_runner=RestrictedProcessRunner(workspace_root=compiler.tool_root),
        package_compiler=compiler,
        preview_data_root=report / "preview",
    )
    finals = []
    try:
        for scenario in scenarios:
            target = report / scenario
            target.mkdir()
            final = start_run(service, scenario, target)
            finals.append(final)
            print(
                f"Clinic {scenario}: {final.run.status}, calls={final.usage.request_count}",
                flush=True,
            )
            if final.run.status == "blocked":
                service.run_command(
                    final.run.id,
                    RunCommand(command="cancel"),
                    f"check-{scenario}-cancel",
                    "preview-check",
                )
        deliveries = [final.delivery for final in finals if final.delivery is not None]
        if deliveries:
            verify_lifecycle(service, deliveries, report)
            print(
                "Verified ZIP, real health, different ports, stop, changed package, worker loss.",
                flush=True,
            )
        _save(
            report / "results.json",
            [
                {
                    "scenario": final.run.test_scenario,
                    "run_id": final.run.id,
                    "status": final.run.status,
                    "calls": final.usage.request_count,
                    "delivery": final.delivery.model_dump(mode="json") if final.delivery else None,
                }
                for final in finals
            ],
        )
    finally:
        service.preview_runtime.close()
        database.close()


if __name__ == "__main__":
    main()
