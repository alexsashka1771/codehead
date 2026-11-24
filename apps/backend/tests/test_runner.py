import importlib
import io
import json
import threading
import time
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

import pytest
from test_candidate_workspace import descriptor

from codehead.clinic.files import ROLE_PATHS, text_hash
from codehead.clinic.profile import REPOSITORY_ROOT, load_profile


def runner_module():
    assert (REPOSITORY_ROOT / "apps/backend/src/codehead/runner/execution.py").is_file(), (
        "RestrictedProcessRunner is not implemented"
    )
    return importlib.import_module("codehead.runner.execution")


def request(operation="validate_backend"):
    module = runner_module()
    profile = load_profile()
    files = {file.relative_path: file.content for file in profile.template_files}
    for role, paths in ROLE_PATHS.items():
        for path in paths:
            files[path] = (
                (profile.root / "fixtures" / role / Path(path).name)
                .read_text(encoding="utf-8-sig")
                .replace("\r\n", "\n")
            )
    candidate, contents, _ = descriptor(files)
    candidate = candidate.model_copy(
        update={
            "status": "ready",
            "profile_hash": profile.profile_hash,
            "acceptance_suite_hash": profile.suite_hash,
            "template_hash": profile.template_hash,
        }
    )
    workspace = importlib.import_module("codehead.clinic.workspace")
    manifest = json.dumps(workspace._manifest_document(candidate)) + "\n"
    candidate = candidate.model_copy(
        update={
            "manifest_hash": text_hash(manifest),
            "manifest_byte_size": len(manifest.encode()),
        }
    )
    return module.RunnerRequest(str(uuid4()), operation, candidate, contents, manifest)


def test_runner_refuses_unstructured_or_unavailable_operations(tmp_path):
    module = runner_module()
    result = module.RestrictedProcessRunner(workspace_root=tmp_path).execute(request("echo hello"))
    assert result.status == "failed" and result.error_code == "runner_unavailable"
    assert result.commands == [] and not list(tmp_path.iterdir())


def test_runner_compiles_a_verified_copy_without_mutating_the_candidate(tmp_path):
    module = runner_module()
    value = request()
    result = module.RestrictedProcessRunner(workspace_root=tmp_path).execute(value)
    assert result.status == "succeeded" and result.exit_code == 0
    assert result.commands and "py_compile" in result.commands[0]
    copy = tmp_path / value.tool_run_id / value.candidate.id / "v3"
    assert (copy / "backend/clinic_api.py").read_text(encoding="utf-8") == value.contents[
        "backend/clinic_api.py"
    ]


def test_missing_cache_is_explicit_and_does_not_start_a_process(tmp_path):
    module = runner_module()
    runner = module.RestrictedProcessRunner(
        workspace_root=tmp_path,
        cache_inspector=lambda _: SimpleNamespace(status="dependency_unavailable"),
    )
    result = runner.execute(request())
    assert result.error_code == "dependency_unavailable" and result.commands == []
    assert not list(tmp_path.iterdir())


def test_invalid_pins_or_bytes_are_rejected_before_process_dispatch(tmp_path):
    module = runner_module()
    value = request()
    value.contents["backend/clinic_api.py"] += "# changed\n"
    result = module.RestrictedProcessRunner(workspace_root=tmp_path).execute(value)
    assert result.status == "failed" and result.error_code == "candidate_changed"
    assert result.commands == []


def process_factory(program):
    def start(_command, **options):
        module = importlib.import_module("codehead.runner.processes")
        import sys

        return module.process_tree_factory()(
            [sys.executable, "-I", "-X", "utf8", "-c", program], **options
        )

    return start


def test_child_environment_drops_secrets_and_interpreter_hooks(tmp_path, monkeypatch):
    module = runner_module()
    for name in ("RUNNER_API_KEY", "CODEHEAD_DATABASE_URL", "NODE_OPTIONS", "PYTHONPATH"):
        monkeypatch.setenv(name, "synthetic-private-value")
    runner = module.RestrictedProcessRunner(
        workspace_root=tmp_path,
        process_factory=process_factory("import json,os; print(json.dumps(dict(os.environ)))"),
    )
    result = runner.execute(request())
    assert result.status == "succeeded"
    assert "synthetic-private-value" not in result.stdout + result.stderr
    for name in ("RUNNER_API_KEY", "CODEHEAD_DATABASE_URL", "NODE_OPTIONS", "PYTHONPATH"):
        assert name not in json.loads(result.stdout)


def test_stdout_stderr_are_separate_bounded_and_redacted(tmp_path):
    module = runner_module()
    secret = "synthetic-runner-secret"
    runner = module.RestrictedProcessRunner(
        workspace_root=tmp_path,
        secrets=(secret,),
        process_factory=process_factory(
            f"import sys; print('{secret}'); print('diagnostic',file=sys.stderr)"
        ),
    )
    result = runner.execute(request())
    assert result.status == "succeeded" and secret not in result.stdout + result.stderr
    assert "[REDACTED:secret]" in result.stdout and "diagnostic" in result.stderr


