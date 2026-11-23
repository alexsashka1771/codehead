import ctypes
import importlib.util
import io
import json
import os
import signal
import socket
import subprocess
import sys
import time
from contextlib import nullcontext
from ctypes import wintypes
from pathlib import Path
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[3]
pytestmark = pytest.mark.skipif(os.name != "nt", reason="Windows process ownership regression")
WAIT_OBJECT_0 = 0
WAIT_TIMEOUT = 258


def test_enabled_worker_readiness_waits_for_actual_heartbeat(supervisor, monkeypatch):
    class Stop:
        waits = 0

        def is_set(self):
            return False

        def wait(self, _):
            self.waits += 1

    stopped = Stop()

    def open_response(url, timeout):
        response = io.BytesIO(
            json.dumps(
                {
                    "database": "ready",
                    "command_security": "ready",
                    "stage": "foundation" if stopped.waits == 0 else "worker",
                }
            ).encode()
        )
        response.status = 200
        return response

    monkeypatch.setattr(supervisor, "urlopen", open_response)
    supervisor.wait_until_ready(
        [SimpleNamespace(poll=lambda: None)] * 3, 19011, 19012, stopped, worker_enabled=True
    )
    assert stopped.waits == 1


LEAF_SOURCE = """
import os
import socket

with socket.create_connection(("127.0.0.1", int(os.environ["CODEHEAD_PROBE_PORT"])),
                              timeout=30) as connection:
    connection.sendall(f"{os.getpid()}\\n".encode("ascii"))
    connection.recv(1)
"""


def windows_api():
    api = ctypes.WinDLL("kernel32", use_last_error=True)
    api.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    api.OpenProcess.restype = wintypes.HANDLE
    api.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    api.WaitForSingleObject.restype = wintypes.DWORD
    api.TerminateProcess.argtypes = [wintypes.HANDLE, wintypes.UINT]
    api.TerminateProcess.restype = wintypes.BOOL
    api.CloseHandle.argtypes = [wintypes.HANDLE]
    api.CloseHandle.restype = wintypes.BOOL
    return api


