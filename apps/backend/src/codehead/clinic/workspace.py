"""Materialize committed source snapshots without executing or overwriting code."""

import json
import os
import stat
from pathlib import Path
from uuid import UUID

from codehead.clinic.files import (
    InvalidFile,
    normalize_text,
    text_hash,
    tree_hash,
    validate_text,
    workspace_path,
)
from codehead.contracts import CandidateView


def _manifest_document(candidate):
    return {
        "candidate_id": candidate.id,
        "run_id": candidate.run_id,
        "revision": candidate.revision,
        "profile_version": candidate.profile_version,
        "profile_hash": candidate.profile_hash,
        "acceptance_suite_hash": candidate.acceptance_suite_hash,
        "template_hash": candidate.template_hash,
        "tree_hash": candidate.tree_hash,
        "normalization_version": "utf8-lf-v1",
        "files": [file.model_dump(mode="json") for file in candidate.files],
    }


def _unique_json(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise InvalidFile("Manifest содержит повторяющиеся поля.")
        value[key] = item
    return value


def _read(path):
    try:
        return normalize_text(path.read_bytes().decode("utf-8", errors="strict"))
    except UnicodeDecodeError as error:
        raise InvalidFile("Файл workspace не является корректным UTF-8.") from error


def _scan_existing(root, expected):
    if not root.exists():
        return
    pending = [root]
    while pending:
        directory = pending.pop()
        for child in directory.iterdir():
            relative = child.relative_to(root).as_posix()
            safe = workspace_path(root, relative)
            metadata = safe.lstat()
            if stat.S_ISDIR(metadata.st_mode):
                pending.append(safe)
            elif not stat.S_ISREG(metadata.st_mode) or relative.casefold() not in expected:
                raise InvalidFile("Workspace содержит неучтённые файлы; версия не перезаписана.")


def materialize(
    root: Path, candidate: CandidateView, contents: dict[str, str], manifest_content: str
):
    try:
        identity = str(UUID(candidate.id))
    except ValueError as error:
        raise InvalidFile("Неверный идентификатор workspace кандидата.") from error
    if identity != candidate.id or candidate.status not in {"materializing", "ready"}:
        raise InvalidFile("Версия кандидата не готова к материализации.")
    files = {file.relative_path: file for file in candidate.files}
    if len(files) != len(candidate.files) or files.keys() != contents.keys():
        raise InvalidFile("Содержимое не соответствует полному committed manifest.")
    expected = {}
    for path, file in files.items():
        content = validate_text(contents[path])
        if (
            text_hash(content) != file.content_hash
            or len(content.encode("utf-8")) != file.byte_size
        ):
            raise InvalidFile("Хэш или размер файла не соответствует committed manifest.")
        expected[path] = content
    if tree_hash({path: file.content_hash for path, file in files.items()}) != candidate.tree_hash:
        raise InvalidFile("Хэш дерева кандидата не соответствует committed manifest.")
    manifest_content = validate_text(manifest_content)
    if (
        text_hash(manifest_content) != candidate.manifest_hash
        or len(manifest_content.encode("utf-8")) != candidate.manifest_byte_size
    ):
        raise InvalidFile("Хэш или размер immutable manifest не соответствует committed артефакту.")
    try:
        manifest = json.loads(manifest_content, object_pairs_hook=_unique_json)
    except json.JSONDecodeError as error:
        raise InvalidFile("Manifest не является завершённым JSON.") from error
    if manifest != _manifest_document(candidate):
        raise InvalidFile("Manifest описывает другую версию или другой состав кандидата.")
    expected[".codehead/manifest.json"] = manifest_content
    version = f"{identity}/v{candidate.revision}"
    root = Path(root).absolute()
    destination = workspace_path(root, f"{version}/.codehead/manifest.json").parents[1]
    _scan_existing(destination, {path.casefold() for path in expected})
    targets = {path: workspace_path(destination, path) for path in expected}
    for path, target in targets.items():
        if target.exists() and text_hash(_read(target)) != text_hash(expected[path]):
            raise InvalidFile("Файл версии изменён; существующее содержимое сохранено.")
    for path, target in targets.items():
        if not target.exists():
            target.parent.mkdir(parents=True, exist_ok=True)
            workspace_path(destination, path)
            with target.open("xb") as stream:
                # A leading U+FEFF in normalized content is data, not the encoding marker.
                marker = b"\xef\xbb\xbf" if expected[path].startswith("\ufeff") else b""
                stream.write(marker + expected[path].encode("utf-8"))
                stream.flush()
                os.fsync(stream.fileno())
        workspace_path(destination, path)
        if text_hash(_read(target)) != text_hash(expected[path]):
            raise InvalidFile("Записанный файл не прошёл проверку хэша.")
    _scan_existing(destination, {path.casefold() for path in expected})
    return destination
