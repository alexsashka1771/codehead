"""Normalized file proposals and Windows-aware workspace boundaries."""

import hashlib
import ntpath
import re
import stat
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path

from codehead.contracts import FileProposal

ROLE_PATHS = {
    "backend": frozenset(
        ("backend/clinic_api.py", "backend/clinic_storage.py", "backend/clinic_models.py")
    ),
    "frontend": frozenset(
        ("frontend/src/App.tsx", "frontend/src/api.ts", "frontend/src/styles.css")
    ),
}
RESERVED = re.compile(r"^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)", re.IGNORECASE)
HASH_PATTERN = re.compile(r"^[a-f0-9]{64}$")


class InvalidFile(ValueError):
    """Safe validation errors never include proposal content or absolute paths."""

    code = "invalid_file_proposal"


class FileConflict(InvalidFile):
    code = "file_version_conflict"

    def __init__(self, relative_path):
        self.relative_path = relative_path
        super().__init__(f"Основа файла {relative_path} изменилась; набор не применён.")


@dataclass(frozen=True)
class PreparedFile:
    relative_path: str
    base_hash: str | None
    media_type: str
    content: str
    content_hash: str
    byte_size: int


def validate_text(content: str) -> str:
    if not isinstance(content, str) or "\x00" in content:
        raise InvalidFile("Файл должен содержать текст без NUL.")
    try:
        content.encode("utf-8", errors="strict")
    except UnicodeEncodeError as error:
        raise InvalidFile("Содержимое файла не является корректным UTF-8.") from error
    return content


def normalize_text(content: str) -> str:
    """Normalize a raw UTF-8 input once; stored normalized text must not re-enter here."""
    return validate_text(content).removeprefix("\ufeff").replace("\r\n", "\n").replace("\r", "\n")


def text_hash(content: str) -> str:
    """Hash already normalized content without discarding a leading content character."""
    return hashlib.sha256(validate_text(content).encode("utf-8")).hexdigest()


def normalize_relative_path(value: str) -> str:
    if not isinstance(value, str) or not value or len(value) > 240 or ntpath.isabs(value):
        raise InvalidFile("Нужен относительный путь внутри workspace.")
    if not re.fullmatch(r"[A-Za-z0-9_.\\/-]+", value):
        raise InvalidFile("Путь содержит недопустимые символы или алиас Windows.")
    path = value.replace("\\", "/")
    for component in path.split("/"):
        if (
            not component
            or component in {".", ".."}
            or component.endswith((".", " "))
            or RESERVED.match(component)
        ):
            raise InvalidFile("Недопустимый компонент пути Windows.")
    return path


def validate_batch(
    role: str,
    proposals: Sequence[FileProposal],
    current: Mapping[str, str],
    *,
    max_file_bytes=65536,
    max_files=4,
    max_total_bytes=262144,
) -> tuple[PreparedFile, ...]:
    if role not in ROLE_PATHS or not 1 <= len(proposals) <= max_files:
        raise InvalidFile("Неверная роль или число файлов предложения.")
    allowed = {path.casefold(): path for path in ROLE_PATHS[role]}
    current_hashes = {path.casefold(): value for path, value in current.items()}
    seen = set()
    prepared = []
    total = 0
    for proposal in proposals:
        proposed_path = normalize_relative_path(proposal.relative_path)
        path = allowed.get(proposed_path.casefold())
        if path is None or path.casefold() in seen:
            raise InvalidFile("Файл вне области роли или дублирует путь Windows.")
        seen.add(path.casefold())
        extension = path.rsplit(".", 1)[-1]
        media_types = {
            "py": {"text/plain", "text/x-python"},
            "ts": {"text/plain", "text/typescript"},
            "tsx": {"text/plain", "text/typescript", "text/tsx"},
            "css": {"text/plain", "text/css"},
        }
        if proposal.media_type not in media_types[extension]:
            raise InvalidFile("Media type не соответствует прикладному файлу.")
        content = normalize_text(proposal.content)
        data = content.encode("utf-8")
        total += len(data)
        if len(data) > max_file_bytes or total > max_total_bytes:
            raise InvalidFile("Предложение превышает закреплённый лимит байтов.")
        if current_hashes.get(path.casefold()) != proposal.base_hash:
            raise FileConflict(path)
        prepared.append(
            PreparedFile(
                path,
                proposal.base_hash,
                proposal.media_type,
                content,
                hashlib.sha256(data).hexdigest(),
                len(data),
            )
        )
    return tuple(prepared)


def tree_hash(files: Mapping[str, str]) -> str:
    normalized = {}
    seen = set()
    for relative_path, content_hash in files.items():
        path = normalize_relative_path(relative_path)
        if path.casefold() in seen or not HASH_PATTERN.fullmatch(content_hash):
            raise InvalidFile("Некорректный manifest дерева.")
        seen.add(path.casefold())
        normalized[path] = content_hash
    value = "".join(f"{path}\0{normalized[path]}\n" for path in sorted(normalized))
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def workspace_path(root: Path, relative_path: str) -> Path:
    path = normalize_relative_path(relative_path)
    root = Path(root).absolute()
    target = root.joinpath(*path.split("/"))
    for component in reversed((target, *target.parents)):
        try:
            metadata = component.lstat()
        except FileNotFoundError:
            continue
        if getattr(metadata, "st_file_attributes", 0) & 0x400 or stat.S_ISLNK(metadata.st_mode):
            raise InvalidFile("Reparse point или symlink запрещён в пути workspace.")
    canonical_root = root.resolve()
    canonical_target = target.resolve()
    if not canonical_target.is_relative_to(canonical_root):
        raise InvalidFile("Путь вышел за канонический корень workspace.")
    return target
