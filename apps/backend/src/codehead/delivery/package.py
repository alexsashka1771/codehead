"""Freeze immutable source and retained Runner output as a reproducible package."""

import hashlib
import json
import os
import stat
from dataclasses import dataclass
from pathlib import Path
from uuid import UUID
from zipfile import ZIP_STORED, ZipFile, ZipInfo

from codehead.clinic.files import (
    HASH_PATTERN,
    ROLE_PATHS,
    InvalidFile,
    normalize_relative_path,
    text_hash,
    tree_hash,
    workspace_path,
)
from codehead.clinic.profile import REPOSITORY_ROOT, load_profile
from codehead.clinic.workspace import _manifest_document, _read, _unique_json
from codehead.contracts import CandidateView

MAX_BYTES = 16 * 1024 * 1024
MAX_FILES = 1024
SOURCE_MANIFEST = ".codehead/manifest.json"
PACKAGE_MANIFEST = ".codehead/package.json"
ARCHIVE = "package.zip"
DIST = "frontend/dist"


def _document_bytes(document):
    return (
        json.dumps(
            document, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False
        )
        + "\n"
    ).encode("utf-8")


def _digest(data):
    return hashlib.sha256(data).hexdigest()


def document_hash(document):
    return _digest(_document_bytes(document))


def _valid_digest(value):
    return isinstance(value, str) and HASH_PATTERN.fullmatch(value) is not None


def _uuid(value):
    if not isinstance(value, str) or str(UUID(value)) != value:
        raise InvalidFile("Неверный идентификатор версии пакета.")
    return value


def _path(name):
    if normalize_relative_path(name) != name:
        raise InvalidFile("Путь пакета не является каноническим.")
    for part in name.casefold().split("/"):
        if (
            part in {"node_modules", "__pycache__", ".git", ".data", ".venv", ".env"}
            or part.startswith(".env.")
            or part.endswith((".pyc", ".sqlite", ".sqlite3", ".db"))
        ):
            raise InvalidFile("Пакет содержит путь к кэшу, окружению или базе данных.")
    return name


@dataclass(frozen=True, slots=True)
class PackageFile:
    path: str
    byte_size: int
    sha256: str


@dataclass(frozen=True, slots=True)
class PackageRequest:
    package_id: str
    generation: int
    candidate: CandidateView
    contents: dict[str, str]
    manifest_content: str
    build_tool_id: str
    build_report: dict


@dataclass(frozen=True, slots=True)
class PackageResult:
    root: Path
    package_id: str
    generation: int
    run_id: str
    candidate_id: str
    revision: int
    profile_version: str
    profile_hash: str
    acceptance_suite_hash: str
    template_hash: str
    tree_hash: str
    payload_byte_size: int
    file_count: int
    manifest_hash: str
    manifest_byte_size: int
    archive_hash: str
    archive_byte_size: int
    files: tuple[PackageFile, ...]


def _inventory(files, limit):
    if not isinstance(files, dict) or not 1 <= len(files) <= MAX_FILES:
        raise InvalidFile("Число файлов пакета превышает лимит или файл отсутствует.")
    result, names, total = [], set(), 0
    for name, item in files.items():
        path = _path(name)
        if path.casefold() in names or not isinstance(item, dict):
            raise InvalidFile("Manifest содержит повторяющийся путь или неверные метаданные.")
        names.add(path.casefold())
        size, digest = item.get("byte_size"), item.get("sha256")
        if type(size) is not int or size < 0 or not _valid_digest(digest):
            raise InvalidFile("Некорректный размер или хэш файла пакета.")
        total += size
        if total > limit:
            raise InvalidFile("Размер файлов пакета превышает допустимый лимит.")
        result.append(PackageFile(path, size, digest))
    return tuple(sorted(result, key=lambda item: item.path)), total


def _scan(root, expected):
    if not root.is_dir():
        raise InvalidFile("Каталог закреплённой версии отсутствует.")
    seen, pending = set(), [root]
    directories = {directory.as_posix() for name in expected for directory in Path(name).parents}
    while pending:
        with os.scandir(pending.pop()) as entries:
            for entry in entries:
                name = Path(entry.path).relative_to(root).as_posix()
                path = workspace_path(root, _path(name))
                mode = path.lstat().st_mode
                if stat.S_ISDIR(mode) and name in directories:
                    pending.append(path)
                elif stat.S_ISREG(mode) and name in expected:
                    seen.add(name)
                else:
                    raise InvalidFile("Каталог пакета содержит незакреплённый файл или путь.")
    if seen != expected:
        raise InvalidFile("В каталоге пакета отсутствуют закреплённые файлы.")


