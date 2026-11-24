"""Execute allowlisted checks against a verified copy of one committed candidate."""

import hashlib
import json
import os
import stat
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path
from uuid import UUID

from codehead.clinic.cache import inspect_dependency_cache
from codehead.clinic.files import InvalidFile, text_hash, workspace_path
from codehead.clinic.profile import REPOSITORY_ROOT, load_profile
from codehead.clinic.workspace import _read, materialize
from codehead.contracts import CandidateView
from codehead.runner.processes import ProcessOwnershipError, clean_environment, run_process

OPERATIONS = {"validate_backend", "test_backend", "build_frontend"}


class ArtifactLimit(InvalidFile):
    pass


@dataclass(frozen=True)
class RunnerRequest:
    tool_run_id: str
    operation_id: str
    candidate: CandidateView
    contents: dict[str, str]
    manifest_content: str


@dataclass
class ExecutionResult:
    status: str = "failed"
    commands: list[list[str]] = field(default_factory=list)
    stdout: str = ""
    stderr: str = ""
    exit_code: int | None = None
    error_code: str | None = None
    error_message: str | None = None
    report: dict | None = None
    process_id: int | None = None


class RestrictedProcessRunner:
    def __init__(
        self,
        *,
        workspace_root=None,
        timeout_seconds=180,
        output_limit_bytes=262144,
        secrets=(),
        process_factory=None,
        cache_inspector=inspect_dependency_cache,
        artifact_limit_bytes=16777216,
    ):
        if not 1 <= timeout_seconds <= 180 or not 1024 <= output_limit_bytes <= 262144:
            raise ValueError("Runner limits are outside the supported range.")
        self.workspace_root = Path(workspace_root or REPOSITORY_ROOT / ".data/tool-runs").absolute()
        self.timeout_seconds = timeout_seconds
        self.output_limit_bytes = output_limit_bytes
        self.secrets = secrets
        self.factory = process_factory
        self.cache_inspector = cache_inspector
        if not 1024 <= artifact_limit_bytes <= 16777216:
            raise ValueError("Build artifact limit is outside the supported range.")
        self.artifact_limit_bytes = artifact_limit_bytes

    def _build_report(self, copy):
        root = workspace_path(copy, "frontend/dist")
        index = workspace_path(root, "index.html")
        if not index.is_file():
            raise InvalidFile("Сборка не создала index.html.")
        pending, files, total, entries = [root], {}, 0, 0
        while pending:
            directory = pending.pop()
            for path in directory.iterdir():
                entries += 1
                if entries > 1024:
                    raise ArtifactLimit("Сборка создала слишком много выходных файлов.")
                relative = path.relative_to(root).as_posix()
                safe = workspace_path(root, relative)
                metadata = safe.lstat()
                if stat.S_ISDIR(metadata.st_mode):
                    pending.append(safe)
                    continue
                if not stat.S_ISREG(metadata.st_mode):
                    raise InvalidFile("Сборка создала недопустимый выходной файл.")
                total += metadata.st_size
                if total > self.artifact_limit_bytes:
                    raise ArtifactLimit("Размер файлов сборки превышает отдельный лимит.")
                digest, size = hashlib.sha256(), 0
                with safe.open("rb") as stream:
                    while chunk := stream.read(65536):
                        size += len(chunk)
                        if size > metadata.st_size:
                            raise ArtifactLimit("Выходной файл изменился во время проверки.")
                        digest.update(chunk)
                if size != metadata.st_size:
                    raise InvalidFile("Размер выходного файла изменился при проверке.")
                files[relative] = {"byte_size": size, "sha256": digest.hexdigest()}
        return {
            "status": "passed",
            "artifact_limit_bytes": self.artifact_limit_bytes,
            "artifact_bytes": total,
            "files": files,
        }

    @staticmethod
    def _pins(candidate, profile):
        return (
            candidate.profile_version,
            candidate.profile_hash,
            candidate.acceptance_suite_hash,
            candidate.template_hash,
        ) == (profile.id, profile.profile_hash, profile.suite_hash, profile.template_hash)

    @staticmethod
    def _sources(root, request):
        expected = {
            file.relative_path: (file.byte_size, file.content_hash)
            for file in request.candidate.files
        }
        expected[".codehead/manifest.json"] = (
            request.candidate.manifest_byte_size,
            request.candidate.manifest_hash,
        )
        for relative, (size, digest) in expected.items():
            if text_hash(_read(workspace_path(root, relative), size)) != digest:
                raise InvalidFile("Исходники копии кандидата изменились при проверке.")

    @staticmethod
    def _commands(operation, copy, cache, profile):
        if operation == "validate_backend":
            return [
                (
                    copy,
                    [
                        str(cache.python_executable),
                        "-I",
                        "-X",
                        "utf8",
                        "-m",
                        "py_compile",
                        "backend/main.py",
                        "backend/clinic_api.py",
                        "backend/clinic_models.py",
                        "backend/clinic_storage.py",
                    ],
                )
            ]
        if operation == "test_backend":
            return [
                (
                    REPOSITORY_ROOT,
                    [
                        str(cache.python_executable),
                        "-I",
                        "-X",
                        "utf8",
                        str(profile.root / "acceptance/run_suite.py"),
                        "--candidate-root",
                        str(copy),
                        "--python",
                        str(cache.python_executable),
                    ],
                )
            ]
        return [
            (
                copy / "frontend",
                [
                    str(cache.node_executable),
                    str(cache.node_modules / "typescript/bin/tsc"),
                    "--noEmit",
                ],
            ),
            (
                copy / "frontend",
                [str(cache.node_executable), str(cache.node_modules / "vite/bin/vite.js"), "build"],
            ),
        ]

    @staticmethod
    def _http_report(output, profile):
        metadata = json.loads(output.strip().splitlines()[-1])
        temporary = Path(tempfile.gettempdir()).absolute()
        report_path = Path(metadata["report"]).absolute()
        relative = report_path.relative_to(temporary).as_posix()
        safe = workspace_path(temporary, relative)
        if (
            not safe.parent.name.startswith("codehead-clinic-acceptance-")
            or safe.name != "report.json"
        ):
            raise InvalidFile("Отчёт внешних проверок находится вне доверенной области.")
        with safe.open("rb") as stream:
            data = stream.read(2097153)
        if len(data) > 2097152:
            raise InvalidFile("Отчёт внешних проверок превышает лимит.")
        report = json.loads(data.decode("utf-8"))
        if (
            report["profile_hash"] != profile.profile_hash
            or report["profile_hash_after"] != profile.profile_hash
            or report["suite_hash"] != profile.suite_hash
            or report["suite_hash_after"] != profile.suite_hash
            or report["candidate_hash"] != report["candidate_hash_after"]
            or report["isolation_level"] != "process_only"
        ):
            raise InvalidFile("Хэши внешнего отчёта не соответствуют проверенной версии.")
        return report

    def execute(self, request, should_stop=lambda: False):
        result = ExecutionResult()
        if request.operation_id not in OPERATIONS or os.name != "nt":
            result.error_code, result.error_message = (
                "runner_unavailable",
                "Эта операция или требуемый Runner недоступны.",
            )
            return result
        if should_stop():
            result.status, result.error_code = "cancelled", "control_requested"
            return result
        deadline = time.monotonic() + self.timeout_seconds
        try:
            if str(UUID(request.tool_run_id)) != request.tool_run_id:
                raise InvalidFile("Неверный идентификатор операции.")
            profile = load_profile()
            if not self._pins(request.candidate, profile) or request.candidate.status != "ready":
                raise InvalidFile("Закреплённые исходники или профиль больше не актуальны.")
            cache = self.cache_inspector(profile)
            if cache.status != "available":
                result.error_code, result.error_message = (
                    "dependency_unavailable",
                    "Проверенный кэш зависимостей недоступен.",
                )
                return result
            owned_root = workspace_path(self.workspace_root, request.tool_run_id)
            copy = materialize(
                owned_root, request.candidate, request.contents, request.manifest_content
            )
            self._sources(copy, request)
            environment = clean_environment() | {
                "CODEHEAD_CLINIC_NODE_MODULES": str(cache.node_modules)
            }
            for cwd, command in self._commands(request.operation_id, copy, cache, profile):
                if should_stop():
                    result.status, result.error_code = "cancelled", "control_requested"
                    return result
                if time.monotonic() >= deadline:
                    result.status = "timed_out"
                    result.error_code, result.error_message = (
                        "tool_timeout",
                        "Время проверки истекло.",
                    )
                    return result
                result.commands.append(command)
                remaining = self.output_limit_bytes - max(
                    len(result.stdout.encode()), len(result.stderr.encode())
                )
                if remaining <= 0:
                    result.error_code, result.error_message = "output_limit", "Вывод достиг лимита."
                    return result
                captured = run_process(
                    command,
                    cwd=cwd,
                    environment=environment,
                    deadline=deadline,
                    limit=remaining,
                    should_stop=should_stop,
                    secrets=self.secrets,
                    factory=self.factory,
                )
                result.stdout += captured.stdout
                result.stderr += captured.stderr
                result.exit_code, result.process_id = captured.exit_code, captured.process_id
                if captured.error_code:
                    result.error_code = captured.error_code
                    result.error_message = {
                        "tool_timeout": "Проверка остановлена по таймауту.",
                        "output_limit": "Проверка остановлена: вывод превышает лимит.",
                        "control_requested": "Проверка остановлена по запросу управления.",
                    }[captured.error_code]
                    if captured.error_code == "control_requested":
                        result.status = "cancelled"
                    elif captured.error_code == "tool_timeout":
                        result.status = "timed_out"
                    return result
                self._sources(copy, request)
                if not self._pins(request.candidate, load_profile()):
                    raise InvalidFile("Доверенный профиль или набор проверок изменился.")
                if request.operation_id == "test_backend":
                    result.report = self._http_report(result.stdout, profile)
                    if result.report.get("status") != "passed":
                        result.error_code, result.error_message = (
                            "tool_failed",
                            "HTTP-проверки не прошли.",
                        )
                        return result
                if captured.exit_code != 0:
                    result.error_code, result.error_message = (
                        "tool_failed",
                        "Команда проверки завершилась ошибкой.",
                    )
                    return result
            if request.operation_id == "build_frontend":
                result.report = self._build_report(copy)
            result.status = "succeeded"
            return result
        except ProcessOwnershipError as failure:
            failure.commands = result.commands
            raise
        except ArtifactLimit:
            result.error_code, result.error_message = (
                "artifact_limit",
                "Выходные файлы сборки превышают допустимый лимит.",
            )
            return result
        except (InvalidFile, ValueError, KeyError, IndexError):
            result.error_code = "candidate_changed"
            result.error_message = "Исходники, manifest или отчёт проверки не соответствуют версии."
            return result
        except OSError:
            result.error_code, result.error_message = (
                "runner_io_error",
                "Не удалось выполнить локальную проверку.",
            )
            return result
