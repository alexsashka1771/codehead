import hashlib
import json
from dataclasses import replace
from datetime import timedelta

import pytest
from test_quality_workflow import KnownRunner, drain, setup_run

from codehead.clinic.workspace import materialize
from codehead.contracts import DecisionResolution, RunCommand
from codehead.delivery.package import PackageCompiler
from codehead.delivery.runtime import RuntimeResult
from codehead.errors import DomainError


class BuildRunner(KnownRunner):
    def __init__(self, root, failed_cycles):
        super().__init__(failed_cycles)
        self.root = root

    def execute(self, request, **kwargs):
        result = super().execute(request, **kwargs)
        if request.operation_id != "build_frontend":
            return result
        copy = materialize(
            self.root / request.tool_run_id,
            request.candidate,
            request.contents,
            request.manifest_content,
        )
        index = b"<!doctype html><title>Clinic build witness</title>"
        dist = copy / "frontend" / "dist"
        dist.mkdir()
        (dist / "index.html").write_bytes(index)
        return replace(
            result,
            report={
                "status": "passed",
                "artifact_bytes": len(index),
                "files": {
                    "index.html": {
                        "byte_size": len(index),
                        "sha256": hashlib.sha256(index).hexdigest(),
                    }
                },
            },
        )


class ObservedRuntime:
    def __init__(self, smoke_status="passed"):
        self.smoke_status = smoke_status
        self.smokes = []
        self.starts = []
        self.stops = []
        self.sessions = {}
        self.stopped = {}

    def smoke(self, request, *, should_stop, **_):
        assert not should_stop()
        self.smokes.append(request)
        return RuntimeResult(
            self.smoke_status,
            backend_pid=15000,
            bridge_pid=15001,
            report={
                "status": "passed",
                "package_tree_hash": request.package.tree_hash,
                "health_status": 200,
                "index_status": 200,
                "fresh_database": True,
                "owned_processes_stopped": True,
            }
            if self.smoke_status == "passed"
            else None,
        )

    def start(self, request, *, should_stop, **_):
        assert not should_stop()
        self.starts.append(request)
        self.sessions[request.preview_id] = request.owner_boot
        return RuntimeResult("ready", "http://127.0.0.1:44444", 15000, 15001)

    def owns(self, preview_id, owner_boot):
        return self.sessions.get(preview_id) == owner_boot

    def probe(self, preview_id, owner_boot):
        if self.owns(preview_id, owner_boot):
            return RuntimeResult("ready", "http://127.0.0.1:44444", 15000, 15001)
        return RuntimeResult("uncertain")

    def stop(self, preview_id, owner_boot):
        self.stops.append((preview_id, owner_boot))
        if not self.owns(preview_id, owner_boot):
            return self.confirmed_stop(preview_id, owner_boot) or RuntimeResult("uncertain")
        self.sessions.pop(preview_id)
        result = RuntimeResult("stopped", backend_pid=15000, bridge_pid=15001)
        self.stopped[preview_id, owner_boot] = result
        return result

    def confirmed_stop(self, preview_id, owner_boot):
        return self.stopped.get((preview_id, owner_boot))

    def close(self):
        for preview_id, owner_boot in list(self.sessions.items()):
            self.stop(preview_id, owner_boot)


def configured_run(database, tmp_path, *, smoke="passed", scenario="standard", failed=0, calls=64):
    service, run, engine, worker = setup_run(
        database,
        tmp_path / "candidates",
        scenario=scenario,
        failed=failed,
        llm_calls=calls,
        workflow_version="clinic-v4",
    )
    engine.tool_runner = BuildRunner(tmp_path / "tool-runs", failed)
    engine.package_compiler = service.package_compiler = PackageCompiler(
        tmp_path / "tool-runs", tmp_path / "packages"
    )
    engine.preview_runtime = ObservedRuntime(smoke)
    engine.preview_data_root = tmp_path / "preview"
    return service, run, engine, worker


