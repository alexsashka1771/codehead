"""Run frozen HTTP acceptance from an independent trusted root and retain its report."""

import argparse
import hashlib
import importlib.util
import json
import os
import subprocess
import tempfile
import threading
import time
from datetime import UTC, datetime
from pathlib import Path

TRUSTED_ROOT = Path(__file__).resolve().parent
PROFILE_ROOT = TRUSTED_ROOT.parent
REPOSITORY_ROOT = TRUSTED_ROOT.parents[3]
MAX_OUTPUT_BYTES = 1048576
TIMEOUT_SECONDS = 180


def _text_hash(path: Path) -> str:
    content = path.read_bytes().decode("utf-8-sig").replace("\r\n", "\n").replace("\r", "\n")
    return hashlib.sha256(content.encode("utf-8")).hexdigest()


def _tree_hash(files: dict[str, str]) -> str:
    manifest = "".join(f"{path}\0{files[path]}\n" for path in sorted(files))
    return hashlib.sha256(manifest.encode("utf-8")).hexdigest()


def trusted_hashes() -> dict[str, str]:
    return {
        "profile_hash": _tree_hash(
            {name: _text_hash(PROFILE_ROOT / name) for name in ("profile.json", "schemas.json")}
        ),
        "suite_hash": _tree_hash(
            {
                path.relative_to(TRUSTED_ROOT).as_posix(): _text_hash(path)
                for path in TRUSTED_ROOT.rglob("*.py")
                if "__pycache__" not in path.parts
            }
        ),
    }


def candidate_hash(root: Path) -> str:
    excluded = {".data", "node_modules", "dist", "__pycache__", ".pytest_cache"}
    return _tree_hash(
        {
            path.relative_to(root).as_posix(): _text_hash(path)
            for path in root.rglob("*")
            if path.is_file() and not excluded.intersection(path.relative_to(root).parts)
        }
    )


def _process_tree():
    spec = importlib.util.spec_from_file_location(
        "clinic_suite_process_tree", TRUSTED_ROOT / "process_tree.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.ProcessTree


def _run(command: list[str], run_root: Path, environment: dict[str, str]):
    tree = _process_tree()(command, cwd=run_root, env=environment, stdout=subprocess.PIPE)
    output = bytearray()
    exceeded = threading.Event()

    def collect():
        while chunk := tree.stdout.read(4096):
            remaining = MAX_OUTPUT_BYTES - len(output)
            output.extend(chunk[: max(0, remaining)])
            if len(chunk) > remaining:
                exceeded.set()

    reader = threading.Thread(target=collect, daemon=True)
    reader.start()
    deadline = time.monotonic() + TIMEOUT_SECONDS
    status = None
    try:
        while tree.poll() is None:
            if exceeded.is_set():
                status = "output_limit"
                break
            if time.monotonic() >= deadline:
                status = "timeout"
                break
            time.sleep(0.05)
    finally:
        tree.stop()
        reader.join(timeout=5)
    if exceeded.is_set():
        status = "output_limit"
    return tree.poll(), output.decode("utf-8", errors="replace"), status


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--candidate-root", type=Path)
    parser.add_argument("--python", type=Path)
    parser.add_argument("--collect-only", action="store_true")
    arguments = parser.parse_args()
    if arguments.candidate_root is None and not arguments.collect_only:
        parser.error(
            "--candidate-root is required; the harness never substitutes an implementation"
        )
    candidate = arguments.candidate_root.resolve() if arguments.candidate_root else None
    python = (arguments.python or REPOSITORY_ROOT / ".venv" / "Scripts" / "python.exe").resolve()
    if not python.is_file():
        parser.error("dependency_unavailable: the prepared Python executable is missing")
    if candidate is not None and not (candidate / "backend" / "main.py").is_file():
        parser.error("the candidate has no trusted backend/main.py entry point")
    run_root = Path(tempfile.mkdtemp(prefix="codehead-clinic-acceptance-"))
    configuration = run_root / "pytest.ini"
    configuration.write_text("[pytest]\naddopts =\n", encoding="utf-8")
    command = [
        str(python),
        "-I",
        "-m",
        "pytest",
        str(TRUSTED_ROOT / "test_http.py"),
        "-c",
        str(configuration),
        "--rootdir",
        str(run_root),
        "--confcutdir",
        str(TRUSTED_ROOT),
        "--import-mode=importlib",
        "--basetemp",
        str(run_root / "test-data"),
        "--disable-plugin-autoload",
        "-p",
        "no:cacheprovider",
        "--clinic-python",
        str(python),
        "-q",
    ]
    if arguments.collect_only:
        command.append("--collect-only")
    if candidate is not None:
        command.extend(["--clinic-candidate", str(candidate)])
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
            "PYTEST_DISABLE_PLUGIN_AUTOLOAD": "1",
        }
    )
    before = trusted_hashes()
    candidate_before = candidate_hash(candidate) if candidate is not None else None
    started_at = datetime.now(UTC).isoformat()
    exit_code, output, failure = _run(command, run_root, environment)
    after = trusted_hashes()
    candidate_after = candidate_hash(candidate) if candidate is not None else None
    status = failure or "failed"
    if exit_code == 0 and failure is None:
        status = "collected" if arguments.collect_only else "passed"
    if before["suite_hash"] != after["suite_hash"]:
        status = "suite_changed"
    elif before["profile_hash"] != after["profile_hash"]:
        status = "profile_changed"
    elif candidate_before != candidate_after:
        status = "candidate_changed"
    report = {
        "profile_id": "clinic_demo/v1",
        "isolation_level": "process_only",
        "status": status,
        "command": command,
        "started_at": started_at,
        "finished_at": datetime.now(UTC).isoformat(),
        "exit_code": exit_code,
        "profile_hash": before["profile_hash"],
        "suite_hash": before["suite_hash"],
        "profile_hash_after": after["profile_hash"],
        "suite_hash_after": after["suite_hash"],
        "candidate_hash": candidate_before,
        "candidate_hash_after": candidate_after,
        "candidate_root": str(candidate) if candidate else None,
        "test_data_root": str(run_root / "test-data"),
        "output": output,
    }
    report_path = run_root / "report.json"
    report_path.write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(output, end="" if output.endswith("\n") else "\n")
    print(json.dumps({"status": status, "report": str(report_path), **before}, ensure_ascii=False))
    return 0 if status in {"passed", "collected"} else 1


if __name__ == "__main__":
    raise SystemExit(main())
