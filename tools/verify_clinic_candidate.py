"""Check an isolated worker-created test candidate; public Runner remains unavailable."""

import argparse
import importlib.util
import json
import os
import socket
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from pathlib import Path
from urllib.error import URLError
from urllib.request import urlopen

from sqlalchemy.engine import make_url

from codehead.clinic.cache import inspect_dependency_cache
from codehead.clinic.files import normalize_text, text_hash, workspace_path
from codehead.clinic.profile import PROFILE_ROOT, REPOSITORY_ROOT, load_profile
from codehead.clinic.workspace import materialize
from codehead.contracts import CreateProject, DecisionResolution, StartRun
from codehead.persistence.database import Database
from codehead.workflow.worker import Worker
from codehead.workflow.worker_service import WorkerService

MAX_OUTPUT_BYTES = 1048576


def _save(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _environment():
    names = (
        "SYSTEMROOT",
        "WINDIR",
        "TEMP",
        "TMP",
        "PATH",
        "COMSPEC",
        "USERPROFILE",
        "LOCALAPPDATA",
        "APPDATA",
        "HOMEDRIVE",
        "HOMEPATH",
    )
    result = {name: os.environ[name] for name in names if name in os.environ}
    result.update({"PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8", "PYTHONUNBUFFERED": "1"})
    return result


def _tree_factory():
    spec = importlib.util.spec_from_file_location(
        "clinic_check_process_tree", PROFILE_ROOT / "acceptance" / "process_tree.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.ProcessTree


class Capture:
    def __init__(self, command, *, cwd, environment):
        self.tree = _tree_factory()(command, cwd=cwd, env=environment, stdout=subprocess.PIPE)
        self.output = bytearray()
        self.exceeded = threading.Event()
        self.reader = threading.Thread(target=self._collect, daemon=True)
        self.reader.start()

    def _collect(self):
        while chunk := self.tree.stdout.read(4096):
            remaining = MAX_OUTPUT_BYTES - len(self.output)
            self.output.extend(chunk[: max(0, remaining)])
            if len(chunk) > remaining:
                self.exceeded.set()

    def stop(self):
        self.tree.stop()
        self.reader.join(timeout=5)
        if self.reader.is_alive():
            raise RuntimeError("The owned command output did not close.")

    def text(self):
        return self.output.decode("utf-8", errors="replace")


def _run(label, command, *, cwd, environment, report, timeout=180):
    print(f"Checking {label}...", flush=True)
    capture = Capture(command, cwd=cwd, environment=environment)
    deadline = time.monotonic() + timeout
    try:
        while capture.tree.poll() is None:
            if capture.exceeded.is_set():
                raise RuntimeError(f"{label} exceeded the captured output limit.")
            if time.monotonic() >= deadline:
                raise RuntimeError(f"{label} exceeded its time limit.")
            time.sleep(0.05)
        code = capture.tree.poll()
    finally:
        capture.stop()
        (report / f"{label}.log").write_text(capture.text(), encoding="utf-8")
    if capture.exceeded.is_set():
        raise RuntimeError(f"{label} exceeded the captured output limit.")
    print(capture.text(), end="" if capture.text().endswith("\n") else "\n", flush=True)
    if code != 0:
        raise RuntimeError(f"{label} exited with {code}; see the retained log.")
    return capture.text()


def _prepare(service, report):
    project = service.create_project(
        CreateProject(
            name="Clinic Demo", description="Doctors, synthetic patients and appointments."
        ),
        "clinic-check-project",
    )
    run = service.start_run(project.id, StartRun(mode="test"), "clinic-check-start", "clinic-check")
    workers = [Worker(service, owner=f"clinic-check-slot-{index}") for index in range(2)]
    try:
        for _ in range(3):
            workers[0].run_once()
        before = service.snapshot(run.id)
        assert len(before.agent_runs) == 3
        approval = next(item for item in before.decisions if item.kind == "architecture_approval")
        service.resolve_decision(
            approval.id,
            DecisionResolution(version=approval.version, choice="approve"),
            "clinic-check-approve",
            "clinic-check",
        )
        with ThreadPoolExecutor(max_workers=2) as pool:
            for _ in range(12):
                list(pool.map(lambda worker: worker.run_once(), workers))
                current = service.snapshot(run.id)
                if current.candidate and current.candidate.status == "ready":
                    break
                if current.run.status == "blocked":
                    raise AssertionError(current.run.blocked_reason)
            else:
                raise AssertionError("The worker did not produce a ready candidate.")
    finally:
        for worker in workers:
            service.disconnect(worker.owner)
    snapshot = service.snapshot(run.id)
    candidate = snapshot.candidate
    assert candidate is not None and candidate.status == "ready"
    assert len(snapshot.agent_runs) == snapshot.usage.request_count == 5
    assert all(attempt.status == "succeeded" for attempt in snapshot.agent_runs)
    assert snapshot.usage.source == "test" and snapshot.usage.cost_usd == 0
    assert snapshot.run.status == "blocked" and "QA" in snapshot.run.blocked_reason
    tasks = {task.id: task for task in snapshot.tasks}
    assert sum(tasks[attempt.task_id].role == "cto" for attempt in snapshot.agent_runs) == 1
    assert sum(file.origin == "test_injected" for file in candidate.files) == 6
    contents = {
        file.relative_path: service.artifact_content(file.artifact_id).content
        for file in candidate.files
    }
    manifest = service.artifact_content(candidate.manifest_artifact_id).content
    copy = materialize(report / "verification", candidate, contents, manifest)
    _save(report / "snapshot.json", snapshot.model_dump(mode="json"))
    events, cursor = [], 0
    while True:
        page = service.events(run.id, after_seq=cursor, limit=200)
        events.extend(event.model_dump(mode="json") for event in page.events)
        if not page.events or len(page.events) < 200:
            break
        cursor = page.events[-1].seq
    _save(report / "events.json", events)
    return candidate, contents, manifest, copy


def _verify_copy(root, candidate, contents, manifest):
    expected = {file.relative_path: (file.byte_size, file.content_hash) for file in candidate.files}
    expected[".codehead/manifest.json"] = (candidate.manifest_byte_size, candidate.manifest_hash)
    for relative, (size, digest) in expected.items():
        path = workspace_path(root, relative)
        maximum = 2 * size + 3
        with path.open("rb") as stream:
            assert os.fstat(stream.fileno()).st_size <= maximum
            data = stream.read(maximum + 1)
        assert len(data) <= maximum
        normalized = normalize_text(data.decode("utf-8", errors="strict"))
        assert len(normalized.encode("utf-8")) == size and text_hash(normalized) == digest
        assert normalized == (
            manifest if relative == ".codehead/manifest.json" else contents[relative]
        )


def _assert_listener_stopped(port):
    command = (
        f"(Get-NetTCPConnection -State Listen -LocalPort {int(port)} "
        "-ErrorAction SilentlyContinue | Measure-Object).Count"
    )
    result = subprocess.run(
        ["powershell.exe", "-NoProfile", "-Command", command],
        capture_output=True,
        text=True,
        check=True,
        timeout=20,
        creationflags=subprocess.CREATE_NO_WINDOW,
    )
    if int(result.stdout.strip()) != 0:
        raise RuntimeError("The owned Clinic frontend is still accepting connections.")


def _browser_checks(frontend, cache, environment, report):
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    command = [
        str(cache.node_executable),
        str(cache.node_modules / "vite/bin/vite.js"),
        "--host",
        "127.0.0.1",
        "--port",
        str(port),
        "--strictPort",
    ]
    server = Capture(command, cwd=frontend, environment=environment)
    url = f"http://127.0.0.1:{port}"
    try:
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            if server.tree.poll() is not None or server.exceeded.is_set():
                raise RuntimeError("The owned Clinic frontend server failed to start.")
            try:
                with urlopen(url, timeout=0.5) as response:
                    if response.status == 200:
                        break
            except (OSError, URLError):
                time.sleep(0.1)
        else:
            raise RuntimeError("The owned Clinic frontend server did not become ready.")
        images = report / "frontend-images"
        images.mkdir()
        _run(
            "frontend-behavior",
            [
                str(Path(sys.base_prefix) / "python.exe"),
                str(REPOSITORY_ROOT / "tests/clinic/test_frontend.py"),
            ],
            cwd=REPOSITORY_ROOT,
            environment=environment
            | {
                "CODEHEAD_CLINIC_BASE_URL": url,
                "CODEHEAD_CLINIC_TEST_REPORT_DIR": str(images),
            },
            report=report,
        )
    finally:
        server.stop()
        (report / "frontend-server.log").write_text(server.text(), encoding="utf-8")
    _assert_listener_stopped(port)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--schema", required=True)
    parser.add_argument("--report-root", type=Path, required=True)
    args = parser.parse_args()
    url = os.environ["CODEHEAD_TEST_DATABASE_URL"]
    if not (make_url(url).database or "").endswith("_test"):
        raise SystemExit("Only an explicit isolated test database is allowed.")
    report = args.report_root.absolute()
    report.mkdir(parents=True, exist_ok=True)
    profile = load_profile()
    cache = inspect_dependency_cache(profile)
    _save(report / "dependency-cache.json", cache.to_dict())
    if cache.status != "available":
        raise SystemExit("dependency_unavailable; inspect dependency-cache.json.")
    database = Database(url, schema=args.schema)
    service = WorkerService(database, workspace_root=report / "candidates")
    try:
        candidate, contents, manifest, copy = _prepare(service, report)
        assert (
            candidate.profile_hash,
            candidate.acceptance_suite_hash,
            candidate.template_hash,
        ) == (
            profile.profile_hash,
            profile.suite_hash,
            profile.template_hash,
        )
        metadata = {
            "candidate": candidate.model_dump(mode="json"),
            "schema": args.schema,
            "verification_root": str(copy),
            "origin": "test_injected",
        }
        _save(report / "candidate.json", metadata)
        environment = _environment() | {"CODEHEAD_CLINIC_NODE_MODULES": str(cache.node_modules)}
        frontend = copy / "frontend"
        _run(
            "frontend-typecheck",
            [
                str(cache.node_executable),
                str(cache.node_modules / "typescript/bin/tsc"),
                "--noEmit",
            ],
            cwd=frontend,
            environment=environment,
            report=report,
        )
        _run(
            "frontend-build",
            [str(cache.node_executable), str(cache.node_modules / "vite/bin/vite.js"), "build"],
            cwd=frontend,
            environment=environment,
            report=report,
        )
        _browser_checks(frontend, cache, environment, report)
        output = _run(
            "http",
            [
                str(cache.python_executable),
                str(PROFILE_ROOT / "acceptance/run_suite.py"),
                "--candidate-root",
                str(copy),
            ],
            cwd=REPOSITORY_ROOT,
            environment=environment,
            report=report,
        )
        result = json.loads(output.strip().splitlines()[-1])
        assert result["status"] == "passed"
        assert (
            result["profile_hash"] == profile.profile_hash
            and result["suite_hash"] == profile.suite_hash
        )
        (report / "http.json").write_bytes(Path(result["report"]).read_bytes())
        assert materialize(report / "candidates", candidate, contents, manifest) == Path(
            candidate.workspace_path
        )
        _verify_copy(copy, candidate, contents, manifest)
        after = load_profile()
        assert (after.profile_hash, after.suite_hash, after.template_hash) == (
            profile.profile_hash,
            profile.suite_hash,
            profile.template_hash,
        )
        _save(
            report / "summary.json",
            {
                "status": "passed",
                "finished_at": datetime.now(UTC).isoformat(),
                "run_id": candidate.run_id,
                "candidate_id": candidate.id,
                "revision": candidate.revision,
                "origin": "test_injected",
                "calls": 5,
                "profile_hash": profile.profile_hash,
                "suite_hash": profile.suite_hash,
                "template_hash": profile.template_hash,
                "tree_hash": candidate.tree_hash,
                "source_integrity": "verified",
                "frontend_typecheck": "passed",
                "frontend_build": "passed",
                "frontend_behavior": "passed; controlled HTTP responses",
                "http": "passed",
                "isolation_level": "process_only",
                "public_runner": "unavailable",
                "preview": "unavailable",
            },
        )
        print(
            f"Clinic candidate verified: 5 test attempts, revision {candidate.revision}; "
            "HTTP/type/build/browser passed.",
            flush=True,
        )
        return 0
    finally:
        database.close()


if __name__ == "__main__":
    raise SystemExit(main())
