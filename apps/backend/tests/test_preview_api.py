import hashlib
import io
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from threading import Event
from zipfile import ZipFile

import pytest
from conftest import command_headers
from test_delivery_workflow import configured_run
from test_quality_workflow import drain

from codehead.contracts import PreviewCommand, StartRun
from codehead.delivery.runtime import PreviewRuntime, RuntimeResult
from codehead.errors import DomainError
from codehead.llm.test_provider import TestProvider
from codehead.persistence.models import PreviewSession
from codehead.workflow.worker import WorkerPool


def test_preview_read_and_idempotent_commands(client, database, tmp_path):
    service, run, engine, worker = configured_run(database, tmp_path)
    client.app.state.service = service
    path = f"/api/runs/{run.id}/preview"
    before = client.get(path)
    assert before.status_code == 200
    assert before.json()["delivery"] is None
    assert before.json()["access"]["status"] == "unavailable"
    snapshot = drain(service, run, worker)
    assert snapshot.run.status == "succeeded"
    package = snapshot.delivery
    runtime = engine.preview_runtime

    download = client.get(f"/api/runs/{run.id}/delivery/{package.id}/archive")
    assert download.status_code == 200
    assert download.headers["content-type"] == "application/zip"
    assert download.headers["content-disposition"].startswith("attachment;")
    assert download.headers["x-content-type-options"] == "nosniff"
    assert hashlib.sha256(download.content).hexdigest() == package.package_archive_hash
    assert ".codehead/package.json" in ZipFile(io.BytesIO(download.content)).namelist()

    assert client.get(path).json()["preview_sessions"] == []
    assert client.get(path).json()["access"]["origin"] is None
    command = {"command": "start", "package_id": package.id, "expected_version": 0}
    denied = client.post(path + "/commands", json=command, headers={"Origin": "null"})
    assert denied.status_code == 403
    headers = command_headers("preview-start")
    created = client.post(path + "/commands", json=command, headers=headers)
    assert created.status_code == 202
    assert created.json()["status"] == "created"
    assert not runtime.starts
    assert client.get(path).json()["access"]["origin"] is None
    assert worker.run_once()

    ready = client.get(path).json()
    assert ready["access"]["status"] == "available"
    assert ready["access"]["origin"] == "http://127.0.0.1:44444"
    first = ready["preview_sessions"][0]
    assert first["status"] == "ready"
    assert len(runtime.starts) == 1
    assert client.post(path + "/commands", json=command, headers=headers).json() == created.json()
    assert (
        client.post(path + "/commands", json=command, headers=command_headers()).status_code == 409
    )

    stop = {
        "command": "stop",
        "package_id": package.id,
        "preview_session_id": first["id"],
        "expected_version": first["version"],
    }
    stopped = client.post(path + "/commands", json=stop, headers=command_headers())
    assert stopped.status_code == 202
    assert stopped.json()["status"] == "stopping"
    assert not runtime.stops
    assert client.get(path).json()["access"]["origin"] is None
    assert worker.run_once()
    assert client.get(path).json()["preview_sessions"][0]["status"] == "stopped"
    assert service.snapshot(run.id).run.status == "succeeded"
    assert runtime.stops == [(first["id"], "qa-worker")]


def preview_command(service, delivery, command, version, *, session_id=None):
    return service.preview_command(
        delivery.run_id,
        PreviewCommand(
            command=command,
            package_id=delivery.id,
            expected_version=version,
            preview_session_id=session_id,
        ),
        f"{command}-{version}",
        "preview-test",
    )


def test_stop_before_start_leaves_no_pending_start_and_allows_explicit_restart(database, tmp_path):
    service, run, engine, worker = configured_run(database, tmp_path)
    delivery = drain(service, run, worker).delivery
    queued = preview_command(service, delivery, "start", 0)
    preview_command(service, delivery, "stop", queued.version, session_id=queued.id)
    worker.run_once()
    runtime = engine.preview_runtime
    assert not runtime.starts and not runtime.stops
    snapshot = service.snapshot(run.id)
    assert snapshot.preview_sessions[-1].status == "stopped"
    assert (
        next(tool for tool in snapshot.tool_runs if tool.id == queued.start_tool_run_id).status
        == "cancelled"
    )
    next_start = preview_command(service, delivery, "start", snapshot.preview_sessions[-1].version)
    assert next_start.id != queued.id
    worker.run_once()
    assert len(runtime.starts) == 1
    assert service.preview(run.id).access.preview_session_id == next_start.id


def test_expired_preview_access_is_read_only_and_late_start_is_fenced(database, tmp_path):
    service, run, engine, worker = configured_run(database, tmp_path)
    delivery = drain(service, run, worker).delivery
    queued = preview_command(service, delivery, "start", 0)
    lease = engine.claim_runtime_tool(worker.owner)
    now = engine.clock() + timedelta(seconds=engine.lease_seconds + 1)
    service.clock = engine.clock = lambda: now
    before = service.snapshot(run.id)
    for _ in range(2):
        observed = service.preview(run.id)
        assert observed.access.origin is None
        assert observed.preview_sessions[-1].status == "starting"
    assert service.snapshot(run.id) == before
    assert engine.recover_previews() == 1
    with pytest.raises(DomainError) as failure:
        engine.finish_runtime_tool(lease, RuntimeResult("ready", "http://127.0.0.1:44444", 1, 2))
    assert failure.value.code == "stale_runtime_tool"
    after = service.snapshot(run.id)
    assert after.preview_sessions[-1].status == "uncertain"
    assert after.run == before.run.model_copy(update={"last_event_seq": after.last_event_seq})
    assert (
        next(tool for tool in after.tool_runs if tool.id == queued.start_tool_run_id).status
        == "uncertain"
    )


