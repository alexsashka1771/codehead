"""Trusted HTTP-only fixtures; candidate Python is never imported here."""

import importlib.util
import json
import os
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path

import pytest

TRUSTED_ROOT = Path(__file__).resolve().parent
FIXED_NOW = "2030-01-01T00:00:00Z"
MAX_RESPONSE_BYTES = 65536
MAX_PROCESS_OUTPUT_BYTES = 65536

_process_spec = importlib.util.spec_from_file_location(
    "clinic_trusted_process_tree", TRUSTED_ROOT / "process_tree.py"
)
_process_module = importlib.util.module_from_spec(_process_spec)
_process_spec.loader.exec_module(_process_module)
ProcessTree = _process_module.ProcessTree


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


@dataclass(frozen=True)
class HttpResponse:
    status: int
    body: object


def pytest_addoption(parser):
    parser.addoption("--clinic-candidate", type=Path, help="A committed Clinic candidate workspace")
    parser.addoption(
        "--clinic-python", type=Path, help="The verified Python dependency cache executable"
    )


class ClinicHTTP:
    def __init__(self, source_root: Path, workspace: Path, python: Path):
        self.workspace = workspace
        self.python = python
        shutil.copytree(
            source_root / "backend",
            workspace / "backend",
            ignore=shutil.ignore_patterns("__pycache__", "*.pyc", ".data", "node_modules"),
        )
        self.database_path = workspace / ".data" / "clinic.sqlite3"
        self._tree = None
        self._output = bytearray()
        self._output_exceeded = threading.Event()
        self._reader = None
        self._start(FIXED_NOW)

    @property
    def output(self) -> str:
        return self._output.decode("utf-8", errors="replace")

    def _collect_output(self):
        while chunk := self._tree.stdout.read(4096):
            remaining = MAX_PROCESS_OUTPUT_BYTES - len(self._output)
            self._output.extend(chunk[: max(0, remaining)])
            if len(chunk) > remaining:
                self._output_exceeded.set()

    def _start(self, fixed_now: str):
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            self.port = listener.getsockname()[1]
        environment = {
            name: os.environ[name]
            for name in ("SYSTEMROOT", "WINDIR", "TEMP", "TMP")
            if name in os.environ
        }
        environment.update(
            {
                "PYTHONUTF8": "1",
                "PYTHONIOENCODING": "utf-8",
                "PYTHONUNBUFFERED": "1",
                "CLINIC_DATABASE_PATH": str(self.database_path),
                "CLINIC_TEST_NOW": fixed_now,
                "CLINIC_PORT": str(self.port),
            }
        )
        self._output.clear()
        self._output_exceeded.clear()
        self._tree = ProcessTree(
            [str(self.python), str(self.workspace / "backend" / "main.py")],
            cwd=self.workspace,
            env=environment,
            stdout=subprocess.PIPE,
        )
        self._reader = threading.Thread(target=self._collect_output, daemon=True)
        self._reader.start()
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            if self._tree.poll() is not None or self._output_exceeded.is_set():
                break
            try:
                response = self.request("GET", "/health")
            except urllib.error.URLError:
                time.sleep(0.05)
                continue
            if response.status == 200 and response.body == {"status": "ok"}:
                return
            time.sleep(0.05)
        output = self.output
        self.stop()
        raise AssertionError(
            f"The candidate did not become ready on its owned loopback port.\n{output}"
        )

    def request(self, method: str, path: str, body=None) -> HttpResponse:
        assert path.startswith("/"), "The suite sends only fixed application paths."
        data = None if body is None else json.dumps(body, ensure_ascii=False).encode("utf-8")
        request = urllib.request.Request(
            f"http://127.0.0.1:{self.port}{path}",
            data=data,
            method=method,
            headers={"Content-Type": "application/json", "Connection": "close"},
        )
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())
        try:
            response = opener.open(request, timeout=5)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            content = response.read(MAX_RESPONSE_BYTES + 1)
            assert len(content) <= MAX_RESPONSE_BYTES, (
                "The HTTP response exceeded the trusted limit."
            )
            assert response.headers.get_content_type() == "application/json"
            parsed = json.loads(content.decode("utf-8"))
            return HttpResponse(response.status, parsed)

    def expect(self, method: str, path: str, body=None, *, status: int = 200):
        response = self.request(method, path, body)
        assert response.status == status, f"{method} {path}: {response.status}, {response.body}"
        return response.body

    def restart(self, fixed_now: str):
        """Only this trusted process controls time; no candidate HTTP time command exists."""
        self.stop()
        self._start(fixed_now)

    def stop(self):
        if self._tree is not None:
            self._tree.stop()
            if self._reader is not None:
                self._reader.join(timeout=5)


@pytest.fixture
def clinic(request, tmp_path):
    source_root = request.config.getoption("--clinic-candidate")
    if source_root is None:
        raise pytest.UsageError(
            "The independent suite requires --clinic-candidate; no fake app is used."
        )
    source_root = source_root.resolve()
    if not (source_root / "backend" / "main.py").is_file():
        raise pytest.UsageError("The candidate has no trusted backend/main.py entry point.")
    python = request.config.getoption("--clinic-python") or Path(sys.executable)
    application = ClinicHTTP(source_root, tmp_path / "candidate", python.resolve())
    try:
        yield application
    finally:
        application.stop()
        assert not application._output_exceeded.is_set(), (
            "The candidate exceeded its process output limit."
        )