@pytest.fixture
def supervisor(monkeypatch):
    monkeypatch.syspath_prepend(str(ROOT / "tools"))
    spec = importlib.util.spec_from_file_location("codehead_dev", ROOT / "tools" / "dev.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    previous_handlers = {sig: signal.getsignal(sig) for sig in (signal.SIGINT, signal.SIGTERM)}
    yield module
    for sig, handler in previous_handlers.items():
        signal.signal(sig, handler)


@pytest.fixture
def process_probe(monkeypatch):
    api = windows_api()
    connections = []
    owned_handles = []

    def open_handle(pid):
        handle = api.OpenProcess(0x00100001, False, pid)
        assert handle, ctypes.WinError(ctypes.get_last_error())
        owned_handles.append(handle)
        return handle

    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        listener.listen(2)
        listener.settimeout(10)
        monkeypatch.setenv("CODEHEAD_PROBE_PORT", str(listener.getsockname()[1]))

        def capture():
            connection, _ = listener.accept()
            connections.append(connection)
            with connection.makefile("rb") as incoming:
                return open_handle(int(incoming.readline()))

        try:
            yield SimpleNamespace(
                api=api,
                capture=capture,
                open_handle=open_handle,
                handles=owned_handles,
            )
        finally:
            # EOF releases even a leaf whose handle was not captured before a test failure.
            for connection in connections:
                connection.close()
            listener.close()
            for handle in owned_handles:
                if api.WaitForSingleObject(handle, 5000) == WAIT_TIMEOUT:
                    api.TerminateProcess(handle, 1)
                    api.WaitForSingleObject(handle, 5000)
                api.CloseHandle(handle)


@pytest.fixture
def launch_owner():
    owners = []

    def launch(source):
        owner = subprocess.Popen(
            [str(Path(sys.base_prefix) / "python.exe"), "-I", "-S", "-X", "utf8", "-c", source],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            creationflags=subprocess.CREATE_NO_WINDOW,
            shell=False,
        )
        owners.append(owner)
        return owner

    try:
        yield launch
    finally:
        for owner in owners:
            if owner.poll() is None:
                owner.kill()
            owner.wait(timeout=10)
            owner.stdin.close()
            owner.stdout.close()


@pytest.mark.parametrize("parent_exits", [True, False], ids=["exited-parent", "running-parent"])
def test_stop_reaps_own_descendants(supervisor, process_probe, monkeypatch, tmp_path, parent_exits):
    api = process_probe.api
    parent_source = (
        "import os, subprocess, sys, time\n"
        f"subprocess.Popen([sys.executable, '-c', {LEAF_SOURCE!r}], "
        "stdin=subprocess.DEVNULL, creationflags=subprocess.CREATE_NO_WINDOW)\n"
        + ("os._exit(23)\n" if parent_exits else "time.sleep(30)\n")
    )
    (tmp_path / "uvicorn.py").write_text(parent_source, encoding="utf-8")
    vite = tmp_path / "node_modules" / "vite" / "bin" / "vite.js"
    vite.parent.mkdir(parents=True)
    vite.write_text(parent_source, encoding="utf-8")
    frontend = tmp_path / "apps" / "frontend"
    frontend.mkdir(parents=True)
    monkeypatch.setattr(supervisor, "ROOT", tmp_path)
    monkeypatch.setattr(supervisor, "PYTHON", Path(sys.executable))
    monkeypatch.setattr(supervisor.shutil, "which", lambda _: sys.executable)
    monkeypatch.setattr(supervisor, "checked", lambda *args: None)
    monkeypatch.setattr(supervisor, "assert_port_free", lambda _: None)
    monkeypatch.setenv("PYTHONPATH", str(tmp_path))
    unrelated = subprocess.Popen(
        [sys.executable, "-c", "import time; time.sleep(30)"],
        creationflags=subprocess.CREATE_NO_WINDOW,
        shell=False,
    )

    def request_stop(processes, api_port, frontend_port, stopped):
        for _ in processes:
            handle = process_probe.capture()
            assert api.WaitForSingleObject(handle, 0) == WAIT_TIMEOUT
        for process in processes:
            if parent_exits:
                assert process.wait(timeout=10) == 23
            else:
                assert process.poll() is None
        if parent_exits:
            raise RuntimeError("Synthetic parent exited during startup")
        stopped.set()

    monkeypatch.setattr(supervisor, "wait_until_ready", request_stop)
    expectation = (
        pytest.raises(RuntimeError, match="Synthetic parent exited")
        if parent_exits
        else nullcontext()
    )
    try:
        with expectation:
            supervisor.supervise(
                SimpleNamespace(api_port=19011, frontend_port=19012, stdin_control=False)
            )
        for handle in process_probe.handles:
            assert api.WaitForSingleObject(handle, 2000) == WAIT_OBJECT_0, (
                "The owned descendant is still alive after its parent exited and cleanup ran"
            )
        assert unrelated.poll() is None, "Cleanup must leave unrelated processes running"
    finally:
        if unrelated.poll() is None:
            unrelated.terminate()
        unrelated.wait(timeout=10)


def test_abrupt_supervisor_exit_reaps_orphaned_descendants(process_probe, launch_owner):
    parent_source = (
        "import os, subprocess, sys\n"
        f"subprocess.Popen([sys.executable, '-c', {LEAF_SOURCE!r}], "
        "stdin=subprocess.DEVNULL, creationflags=subprocess.CREATE_NO_WINDOW)\n"
        "os._exit(23)\n"
    )
    owner_source = (
        "import os, sys\n"
        f"sys.path.insert(0, {str(ROOT / 'tools')!r})\n"
        "from process_tree import ProcessTree\n"
        f"tree = ProcessTree([sys.executable, '-c', {parent_source!r}], "
        f"cwd={str(ROOT)!r}, env=dict(os.environ))\n"
        "assert tree.wait(timeout=10) == 23\n"
        "print('ready', flush=True)\n"
        "sys.stdin.buffer.read(1)\n"
    )
    owner = launch_owner(owner_source)
    descendant = process_probe.capture()
    assert owner.stdout.readline() == b"ready\r\n"
    assert process_probe.api.WaitForSingleObject(descendant, 0) == WAIT_TIMEOUT
    owner.kill()
    owner.wait(timeout=10)
    assert process_probe.api.WaitForSingleObject(descendant, 2000) == WAIT_OBJECT_0


def test_assignment_failure_never_starts_target(supervisor, process_probe, monkeypatch, tmp_path):
    import process_tree

    marker = tmp_path / "unexpected launch.txt"
    command = [
        sys.executable,
        "-c",
        "from pathlib import Path; import sys; Path(sys.argv[1]).write_text('started')",
        str(marker),
    ]

    def assignment_denied(job, pid):
        process_probe.open_handle(pid)
        time.sleep(0.25)
        assert not marker.exists(), "The target started before its job was assigned"
        raise OSError("Synthetic job assignment denied")

    monkeypatch.setattr(process_tree.WindowsJob, "assign", assignment_denied)
    with pytest.raises(OSError, match="Synthetic job assignment denied"):
        supervisor.ProcessTree(command, cwd=tmp_path, env=dict(os.environ))
    assert not marker.exists()
    assert len(process_probe.handles) == 1
    assert process_probe.api.WaitForSingleObject(process_probe.handles[0], 2000) == WAIT_OBJECT_0


def test_supervisor_exit_before_assignment_cancels_launch(process_probe, launch_owner, tmp_path):
    marker = tmp_path / "unexpected launch.txt"
    command = [
        sys.executable,
        "-c",
        "from pathlib import Path; import sys; Path(sys.argv[1]).write_text('started')",
        str(marker),
    ]
    owner_source = (
        "import os, sys\n"
        f"sys.path.insert(0, {str(ROOT / 'tools')!r})\n"
        "from process_tree import ProcessTree, WindowsJob\n"
        "def pause_before_assignment(self, pid):\n"
        "    print(pid, flush=True)\n"
        "    sys.stdin.buffer.read(1)\n"
        "WindowsJob.assign = pause_before_assignment\n"
        f"tree = ProcessTree({command!r}, cwd={str(tmp_path)!r}, env=dict(os.environ))\n"
    )
    owner = launch_owner(owner_source)
    wrapper = process_probe.open_handle(int(owner.stdout.readline()))
    assert process_probe.api.WaitForSingleObject(wrapper, 0) == WAIT_TIMEOUT
    time.sleep(0.25)
    assert not marker.exists(), "The target started without job assignment"
    owner.kill()
    owner.wait(timeout=10)
    assert process_probe.api.WaitForSingleObject(wrapper, 2000) == WAIT_OBJECT_0
    assert not marker.exists()


def test_launch_preserves_arguments_and_exit_code(supervisor, tmp_path):
    output = tmp_path / "quoted arguments.json"
    arguments = [
        "two words",
        'double"quote',
        "literal; & $()",
        "Unicode: \u041f\u0440\u0438\u0432\u0435\u0442",
    ]
    command = [
        sys.executable,
        "-X",
        "utf8",
        "-c",
        "import json, sys; from pathlib import Path; "
        "Path(sys.argv[1]).write_text(json.dumps(sys.argv[2:]), encoding='utf-8'); sys.exit(17)",
        str(output),
        *arguments,
    ]
    process = supervisor.ProcessTree(command, cwd=tmp_path, env=dict(os.environ))
    try:
        assert process.wait(timeout=10) == 17
        assert json.loads(output.read_text(encoding="utf-8")) == arguments
    finally:
        process.stop()
    process.stop()
