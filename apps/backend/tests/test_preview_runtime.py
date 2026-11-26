import hashlib
import http.client
import importlib
import json
import socket
import subprocess
import time
from contextlib import closing
from dataclasses import replace
from urllib.parse import urlsplit
from uuid import uuid4

import pytest
from test_delivery_package import real_build as real_build

from codehead.delivery.package import PackageCompiler, PackageRequest

UI_ORIGIN = "http://127.0.0.1:5181"


@pytest.fixture(scope="module")
def package(real_build, tmp_path_factory):
    build, report, tool_root = real_build
    compiler = PackageCompiler(tool_root, tmp_path_factory.mktemp("preview-packages"))
    value = compiler.publish(
        PackageRequest(
            str(uuid4()),
            1,
            build.candidate,
            build.contents,
            build.manifest_content,
            build.tool_run_id,
            report,
        )
    )
    return compiler, value


@pytest.fixture
def setup_preview(package, tmp_path):
    module = importlib.import_module("codehead.delivery.runtime")
    compiler, value = package
    runtime = module.PreviewRuntime(compiler=compiler, frame_origins=(UI_ORIGIN,))
    request = module.RuntimeRequest(str(uuid4()), value, tmp_path / "data", "worker-boot")
    try:
        yield runtime, request
    finally:
        runtime.close()


def request(origin, method, path, *, body=None, headers=None):
    target = urlsplit(origin)
    with closing(http.client.HTTPConnection(target.hostname, target.port, timeout=5)) as connection:
        connection.request(
            method, path, body=body, headers={"Host": target.netloc} | (headers or {})
        )
        response = connection.getresponse()
        return response.status, dict(response.getheaders()), response.read()


def test_smoke_launches_health_and_production_index_and_stops(setup_preview):
    runtime, value = setup_preview
    smoke = runtime.smoke(value)
    assert smoke.status == "passed", smoke
    assert smoke.origin is None and not runtime.owns(value.preview_id, value.owner_boot)
    assert smoke.report["health_status"] == smoke.report["index_status"] == 200
    assert smoke.report["package_tree_hash"] == value.package.tree_hash
    assert smoke.report["owned_processes_stopped"] is True
    assert not runtime.owns(value.preview_id, value.owner_boot)


def test_preview_serves_verified_files_and_preserves_sqlite_when_reopened(setup_preview):
    runtime, value = setup_preview
    started = runtime.start(value)
    assert started.status == "ready", started
    assert started.backend_pid > 0 and started.bridge_pid > 0
    assert started.backend_pid != started.bridge_pid
    assert runtime.probe(value.preview_id, value.owner_boot).origin == started.origin
    status, headers, html = request(started.origin, "GET", "/")
    index = next(item for item in value.package.files if item.path == "frontend/dist/index.html")
    assert status == 200 and hashlib.sha256(html).hexdigest() == index.sha256
    assert headers["X-Content-Type-Options"] == "nosniff"
    assert f"frame-ancestors {UI_ORIGIN}" in headers["Content-Security-Policy"]
    assert started.origin in headers["Content-Security-Policy"]
    status, headers, _ = request(
        started.origin,
        "OPTIONS",
        "/api/doctors",
        headers={
            "Origin": "null",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type",
        },
    )
    assert status == 204 and headers["Access-Control-Allow-Origin"] == "null"
    assert "Access-Control-Allow-Credentials" not in headers
    status, _, payload = request(
        started.origin,
        "POST",
        "/api/doctors",
        body=json.dumps({"name": "Ada", "specialty": "GP"}),
        headers={"Origin": "null", "Content-Type": "application/json"},
    )
    assert status == 201
    doctor = json.loads(payload)
    assert runtime.stop(value.preview_id, "foreign-worker").status == "uncertain"
    assert request(started.origin, "GET", "/health")[0] == 200
    assert runtime.stop(value.preview_id, value.owner_boot).status == "stopped"
    with pytest.raises(OSError):
        request(started.origin, "GET", "/health")
    restarted = runtime.start(replace(value, preview_id=str(uuid4())))
    assert restarted.status == "ready", restarted
    assert json.loads(request(restarted.origin, "GET", "/api/doctors")[2]) == [doctor]
    smoke = runtime.smoke(replace(value, preview_id=str(uuid4())))
    assert smoke.status == "passed", smoke
    assert smoke.report["fresh_database"] is True