@pytest.mark.parametrize(
    "scenario, failed, calls, status",
    [
        ("standard", 0, 7, "succeeded"),
        ("repair_success", 1, 9, "succeeded"),
        ("repair_blocked", 3, 10, "blocked"),
    ],
)
def test_delivery_uses_exact_passing_qa_build_and_smoke(
    database, tmp_path, scenario, failed, calls, status
):
    service, run, engine, worker = configured_run(
        database, tmp_path, scenario=scenario, failed=failed
    )
    snapshot = drain(service, run, worker)
    assert snapshot.run.status == status
    assert len(snapshot.agent_runs) == calls
    if status == "blocked":
        assert snapshot.delivery is None
        assert not engine.preview_runtime.smokes
        return
    delivery = snapshot.delivery
    assert delivery.status == "ready"
    assert delivery.qa_cycle_id == snapshot.quality_cycles[-1].id
    assert delivery.revision == snapshot.candidate.revision
    assert delivery.build_tool_run_id in snapshot.quality_cycles[-1].tool_run_ids
    assert len(engine.preview_runtime.smokes) == 1
    assert engine.preview_runtime.smokes[0].preview_id == delivery.smoke_tool_run_id
    tools = {tool.id: tool for tool in snapshot.tool_runs}
    assert tools[delivery.smoke_tool_run_id].status == "succeeded"
    assert tools[delivery.smoke_tool_run_id].delivery_id == delivery.id
    package = json.loads(service.artifact_content(delivery.deployment_package_artifact_id).content)
    assert package["package_archive_hash"] == delivery.package_archive_hash
    assert package["smoke_tool_run_id"] == delivery.smoke_tool_run_id
    assert package["qa_report_artifact_id"] == delivery.qa_report_artifact_id
    assert service.artifact(delivery.runbook_artifact_id).author_role == "devops"
    attempt = next(item for item in snapshot.agent_runs if item.task_id == delivery.task_id)
    trace = service.attempt_trace(attempt.id)
    assert delivery.smoke_report_artifact_id in trace.input_versions
    assert delivery.qa_report_artifact_id in trace.input_versions
    assert delivery.package_archive_hash in trace.prompt
    assert attempt.status == "succeeded"


@pytest.mark.parametrize("status", ["failed", "timed_out", "uncertain"])
def test_nonpassing_smoke_never_dispatches_devops(database, tmp_path, status):
    service, run, _, worker = configured_run(database, tmp_path, smoke=status)
    snapshot = drain(service, run, worker)
    assert snapshot.run.status == "blocked"
    assert snapshot.delivery.status in {"failed", "blocked"}
    assert snapshot.delivery.deployment_package_artifact_id is None
    assert len(snapshot.agent_runs) == 6
    tool = next(tool for tool in snapshot.tool_runs if tool.operation_id == "smoke_test")
    assert tool.status == status


def test_delivery_honors_provider_call_limit(database, tmp_path):
    service, run, _, worker = configured_run(database, tmp_path, calls=6)
    snapshot = drain(service, run, worker)
    assert snapshot.run.status == "blocked"
    assert snapshot.delivery.status == "blocked"
    assert snapshot.delivery.deployment_package_artifact_id is None
    assert len(snapshot.agent_runs) == 6


def advance_delivery(service, run, worker, status):
    for _ in range(40):
        worker.run_once()
        snapshot = service.snapshot(run.id)
        if snapshot.delivery is not None and snapshot.delivery.status == status:
            return snapshot.delivery
        for decision in snapshot.decisions:
            if decision.kind == "architecture_approval" and decision.status == "open":
                service.resolve_decision(
                    decision.id,
                    DecisionResolution(version=decision.version, choice="approve"),
                    "qa-approve",
                    "qa-test",
                )
    pytest.fail(f"Delivery did not reach {status}")