@pytest.mark.parametrize("stream", ["stdout", "stderr"])
@pytest.mark.parametrize("secret", ["synthetic-runner-secret-abcdef", "秘密-runner-secret-abcdef"])
def test_truncated_secret_prefix_is_not_persisted(tmp_path, stream, secret):
    module = runner_module()
    program = f"import sys;sys.{stream}.write('x'*1000+{secret!r});sys.{stream}.flush()"
    runner = module.RestrictedProcessRunner(
        workspace_root=tmp_path,
        output_limit_bytes=1024,
        secrets=(secret,),
        process_factory=process_factory(program),
    )
    result = runner.execute(request())
    assert result.error_code == "output_limit"
    output = getattr(result, stream)
    assert secret[:15] not in output
    assert len(output.encode()) <= 1024


@pytest.mark.parametrize(
    "program,code",
    [
        ("import time; time.sleep(10)", "tool_timeout"),
        ("import sys; sys.stdout.write('x'*1000000);sys.stdout.flush()", "output_limit"),
    ],
)
def test_process_limits_stop_the_owned_tree(tmp_path, program, code):
    module = runner_module()
    runner = module.RestrictedProcessRunner(
        workspace_root=tmp_path,
        timeout_seconds=1,
        output_limit_bytes=1024,
        process_factory=process_factory(program),
    )
    result = runner.execute(request())
    assert result.status == ("timed_out" if code == "tool_timeout" else "failed")
    assert result.error_code == code
    assert len(result.stdout.encode()) <= 1024 and len(result.stderr.encode()) <= 1024


def test_control_stops_the_running_operation(tmp_path):
    module = runner_module()
    stop = threading.Event()
    timer = threading.Timer(2, stop.set)
    runner = module.RestrictedProcessRunner(
        workspace_root=tmp_path,
        process_factory=process_factory("import time;time.sleep(20)"),
    )
    timer.start()
    try:
        result = runner.execute(request(), should_stop=stop.is_set)
    finally:
        timer.cancel()
    assert result.status == "cancelled" and result.error_code == "control_requested"


def test_source_modification_by_process_invalidates_success(tmp_path):
    module = runner_module()
    runner = module.RestrictedProcessRunner(
        workspace_root=tmp_path,
        process_factory=process_factory(
            "from pathlib import Path;Path('backend/clinic_api.py').write_text('changed')"
        ),
    )
    result = runner.execute(request())
    assert result.status == "failed" and result.error_code == "candidate_changed"


def test_job_closes_descendant_even_after_direct_parent_exits(tmp_path):
    module = runner_module()
    marker = tmp_path / "orphan.txt"
    child = (
        f"import time;from pathlib import Path;time.sleep(2);"
        f"Path({str(marker)!r}).write_text('late')"
    )
    program = (
        f"import subprocess,sys;subprocess.Popen([sys.executable,'-c',{child!r}]);"
        "print('parent done')"
    )
    runner = module.RestrictedProcessRunner(
        workspace_root=tmp_path,
        process_factory=process_factory(program),
    )
    result = runner.execute(request())
    assert result.status == "succeeded"
    time.sleep(2.2)
    assert not marker.exists()


def test_suite_pin_change_after_successful_command_invalidates_result(tmp_path, monkeypatch):
    from dataclasses import replace

    module = runner_module()
    value = request()
    original = load_profile()
    calls = []

    def changed_profile():
        calls.append(True)
        return original if len(calls) == 1 else replace(original, suite_hash="0" * 64)

    monkeypatch.setattr(module, "load_profile", changed_profile)
    result = module.RestrictedProcessRunner(workspace_root=tmp_path).execute(value)
    assert result.status == "failed" and result.error_code == "candidate_changed"


def test_build_artifact_size_has_a_separate_limit(tmp_path):
    module = runner_module()
    program = (
        "from pathlib import Path;d=Path('dist');d.mkdir(exist_ok=True);"
        "(d/'index.html').write_text('built');"
        "(d/'large.bin').write_bytes(b'x'*5242880)"
    )
    runner = module.RestrictedProcessRunner(
        workspace_root=tmp_path,
        process_factory=process_factory(program),
        artifact_limit_bytes=1024,
    )
    result = runner.execute(request("build_frontend"))
    assert result.status == "failed" and result.error_code == "artifact_limit"


def test_unverified_process_stop_does_not_become_a_known_failure(tmp_path):
    module = runner_module()

    def stop():
        raise OSError("Synthetic Windows Job Object stop failure")

    tree = SimpleNamespace(
        pid=1234, stdout=io.BytesIO(), stderr=io.BytesIO(), poll=lambda: 0, stop=stop
    )
    runner = module.RestrictedProcessRunner(
        workspace_root=tmp_path,
        process_factory=lambda *_args, **_kwargs: tree,
    )
    with pytest.raises(RuntimeError, match="stopped"):
        runner.execute(request())


@pytest.mark.parametrize("operation", ["test_backend", "build_frontend"])
def test_trusted_http_suite_and_build_run_on_the_verified_copy(operation):
    module = runner_module()
    result = module.RestrictedProcessRunner().execute(request(operation))
    assert result.status == "succeeded", result.stderr + result.stdout
    if operation == "test_backend":
        assert result.report["status"] == "passed"
        assert result.report["suite_hash"] == load_profile().suite_hash
        assert result.report["test_data_root"] and "55 passed" in result.stdout
    else:
        assert len(result.commands) == 2 and "built" in result.stdout