@pytest.mark.parametrize(
    ("path", "headers", "expected"),
    [
        ("/", {"Host": "localhost:80"}, 403),
        ("/api/doctors", {"Origin": "https://unrelated.example"}, 403),
        ("/.codehead/package.json", {}, 404),
        ("/backend/main.py", {}, 404),
        ("/package.zip", {}, 404),
        ("/assets/../index.html", {}, 400),
        ("/assets/%2e%2e/index.html", {}, 400),
        ("http://other.local/", {}, 400),
    ],
)
def test_preview_limits_request_scope(setup_preview, path, headers, expected):
    runtime, value = setup_preview
    started = runtime.start(value)
    assert started.status == "ready", started
    assert request(started.origin, "GET", path, headers=headers)[0] == expected


def test_preview_does_not_take_an_occupied_loopback_port(setup_preview):
    runtime, value = setup_preview
    with socket.socket() as occupied:
        occupied.bind(("127.0.0.1", 0))
        occupied.listen()
        started = runtime.start(value)
        assert started.status == "ready", started
        assert urlsplit(started.origin).port != occupied.getsockname()[1]
        assert runtime.stop(str(uuid4()), value.owner_boot).status == "uncertain"
        assert request(started.origin, "GET", "/health")[0] == 200


def test_preview_refuses_a_damaged_package(package, tmp_path):
    module = importlib.import_module("codehead.delivery.runtime")
    compiler, value = package
    asset = value.root / "frontend/dist/index.html"
    original = asset.read_bytes()
    asset.write_bytes(b"changed")
    runtime = module.PreviewRuntime(compiler=compiler)
    try:
        result = runtime.start(module.RuntimeRequest(str(uuid4()), value, tmp_path, "worker"))
        assert result.status == "failed" and result.error_code == "package_changed"
        assert result.origin is None and result.backend_pid is None and result.bridge_pid is None
    finally:
        asset.write_bytes(original)
        runtime.close()


def test_preview_refuses_unknown_files_before_reopening_old_data(setup_preview):
    runtime, value = setup_preview
    assert runtime.start(value).status == "ready"
    assert runtime.stop(value.preview_id, value.owner_boot).status == "stopped"
    backend = value.data_root / "interactive" / value.package.package_id / "g1/backend"
    (backend / "unknown.py").write_text("# An unpinned file\n", encoding="utf-8")
    restarted = runtime.start(replace(value, preview_id=str(uuid4())))
    assert restarted.status == "failed" and restarted.error_code == "package_changed"
    assert restarted.backend_pid is None


def test_preview_does_not_dispatch_after_cache_probe_exhausts_deadline(setup_preview):
    runtime, value = setup_preview
    inspect = runtime.cache_inspector
    dispatches = []

    def delayed(profile):
        time.sleep(1.1)
        return inspect(profile)

    factory = importlib.import_module("codehead.runner.processes").process_tree_factory()

    def record(*args, **kwargs):
        dispatches.append(args)
        return factory(*args, **kwargs)

    runtime.cache_inspector = delayed
    runtime.factory = record
    started = runtime.start(value, timeout_seconds=1)
    assert started.status == "timed_out" and started.error_code == "tool_timeout"
    assert dispatches == []


def test_job_cleanup_uncertainty_cannot_become_a_successful_retry(setup_preview):
    runtime, value = setup_preview
    factory = importlib.import_module("codehead.runner.processes").process_tree_factory()

    def fail_after_cleanup(*args, **kwargs):
        tree = factory(*args, **kwargs)
        stop = tree.stop

        def fail_once():
            stop()
            tree.stop = stop
            raise subprocess.SubprocessError("Synthetic Job accounting failure")

        tree.stop = fail_once
        return tree

    runtime.factory = fail_after_cleanup
    assert runtime.start(value).status == "ready"
    assert runtime.stop(value.preview_id, value.owner_boot).status == "uncertain"
    assert runtime.stop(value.preview_id, value.owner_boot).status == "uncertain"


def test_stop_can_confirm_a_preview_already_closed_by_its_probe(setup_preview):
    runtime, value = setup_preview
    started = runtime.start(value)
    assert started.status == "ready"
    index = value.package.root / "frontend/dist/index.html"
    saved = index.read_bytes()
    index.write_bytes(b"changed")
    try:
        assert runtime.probe(value.preview_id, value.owner_boot).status == "failed"
        assert not runtime.owns(value.preview_id, value.owner_boot)
        assert runtime.stop(value.preview_id, "foreign").status == "uncertain"
        reply = runtime.stop(value.preview_id, value.owner_boot)
        assert reply.status == "stopped"
        assert (reply.backend_pid, reply.bridge_pid) == (started.backend_pid, started.bridge_pid)
    finally:
        index.write_bytes(saved)