def _bounded_read(root, relative, maximum):
    path = workspace_path(root, relative)
    try:
        metadata = path.lstat()
    except FileNotFoundError as error:
        raise InvalidFile("В пакете отсутствует закреплённый файл.") from error
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_size > maximum:
        raise InvalidFile("Некорректный тип или размер закреплённого файла.")
    with path.open("rb") as stream:
        data = stream.read(maximum + 1)
    if len(data) > maximum:
        raise InvalidFile("Закреплённый файл вырос во время чтения.")
    return data


def read_file(root, file):
    data = _bounded_read(root, file.path, file.byte_size)
    if len(data) != file.byte_size or _digest(data) != file.sha256:
        raise InvalidFile("Закреплённый файл изменился.")
    return data


class PackageCompiler:
    def __init__(self, tool_root=None, package_root=None, *, byte_limit=MAX_BYTES):
        if not 1024 <= byte_limit <= MAX_BYTES:
            raise ValueError("Package limit is outside the supported range.")
        self.tool_root = Path(tool_root or REPOSITORY_ROOT / ".data/tool-runs").absolute()
        self.package_root = Path(package_root or REPOSITORY_ROOT / ".data/deliveries").absolute()
        self.byte_limit = byte_limit

    def _root(self, package_id, generation):
        if type(generation) is not int or not 1 <= generation <= 2**31 - 1:
            raise InvalidFile("Неверная генерация пакета.")
        return workspace_path(self.package_root, f"{_uuid(package_id)}/g{generation}")

    def _source_payload(self, request, copy):
        candidate = request.candidate
        profile = load_profile()
        allowed = {file.relative_path for file in profile.template_files} | set().union(
            *ROLE_PATHS.values()
        )
        file_pins = {file.relative_path: file for file in candidate.files}
        if (
            candidate.status != "ready"
            or len(file_pins) != len(candidate.files)
            or file_pins.keys() != request.contents.keys()
            or file_pins.keys() != allowed
            or not (
                candidate.profile_version == profile.id
                and candidate.profile_hash == profile.profile_hash
                and candidate.acceptance_suite_hash == profile.suite_hash
                and candidate.template_hash == profile.template_hash
            )
            or tree_hash({name: file.content_hash for name, file in file_pins.items()})
            != candidate.tree_hash
        ):
            raise InvalidFile("Исходники или профиль не соответствуют закреплённому кандидату.")
        pins = {name: (file.byte_size, file.content_hash) for name, file in file_pins.items()}
        pins[SOURCE_MANIFEST] = (candidate.manifest_byte_size, candidate.manifest_hash)
        if any(type(size) is not int or size < 0 for size, _ in pins.values()):
            raise InvalidFile("Размер исходников кандидата неизвестен.")
        if sum(size for size, _ in pins.values()) > self.byte_limit:
            raise InvalidFile("Размер исходников превышает лимит пакета.")
        contents = request.contents | {SOURCE_MANIFEST: request.manifest_content}
        for name, (size, digest) in pins.items():
            content = contents[name]
            if (
                len(content) > size
                or len(content.encode("utf-8")) != size
                or text_hash(content) != digest
                or _read(workspace_path(copy, name), size) != content
            ):
                raise InvalidFile("Копия исходников Runner изменилась после сборки.")
        if json.loads(request.manifest_content, object_pairs_hook=_unique_json) != (
            _manifest_document(candidate)
        ):
            raise InvalidFile("Исходный manifest описывает другой кандидат.")
        return {name: content.encode("utf-8") for name, content in contents.items()}

    def publish(self, request):
        root = self._root(request.package_id, request.generation)
        candidate = request.candidate
        copy = workspace_path(
            self.tool_root,
            f"{_uuid(request.build_tool_id)}/{_uuid(candidate.id)}/v{candidate.revision}",
        )
        _uuid(candidate.run_id)
        _uuid(candidate.manifest_artifact_id)
        report = request.build_report
        if not isinstance(report, dict) or report.get("status") != "passed":
            raise InvalidFile("Отсутствует успешный отчёт сборки Runner.")
        build, build_size = _inventory(report.get("files"), self.byte_limit)
        names = {file.path for file in build}
        if report.get("artifact_bytes") != build_size or "index.html" not in names:
            raise InvalidFile("Отчёт Runner не описывает полную сборку.")
        dist = workspace_path(copy, DIST)
        _scan(dist, names)
        data = self._source_payload(request, copy)
        if len(data) + len(build) > MAX_FILES or (
            sum(map(len, data.values())) + build_size > self.byte_limit
        ):
            raise InvalidFile("Пакет превышает ограничения по размеру или числу файлов.")
        data.update({f"{DIST}/{file.path}": read_file(dist, file) for file in build})
        descriptors = {
            name: {"byte_size": len(value), "sha256": _digest(value)}
            for name, value in data.items()
        }
        files, payload_size = _inventory(descriptors, self.byte_limit)
        document = {
            "schema_version": 1,
            "package_id": request.package_id,
            "generation": request.generation,
            "candidate_id": candidate.id,
            "run_id": candidate.run_id,
            "revision": candidate.revision,
            "candidate_tree_hash": candidate.tree_hash,
            "candidate_manifest_artifact_id": candidate.manifest_artifact_id,
            "candidate_manifest_hash": candidate.manifest_hash,
            "profile_version": candidate.profile_version,
            "profile_hash": candidate.profile_hash,
            "acceptance_suite_hash": candidate.acceptance_suite_hash,
            "template_hash": candidate.template_hash,
            "build_tool_id": request.build_tool_id,
            "build_report_hash": document_hash(report),
            "tree_hash": tree_hash({file.path: file.sha256 for file in files}),
            "payload_byte_size": payload_size,
            "files": descriptors,
        }
        data[PACKAGE_MANIFEST] = _document_bytes(document)
        root.parent.mkdir(parents=True, exist_ok=True)
        self._root(request.package_id, request.generation)
        try:
            root.mkdir()
        except FileExistsError as error:
            raise InvalidFile("Генерация пакета уже существует и не будет перезаписана.") from error
        for name, value in sorted(data.items()):
            target = workspace_path(root, name)
            target.parent.mkdir(parents=True, exist_ok=True)
            with target.open("xb") as stream:
                stream.write(value)
        archive = workspace_path(root, ARCHIVE)
        with ZipFile(archive, "x", compression=ZIP_STORED) as zipped:
            for name, value in sorted(data.items()):
                info = ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
                info.create_system = 3
                info.external_attr = (stat.S_IFREG | 0o644) << 16
                zipped.writestr(info, value)
        archive_bytes = _bounded_read(root, ARCHIVE, self.byte_limit)
        return self.load(
            request.package_id,
            request.generation,
            manifest_hash=_digest(data[PACKAGE_MANIFEST]),
            archive_hash=_digest(archive_bytes),
            archive_byte_size=len(archive_bytes),
        )

    def load(self, package_id, generation, *, manifest_hash, archive_hash, archive_byte_size):
        root = self._root(package_id, generation)
        manifest = _bounded_read(root, PACKAGE_MANIFEST, self.byte_limit)
        if _digest(manifest) != manifest_hash:
            raise InvalidFile("Manifest пакета изменился.")
        document = json.loads(manifest, object_pairs_hook=_unique_json)
        if (
            document["schema_version"] != 1
            or document["package_id"] != package_id
            or document["generation"] != generation
        ):
            raise InvalidFile("Manifest не соответствует закреплённой генерации пакета.")
        files, size = _inventory(document["files"], self.byte_limit)
        hashes = {file.path: file.sha256 for file in files}
        digest = tree_hash(hashes)
        if (
            ARCHIVE in hashes
            or PACKAGE_MANIFEST in hashes
            or f"{DIST}/index.html" not in hashes
            or hashes.get(SOURCE_MANIFEST) != document["candidate_manifest_hash"]
            or digest != document["tree_hash"]
            or size != document["payload_byte_size"]
        ):
            raise InvalidFile("Состав пакета не соответствует manifest.")
        _scan(root, set(hashes) | {PACKAGE_MANIFEST, ARCHIVE})
        for file in files:
            read_file(root, file)
        if type(archive_byte_size) is not int or not 0 < archive_byte_size <= self.byte_limit:
            raise InvalidFile("Неверный размер ZIP пакета.")
        read_file(root, PackageFile(ARCHIVE, archive_byte_size, archive_hash))
        return PackageResult(
            root,
            package_id,
            generation,
            document["run_id"],
            document["candidate_id"],
            document["revision"],
            document["profile_version"],
            document["profile_hash"],
            document["acceptance_suite_hash"],
            document["template_hash"],
            digest,
            size,
            len(files),
            manifest_hash,
            len(manifest),
            archive_hash,
            archive_byte_size,
            files,
        )

    def verify(self, result):
        if (
            self.load(
                result.package_id,
                result.generation,
                manifest_hash=result.manifest_hash,
                archive_hash=result.archive_hash,
                archive_byte_size=result.archive_byte_size,
            )
            != result
        ):
            raise InvalidFile("Закреплённые метаданные пакета изменились.")

    def read_archive(self, result):
        self.verify(result)
        return read_file(
            result.root, PackageFile(ARCHIVE, result.archive_byte_size, result.archive_hash)
        )
