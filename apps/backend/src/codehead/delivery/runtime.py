"""Own short-lived smoke runs and explicitly started Clinic previews on Windows."""

import hashlib
import http.client
import os
import subprocess
import threading
import time
from collections import OrderedDict
from contextlib import closing
from dataclasses import dataclass, field, replace
from pathlib import Path

from codehead.clinic.cache import inspect_dependency_cache
from codehead.clinic.files import InvalidFile, workspace_path
from codehead.clinic.profile import load_profile
from codehead.delivery.bridge import LOOPBACK
from codehead.delivery.bridge import frame_origins as validate_frame_origins
from codehead.delivery.package import DIST, PackageCompiler, PackageResult, _scan, _uuid, read_file
from codehead.runner.processes import clean_environment, process_tree_factory
from codehead.settings import Settings

MAX_LIVE_PREVIEWS = 2
MAX_RECENT_STOPS = 128


@dataclass(frozen=True, slots=True)
class RuntimeRequest:
    preview_id: str
    package: PackageResult
    data_root: Path
    owner_boot: str


@dataclass(frozen=True, slots=True)
class RuntimeResult:
    status: str
    origin: str | None = None
    backend_pid: int | None = None
    bridge_pid: int | None = None
    error_code: str | None = None
    error_message: str | None = None
    report: dict | None = None


class RuntimeFailure(Exception):
    def __init__(self, code, message, status="failed"):
        super().__init__(message)
        self.result = RuntimeResult(status, error_code=code, error_message=message)


class _OwnedProcess:
    def __init__(self, factory, command, workspace, environment, limit):
        self.tree = factory(
            command, cwd=workspace, env=environment, stdout=subprocess.PIPE, stderr=subprocess.PIPE
        )
        self.exceeded = threading.Event()
        self.unknown_stop = False
        self.limit = limit
        self.readers = []
        for stream in (self.tree.stdout, self.tree.stderr):
            reader = threading.Thread(target=self._drain, args=(stream,), daemon=True)
            reader.start()
            self.readers.append((reader, stream))

    def _drain(self, stream):
        size = 0
        while chunk := stream.read(4096):
            size += len(chunk)
            if size > self.limit:
                self.exceeded.set()

    def stop(self):
        if not self.unknown_stop:
            try:
                self.tree.stop()
            except (OSError, RuntimeError, subprocess.SubprocessError):
                # A failed Job close can invalidate the handle without proving cleanup.
                self.unknown_stop = True
        drained = True
        for reader, stream in self.readers:
            reader.join(timeout=1)
            if reader.is_alive():
                drained = False
            elif not stream.closed:
                stream.close()
        return not self.unknown_stop and drained and self.tree.poll() is not None


@dataclass(slots=True)
class _Session:
    request: RuntimeRequest
    smoke: bool
    lock: threading.Lock = field(default_factory=threading.Lock)
    backend: _OwnedProcess | None = None
    bridge: _OwnedProcess | None = None
    port: int | None = None

    def pids(self):
        return {
            "backend_pid": self.backend.tree.pid if self.backend else None,
            "bridge_pid": self.bridge.tree.pid if self.bridge else None,
        }


def _check_control(deadline, should_stop):
    if should_stop():
        raise RuntimeFailure("control_requested", "Запуск или проверка отменены.", "cancelled")
    if time.monotonic() >= deadline:
        raise RuntimeFailure("tool_timeout", "Clinic Demo не ответил вовремя.", "timed_out")


def _http(port, path, byte_limit, *, deadline=float("inf"), should_stop=lambda: False):
    _check_control(deadline, should_stop)
    timeout = min(0.75, max(0.001, deadline - time.monotonic()))
    with closing(http.client.HTTPConnection(LOOPBACK, port, timeout=timeout)) as connection:
        connection.request("GET", path)
        response = connection.getresponse()
        content = response.read(byte_limit + 1)
        if len(content) > byte_limit:
            raise RuntimeFailure("preview_response_limit", "Ответ Clinic Demo превышает лимит.")
        _check_control(deadline, should_stop)
        return response.status, content


