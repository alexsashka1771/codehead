"""Bounded collection of owned Windows Job Object processes."""

import importlib.util
import os
import subprocess
import threading
import time
from dataclasses import dataclass

from codehead.clinic.profile import REPOSITORY_ROOT
from codehead.llm.redaction import redact


def process_tree_factory():
    path = REPOSITORY_ROOT / "tools/process_tree.py"
    spec = importlib.util.spec_from_file_location("runner_process_tree", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.ProcessTree


def clean_environment():
    names = ("SYSTEMROOT", "WINDIR", "TEMP", "TMP", "PATH", "COMSPEC")
    environment = {name: os.environ[name] for name in names if name in os.environ}
    return environment | {
        "PYTHONUTF8": "1",
        "PYTHONIOENCODING": "utf-8",
        "PYTHONUNBUFFERED": "1",
    }


@dataclass(frozen=True)
class ProcessResult:
    exit_code: int | None
    stdout: str
    stderr: str
    error_code: str | None
    process_id: int


class ProcessOwnershipError(RuntimeError):
    def __init__(self, process_id, command):
        super().__init__("The owned process tree could not be verified as stopped.")
        self.process_id = process_id
        self.commands = [list(command)]


def run_process(command, *, cwd, environment, deadline, limit, should_stop, secrets, factory=None):
    tree = (factory or process_tree_factory())(
        command, cwd=cwd, env=environment, stdout=subprocess.PIPE, stderr=subprocess.PIPE
    )
    output = {"stdout": bytearray(), "stderr": bytearray()}
    truncated = {name: False for name in output}
    exceeded = threading.Event()

    def collect(name):
        stream = getattr(tree, name)
        while chunk := stream.read(4096):
            remaining = limit - len(output[name])
            output[name].extend(chunk[: max(remaining, 0)])
            if len(chunk) > remaining:
                truncated[name] = True
                exceeded.set()

    readers = [threading.Thread(target=collect, args=(name,), daemon=True) for name in output]
    for reader in readers:
        reader.start()
    error, exit_code = None, None
    try:
        while tree.poll() is None:
            if should_stop():
                error = "control_requested"
                break
            if exceeded.is_set():
                error = "output_limit"
                break
            if time.monotonic() >= deadline:
                error = "tool_timeout"
                break
            time.sleep(0.025)
        if error is None:
            exit_code = tree.poll()
    finally:
        stopping_failure = None
        try:
            tree.stop()
        except (OSError, RuntimeError) as failure:
            stopping_failure = failure
        for reader in readers:
            reader.join(timeout=5)
        for name, reader in zip(output, readers, strict=True):
            if not reader.is_alive():
                getattr(tree, name).close()
        if stopping_failure is not None or any(reader.is_alive() for reader in readers):
            raise ProcessOwnershipError(tree.pid, command) from stopping_failure
    if exceeded.is_set() and error != "control_requested":
        error = "output_limit"

    def text(name):
        value = redact(
            output[name].decode("utf-8", errors="ignore" if truncated[name] else "replace"), secrets
        )
        if truncated[name]:
            for secret in sorted({secret for secret in secrets if secret}, key=len, reverse=True):
                for size in range(min(len(value), len(secret) - 1), 0, -1):
                    if value.endswith(secret[:size]):
                        value = value[:-size] + "[REDACTED:secret]"
                        break
        return value.encode("utf-8")[:limit].decode("utf-8", errors="ignore")

    return ProcessResult(exit_code, text("stdout"), text("stderr"), error, tree.pid)
