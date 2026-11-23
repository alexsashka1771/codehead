"""Supervise local CodeHead processes without shell commands or persisted secrets."""

import argparse
import json
import os
import secrets
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
from contextlib import ExitStack
from pathlib import Path
from urllib.error import URLError
from urllib.request import urlopen

from process_tree import ProcessTree

ROOT = Path(__file__).resolve().parents[1]
PYTHON = ROOT / ".venv" / "Scripts" / "python.exe"
LOCAL_DATABASE_URL = "postgresql+psycopg://codehead@127.0.0.1:55432/codehead"


def checked(command, environment):
    subprocess.run(command, cwd=ROOT, env=environment, check=True, shell=False)


def assert_port_free(port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        try:
            listener.bind(("127.0.0.1", port))
        except OSError as exc:
            raise RuntimeError(
                f"Port {port} is occupied; the existing process was not modified."
            ) from exc


def stop_process(process):
    process.stop()


def wait_until_ready(processes, api_port, frontend_port, stopped, *, worker_enabled=False):
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline and not stopped.is_set():
        if any(process.poll() is not None for process in processes):
            raise RuntimeError("A CodeHead child process exited during startup.")
        try:
            with urlopen(f"http://127.0.0.1:{api_port}/health", timeout=1) as response:
                health = json.load(response)
            with urlopen(f"http://127.0.0.1:{frontend_port}", timeout=1) as response:
                ui_ready = response.status == 200
            if (
                health.get("database") == "ready"
                and health.get("command_security") == "ready"
                and ui_ready
                and (not worker_enabled or health.get("stage") == "worker")
            ):
                return
        except (URLError, TimeoutError):
            pass
        stopped.wait(0.25)
    raise RuntimeError("CodeHead readiness check was interrupted or timed out.")


def supervise(args):
    node = shutil.which("node")
    if not node or not PYTHON.exists() or not (ROOT / "node_modules").is_dir():
        raise RuntimeError("Missing local dependencies. Run npm run setup first.")
    if args.api_port == args.frontend_port:
        raise RuntimeError("API and frontend require separate loopback ports.")
    assert_port_free(args.api_port)
    assert_port_free(args.frontend_port)
    environment = dict(os.environ, PYTHONUTF8="1", PYTHONIOENCODING="utf-8", PYTHONUNBUFFERED="1")
    if not environment.get("CODEHEAD_DATABASE_URL", "").strip():
        checked([node, str(ROOT / "tools" / "postgres.mjs")], environment)
        environment["CODEHEAD_DATABASE_URL"] = LOCAL_DATABASE_URL
    # Tokens are created for this API process only, never written to disk or logged.
    environment["CODEHEAD_COMMAND_TOKEN"] = secrets.token_urlsafe(32)
    environment["CODEHEAD_API_PORT"] = str(args.api_port)
    environment["CODEHEAD_ALLOWED_ORIGINS"] = json.dumps(
        [
            f"http://127.0.0.1:{args.frontend_port}",
            f"http://localhost:{args.frontend_port}",
            f"http://127.0.0.1:{args.api_port}",
            f"http://localhost:{args.api_port}",
        ]
    )
    checked([str(PYTHON), "-m", "codehead.migrate"], environment)
    stopped = threading.Event()
    signal.signal(signal.SIGINT, lambda *_: stopped.set())
    signal.signal(signal.SIGTERM, lambda *_: stopped.set())
    if args.stdin_control:

        def read_control():
            for line in sys.stdin:
                if line.strip() == "stop":
                    stopped.set()
                    return
            stopped.set()

        threading.Thread(target=read_control, daemon=True).start()
    processes = []
    try:
        processes.append(
            ProcessTree(
                [
                    str(PYTHON),
                    "-m",
                    "uvicorn",
                    "codehead.main:create_app",
                    "--factory",
                    "--host",
                    "127.0.0.1",
                    "--port",
                    str(args.api_port),
                    "--log-level",
                    "warning",
                ],
                cwd=ROOT,
                env=environment,
            )
        )
        if not getattr(args, "no_worker", True):
            processes.append(
                ProcessTree([str(PYTHON), "-m", "codehead.worker"], cwd=ROOT, env=environment)
            )
        frontend_environment = {
            key: value
            for key, value in environment.items()
            if not any(
                word in key.upper()
                for word in ("TOKEN", "SECRET", "PASSWORD", "API_KEY", "DATABASE_URL")
            )
        }
        processes.append(
            ProcessTree(
                [
                    node,
                    str(ROOT / "node_modules" / "vite" / "bin" / "vite.js"),
                    "--host",
                    "127.0.0.1",
                    "--port",
                    str(args.frontend_port),
                    "--strictPort",
                ],
                cwd=ROOT / "apps" / "frontend",
                env=frontend_environment,
            )
        )
        if not getattr(args, "no_worker", True):
            wait_until_ready(
                processes, args.api_port, args.frontend_port, stopped, worker_enabled=True
            )
        else:
            wait_until_ready(processes, args.api_port, args.frontend_port, stopped)
        print(f"\nCodeHead: http://127.0.0.1:{args.frontend_port}", flush=True)
        print(
            "Explicit test worker; live unavailable. Ctrl+C stops owned processes."
            if not getattr(args, "no_worker", True)
            else "Foundation queue; worker disabled for this server. Ctrl+C stops API and UI.",
            flush=True,
        )
        while not stopped.wait(0.25):
            if any(process.poll() is not None for process in processes):
                raise RuntimeError("A CodeHead child exited; stopping the remaining process.")
    finally:
        with ExitStack() as cleanup:
            for process in processes:
                cleanup.callback(stop_process, process)
        print("CodeHead processes stopped. PostgreSQL data is retained.", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--api-port", type=int, default=8010)
    parser.add_argument("--frontend-port", type=int, default=5180)
    parser.add_argument("--stdin-control", action="store_true")
    parser.add_argument("--no-worker", action="store_true")
    args = parser.parse_args()
    if not all(1024 <= port <= 65535 for port in (args.api_port, args.frontend_port)):
        parser.error("Ports must be between 1024 and 65535")
    try:
        supervise(args)
    except (RuntimeError, OSError, subprocess.CalledProcessError) as exc:
        print(str(exc), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