def _port_file(path):
    try:
        with path.open("rb") as stream:
            value = stream.read(6)
    except FileNotFoundError:
        return None
    if not value:
        return None
    if not value.isdigit() or not 1 <= int(value) <= 65535:
        raise RuntimeFailure("preview_invalid_port", "Preview сообщил неверный локальный порт.")
    return int(value)


def _alive(process):
    if process.exceeded.is_set():
        raise RuntimeFailure("output_limit", "Вывод процесса preview превышает лимит.")
    if process.tree.poll() is not None:
        raise RuntimeFailure("preview_process_exited", "Один из процессов Clinic Demo завершился.")


def _wait_stage(process, port_file, *, deadline, should_stop):
    while True:
        _check_control(deadline, should_stop)
        _alive(process)
        port = _port_file(port_file)
        if port is not None:
            try:
                response = _http(port, "/health", 1024, deadline=deadline, should_stop=should_stop)
            except (OSError, http.client.HTTPException):
                pass
            else:
                if response == (200, b'{"status":"ok"}'):
                    _alive(process)
                    return port
                raise RuntimeFailure("preview_health_failed", "Health-check Clinic Demo не прошёл.")
        time.sleep(0.05)


class PreviewRuntime:
    def __init__(
        self,
        compiler=None,
        *,
        frame_origins=None,
        process_factory=None,
        cache_inspector=inspect_dependency_cache,
    ):
        self.compiler = compiler or PackageCompiler()
        origins = Settings().allowed_origins if frame_origins is None else frame_origins
        self.frame_origins = validate_frame_origins(origins)
        self.factory = process_factory
        self.cache_inspector = cache_inspector
        self._sessions = {}
        self._stopped = OrderedDict()
        self._registry = threading.Lock()
        self._closed = False

    def _stage(self, session):
        request = session.request
        root = Path(request.data_root).absolute()
        package = request.package
        workspace = workspace_path(
            root,
            f"smoke/{request.preview_id}"
            if session.smoke
            else (f"interactive/{package.package_id}/g{package.generation}"),
        )
        directories = workspace_path(root, f"controls/{request.preview_id}")
        directories.mkdir(parents=True, exist_ok=False)
        workspace.mkdir(parents=True, exist_ok=not session.smoke)
        sources = [file for file in package.files if file.path.startswith("backend/")]
        for file in sources:
            data = read_file(package.root, file)
            target = workspace_path(workspace, file.path)
            if target.exists():
                read_file(workspace, file)
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            with target.open("xb") as stream:
                stream.write(data)
            read_file(workspace, file)
        _scan(workspace / "backend", {file.path.removeprefix("backend/") for file in sources})
        database = workspace_path(workspace, ".data/clinic.sqlite3")
        for suffix in ("-wal", "-shm", "-journal"):
            workspace_path(workspace, f".data/clinic.sqlite3{suffix}")
        return workspace, database, directories

    def _reserve(self, session):
        value = session.request
        with self._registry:
            interactive = [entry for entry in self._sessions.values() if not entry.smoke]
            if (
                self._closed
                or value.preview_id in self._sessions
                or value.preview_id in self._stopped
            ):
                raise RuntimeFailure(
                    "preview_busy", "Preview уже запускается или worker остановлен."
                )
            if not session.smoke and (
                len(interactive) >= MAX_LIVE_PREVIEWS
                or any(
                    entry.request.package.package_id == value.package.package_id
                    for entry in interactive
                )
            ):
                raise RuntimeFailure("preview_capacity", "Достигнут лимит активных preview.")
            self._sessions[value.preview_id] = session

    def _start(self, request, *, smoke, should_stop, timeout_seconds, output_limit_bytes, deadline):
        if not 1 <= timeout_seconds <= 180 or not 1024 <= output_limit_bytes <= 262144:
            raise ValueError("Runtime limits are outside the supported range.")
        if os.name != "nt":
            return RuntimeResult(
                "failed", error_code="runner_unavailable", error_message="Требуется Windows Runner."
            )
        session = _Session(request, smoke)
        with session.lock:
            try:
                _uuid(request.preview_id)
                self._reserve(session)
            except (InvalidFile, ValueError):
                return RuntimeResult(
                    "failed",
                    error_code="invalid_preview_id",
                    error_message="Некорректный идентификатор preview.",
                )
            except RuntimeFailure as failure:
                return failure.result
            try:
                _check_control(deadline, should_stop)
                self.compiler.verify(request.package)
                profile = load_profile()
                if (
                    profile.id,
                    profile.profile_hash,
                    profile.suite_hash,
                    profile.template_hash,
                ) != (
                    request.package.profile_version,
                    request.package.profile_hash,
                    request.package.acceptance_suite_hash,
                    request.package.template_hash,
                ):
                    raise InvalidFile("Версия профиля Clinic Demo изменилась.")
                _check_control(deadline, should_stop)
                cache = self.cache_inspector(profile)
                _check_control(deadline, should_stop)
                if cache.status != "available":
                    raise RuntimeFailure("dependency_unavailable", "Проверенный кэш недоступен.")
                workspace, database, controls = self._stage(session)
                options = {"deadline": deadline, "should_stop": should_stop}
                backend_file = controls / "backend.port"
                bridge_file = controls / "bridge.port"
                python = [str(cache.python_executable), "-I", "-B", "-u", "-X", "utf8", "-m"]
                factory = self.factory or process_tree_factory()
                environment = clean_environment()
                _check_control(deadline, should_stop)
                session.backend = _OwnedProcess(
                    factory,
                    python + ["codehead.delivery.serve_clinic", str(workspace), str(backend_file)],
                    workspace,
                    environment | {"CLINIC_DATABASE_PATH": str(database)},
                    output_limit_bytes,
                )
                backend_port = _wait_stage(session.backend, backend_file, **options)
                package = request.package
                _check_control(deadline, should_stop)
                session.bridge = _OwnedProcess(
                    factory,
                    python
                    + [
                        "codehead.delivery.bridge",
                        str(self.compiler.package_root),
                        package.package_id,
                        str(package.generation),
                        package.manifest_hash,
                        package.archive_hash,
                        str(package.archive_byte_size),
                        str(backend_port),
                        str(bridge_file),
                        *self.frame_origins,
                    ],
                    workspace,
                    environment,
                    output_limit_bytes,
                )
                session.port = _wait_stage(session.bridge, bridge_file, **options)
                return self._health(session, **options)
            except RuntimeFailure as failure:
                result = failure.result
            except (InvalidFile, ValueError, KeyError):
                result = RuntimeResult(
                    "failed",
                    error_code="package_changed",
                    error_message="Закреплённый пакет или версия данных изменились.",
                )
            except (OSError, RuntimeError, subprocess.SubprocessError, http.client.HTTPException):
                result = RuntimeResult(
                    "failed",
                    error_code="preview_unavailable",
                    error_message="Не удалось запустить Clinic Demo.",
                )
            stopped = self._stop(session)
            return stopped if stopped.status != "stopped" else replace(result, **session.pids())

    def _health(self, session, **options):
        _alive(session.backend)
        _alive(session.bridge)
        package = session.request.package
        index = next(file for file in package.files if file.path == f"{DIST}/index.html")
        health, document = _http(session.port, "/health", 1024, **options)
        status, body = _http(session.port, "/", index.byte_size, **options)
        if (health, document) != (200, b'{"status":"ok"}') or (
            status != 200 or hashlib.sha256(body).hexdigest() != index.sha256
        ):
            raise RuntimeFailure("preview_health_failed", "Файлы или API Clinic Demo недоступны.")
        _alive(session.backend)
        _alive(session.bridge)
        return RuntimeResult("ready", f"http://{LOOPBACK}:{session.port}", **session.pids())

    def start(
        self, request, *, should_stop=lambda: False, timeout_seconds=20, output_limit_bytes=65536
    ):
        return self._start(
            request,
            smoke=False,
            should_stop=should_stop,
            timeout_seconds=timeout_seconds,
            output_limit_bytes=output_limit_bytes,
            deadline=time.monotonic() + timeout_seconds,
        )

    def smoke(
        self, request, *, should_stop=lambda: False, timeout_seconds=20, output_limit_bytes=65536
    ):
        deadline = time.monotonic() + timeout_seconds
        started = self._start(
            request,
            smoke=True,
            should_stop=should_stop,
            timeout_seconds=timeout_seconds,
            output_limit_bytes=output_limit_bytes,
            deadline=deadline,
        )
        if started.status != "ready":
            return started
        try:
            result = RuntimeResult(
                "passed", backend_pid=started.backend_pid, bridge_pid=started.bridge_pid
            )
            port = int(started.origin.rsplit(":", 1)[1])
            status, doctors = _http(
                port, "/api/doctors", 1024, deadline=deadline, should_stop=should_stop
            )
            if (status, doctors) != (200, b"[]"):
                raise RuntimeFailure("smoke_failed", "Проверка свежей базы Clinic Demo не прошла.")
            report = {
                "status": "passed",
                "package_tree_hash": request.package.tree_hash,
                "health_status": 200,
                "index_status": 200,
                "fresh_database": True,
                "owned_processes_stopped": True,
            }
            result = replace(result, report=report)
        except RuntimeFailure as failure:
            result = failure.result
        except (OSError, http.client.HTTPException):
            result = RuntimeResult(
                "failed", error_code="smoke_failed", error_message="Проверка Clinic Demo прервана."
            )
        finally:
            stopped = self.stop(request.preview_id, request.owner_boot)
        if stopped.status != "stopped":
            return stopped
        if result.status == "passed":
            try:
                _check_control(deadline, should_stop)
            except RuntimeFailure as failure:
                return failure.result
        return result

    def _session(self, preview_id, owner_boot):
        with self._registry:
            session = self._sessions.get(preview_id)
            return (
                session
                if session is not None and session.request.owner_boot == owner_boot
                else None
            )

    def owns(self, preview_id, owner_boot):
        return self._session(preview_id, owner_boot) is not None

    @staticmethod
    def _unknown(session=None):
        return RuntimeResult(
            "uncertain",
            error_code="preview_ownership_unknown",
            error_message="Не удалось подтвердить состояние процессов preview.",
            **(session.pids() if session else {}),
        )

    def _stop(self, session):
        outcomes = [process.stop() for process in (session.bridge, session.backend) if process]
        if not all(outcomes):
            return self._unknown(session)
        result = RuntimeResult("stopped", **session.pids())
        identity = session.request.preview_id
        with self._registry:
            self._sessions.pop(identity, None)
            if not session.smoke:
                # Preserve verified cleanup when a queued Stop overlaps a health check.
                self._stopped[identity] = (session.request.owner_boot, result)
                if len(self._stopped) > MAX_RECENT_STOPS:
                    self._stopped.popitem(last=False)
        return result

    def confirmed_stop(self, preview_id, owner_boot):
        with self._registry:
            entry = self._stopped.get(preview_id)
            return entry[1] if entry is not None and entry[0] == owner_boot else None

    def probe(self, preview_id, owner_boot):
        session = self._session(preview_id, owner_boot)
        if session is None:
            return self._unknown()
        with session.lock:
            if not self.owns(preview_id, owner_boot) or session.port is None:
                return self._unknown()
            try:
                return self._health(session)
            except RuntimeFailure as failure:
                result = failure.result
            except (OSError, http.client.HTTPException):
                result = RuntimeResult(
                    "failed",
                    error_code="preview_health_failed",
                    error_message="Preview больше не отвечает.",
                )
            stopped = self._stop(session)
            return stopped if stopped.status != "stopped" else replace(result, **session.pids())

    def stop(self, preview_id, owner_boot):
        session = self._session(preview_id, owner_boot)
        if session is None:
            return self.confirmed_stop(preview_id, owner_boot) or self._unknown()
        with session.lock:
            if not self.owns(preview_id, owner_boot):
                return self.confirmed_stop(preview_id, owner_boot) or self._unknown()
            return self._stop(session)

    def close(self):
        with self._registry:
            self._closed = True
            sessions = list(self._sessions.values())
        for session in sessions:
            self.stop(session.request.preview_id, session.request.owner_boot)