def test_disconnect_hides_fresh_ready_even_when_old_identity_returns(database, tmp_path):
    service, run, engine, worker = configured_run(database, tmp_path)
    delivery = drain(service, run, worker).delivery
    preview_command(service, delivery, "start", 0)
    worker.run_once()
    assert service.preview(run.id).access.status == "available"
    engine.disconnect(worker.owner)
    assert service.preview(run.id).access.origin is None
    engine.register(worker.owner)
    current = service.preview(run.id)
    assert current.preview_sessions[-1].status == "uncertain"
    assert current.access.origin is None


def test_stop_preserves_confirmed_cleanup_after_a_concurrent_failed_probe(database, tmp_path):
    service, run, engine, worker = configured_run(database, tmp_path)
    delivery = drain(service, run, worker).delivery
    runtime = PreviewRuntime(compiler=engine.package_compiler)
    engine.preview_runtime = runtime
    try:
        preview_command(service, delivery, "start", 0)
        worker.run_once()
        (target,) = engine.preview_probe_targets(worker.owner)
        preview_command(service, delivery, "stop", target.version, session_id=target.id)
        package = service._load_delivery_package(delivery)
        index = package.root / "frontend/dist/index.html"
        original = index.read_bytes()
        index.write_bytes(b"changed")
        try:
            result = runtime.probe(target.id, worker.owner)
            assert result.status == "failed"
            assert engine.record_preview_probe(target, result) is False
            worker.run_once()
            stopped = service.preview(run.id)
            assert (
                stopped.preview_sessions[-1].status == "stopped" and stopped.access.origin is None
            )
        finally:
            index.write_bytes(original)
    finally:
        runtime.close()


def test_invalid_ready_cleanup_and_stop_never_claims_unconfirmed_success(database, tmp_path):
    service, run, engine, worker = configured_run(database, tmp_path)
    delivery = drain(service, run, worker).delivery
    queued = preview_command(service, delivery, "start", 0)
    runtime = engine.preview_runtime
    runtime_start, runtime_stop = runtime.start, runtime.stop

    def invalid_start(request, **options):
        runtime_start(request, **options)
        return RuntimeResult("ready", None, 1, 2)

    runtime.start = invalid_start
    worker.run_once()
    after = service.preview(run.id)
    assert after.access.origin is None
    assert runtime.stops == [(queued.id, worker.owner)]
    assert runtime.sessions == {}
    assert after.preview_sessions[-1].status == "failed"

    runtime.start = runtime_start
    again = preview_command(service, delivery, "start", after.preview_sessions[-1].version)
    worker.run_once()
    ready = service.preview(run.id).preview_sessions[-1]
    assert ready.id == again.id
    stopping = preview_command(service, delivery, "stop", ready.version, session_id=ready.id)
    runtime.stop = lambda *_: RuntimeResult("succeeded")
    worker.run_once()
    snapshot = service.snapshot(run.id)
    tool = next(tool for tool in snapshot.tool_runs if tool.id == stopping.stop_tool_run_id)
    assert tool.status == "uncertain" and tool.exit_code is None
    assert snapshot.preview_sessions[-1].status == "uncertain"
    runtime.stop = runtime_stop
    worker.run_once()
    assert service.preview(run.id).preview_sessions[-1].status == "stopped"


def test_running_pool_renews_preview_health_while_the_owning_slot_is_busy(database, tmp_path):
    service, run, engine, worker = configured_run(database, tmp_path)
    delivery = drain(service, run, worker).delivery
    queued = preview_command(service, delivery, "start", 0)
    provider_entered, release_provider, stopped = Event(), Event(), Event()

    class HeldProvider(TestProvider):
        def run(self, request):
            provider_entered.set()
            assert release_provider.wait(10)
            return super().run(request)

    with WorkerPool(engine, owner="busy-preview", provider=HeldProvider(), slots=1) as pool:
        assert pool.run_once()
        before = service.preview(run.id).access
        assert before.status == "available"
        with database.read() as session:
            original_lease = session.get(PreviewSession, queued.id).lease_expires_at

        service.start_run(run.project_id, StartRun(mode="test"), "make-slot-busy", "test")
        time_source = engine.clock
        clock_offset = timedelta()
        service.clock = engine.clock = lambda: time_source() + clock_offset
        with ThreadPoolExecutor(max_workers=1) as executor:
            runner = executor.submit(pool.run, stopped, poll_seconds=0.05)
            try:
                assert provider_entered.wait(6)
                clock_offset = timedelta(seconds=11)
                deadline = time.monotonic() + 3
                while time.monotonic() < deadline:
                    renewed = service.preview(run.id).access
                    if (
                        renewed.health_checked_at is not None
                        and renewed.health_checked_at
                        > before.health_checked_at + timedelta(seconds=10)
                    ):
                        break
                    stopped.wait(0.05)
                assert not release_provider.is_set()
                assert renewed.status == "available" and renewed.origin == before.origin
                assert renewed.version == before.version
                with database.read() as session:
                    assert session.get(PreviewSession, queued.id).lease_expires_at > original_lease
            finally:
                stopped.set()
                release_provider.set()
            runner.result(timeout=10)
    assert service.preview(run.id).preview_sessions[-1].status == "stopped"