def test_cancel_waits_for_in_progress_package_publication(database, tmp_path):
    service, run, engine, worker = configured_run(database, tmp_path)
    advance_delivery(service, run, worker, "created")
    lease = engine.claim_delivery(worker.owner)
    package = engine.package_compiler.publish(lease.request)
    cancelling = service.run_command(
        run.id, RunCommand(command="cancel"), "cancel-delivery", "test"
    )
    assert cancelling.status == "pausing"
    engine.finish_delivery(lease, package)
    snapshot = service.snapshot(run.id)
    assert snapshot.run.status == snapshot.delivery.status == "cancelled"
    assert snapshot.delivery.smoke_tool_run_id is None


def test_expired_publication_cannot_seal_a_recovered_generation(database, tmp_path):
    service, run, engine, worker = configured_run(database, tmp_path)
    advance_delivery(service, run, worker, "created")
    lease = engine.claim_delivery(worker.owner)
    old_package = engine.package_compiler.publish(lease.request)
    future = engine.clock() + timedelta(seconds=engine.lease_seconds + 1)
    engine.clock = lambda: future
    assert engine.recover() == 1
    replacement = engine.claim_delivery("other-worker")
    assert replacement.fencing_token > lease.fencing_token
    assert replacement.request.generation > lease.request.generation
    with pytest.raises(DomainError, match="lease"):
        engine.finish_delivery(lease, old_package)
    assert service.snapshot(run.id).delivery.status == "publishing"
    engine.finish_delivery(replacement, engine.package_compiler.publish(replacement.request))
    assert service.snapshot(run.id).delivery.status == "smoking"


def test_late_smoke_after_worker_loss_cannot_advance_delivery(database, tmp_path):
    service, run, engine, worker = configured_run(database, tmp_path)
    advance_delivery(service, run, worker, "smoking")
    lease = engine.claim_runtime_tool(worker.owner)
    future = engine.clock() + timedelta(seconds=engine.lease_seconds + 1)
    engine.clock = lambda: future
    assert engine.recover() == 1
    with pytest.raises(DomainError) as stale:
        engine.finish_runtime_tool(lease, RuntimeResult("passed"))
    assert stale.value.code == "stale_runtime_tool"
    snapshot = service.snapshot(run.id)
    assert snapshot.run.status == snapshot.delivery.status == "blocked"
    assert snapshot.tool_runs[-1].status == "uncertain"
    assert any(decision.tool_run_id == lease.tool.id for decision in snapshot.decisions)


def test_unrecognized_runtime_success_cannot_advance_smoke(database, tmp_path):
    service, run, engine, worker = configured_run(database, tmp_path, smoke="succeeded")
    advance_delivery(service, run, worker, "smoking")
    worker.run_once()
    snapshot = service.snapshot(run.id)
    assert snapshot.run.status == "blocked"
    assert snapshot.delivery.status in {"failed", "blocked"}
    assert snapshot.tool_runs[-1].status in {"failed", "uncertain"}
    assert snapshot.tool_runs[-1].exit_code is None
    assert snapshot.delivery.deployment_package_artifact_id is None


def test_provider_rejects_altered_devops_artifacts(database, tmp_path):
    from codehead.llm.provider import ProviderFailure

    service, run, engine, worker = configured_run(database, tmp_path)
    advance_delivery(service, run, worker, "analyzing")
    lease = engine.claim(worker.owner)
    assert engine.begin(lease)
    result = lease.provider.run(lease.request)
    forged = replace(result, raw_response='{"artifacts":[], "summary":"spoofed"}')
    with pytest.raises(ProviderFailure) as invalid:
        engine.finish(lease, forged)
    assert invalid.value.code == "invalid_provider_output"
    engine.fail(lease, invalid.value)
    snapshot = service.snapshot(run.id)
    assert snapshot.run.status == "blocked"
    assert snapshot.delivery.status == "failed"
    assert snapshot.delivery.runbook_artifact_id is None
