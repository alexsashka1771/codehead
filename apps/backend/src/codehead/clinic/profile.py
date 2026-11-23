"""Load trusted Clinic inputs without importing candidate implementations."""

import json
import stat
from dataclasses import dataclass, field
from pathlib import Path

from codehead.clinic.files import normalize_text as _normalize_text
from codehead.clinic.files import text_hash, tree_hash

PROFILE_ID = "clinic_demo/v1"
REPOSITORY_ROOT = Path(__file__).resolve().parents[5]
PROFILE_ROOT = REPOSITORY_ROOT / "profiles" / "clinic_demo" / "v1"
TEXT_NORMALIZATION = "utf8-bom-lf/v1"


@dataclass(frozen=True, slots=True)
class TemplateFile:
    relative_path: str
    content: str
    content_hash: str
    media_type: str


@dataclass(frozen=True, slots=True)
class ClinicProfile:
    id: str
    timezone: str
    slot_minutes: int
    profile_hash: str
    suite_hash: str
    template_hash: str
    template_files: tuple[TemplateFile, ...]
    root: Path
    _definition_json: str = field(repr=False)
    _schemas_json: str = field(repr=False)

    @property
    def definition(self) -> dict:
        """Return a JSON snapshot; mutation cannot alter this pinned profile."""
        return json.loads(self._definition_json)

    @property
    def schemas(self) -> dict:
        return json.loads(self._schemas_json)


def normalize_text(content: str | bytes) -> str:
    """Decode strict UTF-8 and share the manifest normalization algorithm."""
    return _normalize_text(content.decode("utf-8") if isinstance(content, bytes) else content)


def _read_text(path: Path) -> str:
    attributes = path.lstat()
    if path.is_symlink() or getattr(attributes, "st_file_attributes", 0) & getattr(
        stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0
    ):
        raise ValueError("Trusted profile files must not be reparse points.")
    return normalize_text(path.read_bytes())


def _media_type(path: Path) -> str:
    return {
        ".py": "text/x-python",
        ".json": "application/json",
        ".html": "text/html",
        ".ts": "text/typescript",
        ".tsx": "text/typescript",
        ".css": "text/css",
    }.get(path.suffix, "text/plain")


def _files(root: Path, *, python_only: bool = False) -> tuple[TemplateFile, ...]:
    files = []
    for path in sorted(root.rglob("*")):
        if not path.is_file() or "__pycache__" in path.parts:
            continue
        if python_only and path.suffix != ".py":
            continue
        content = _read_text(path)
        files.append(
            TemplateFile(
                relative_path=path.relative_to(root).as_posix(),
                content=content,
                content_hash=text_hash(content),
                media_type=_media_type(path),
            )
        )
    if not files:
        raise ValueError("A trusted profile source boundary is empty.")
    return tuple(files)


def load_profile(root: Path | None = None) -> ClinicProfile:
    """Read and hash only profile, schemas, acceptance Python and template files."""
    root = (root or PROFILE_ROOT).resolve()
    definition_json = _read_text(root / "profile.json")
    schemas_json = _read_text(root / "schemas.json")
    definition = json.loads(definition_json)
    schemas = json.loads(schemas_json)
    if (
        definition.get("id") != PROFILE_ID
        or definition.get("timezone") != "Asia/Yekaterinburg"
        or definition.get("slot_minutes") != 30
        or schemas.get("$schema") != "https://json-schema.org/draft/2020-12/schema"
    ):
        raise ValueError("The Clinic Demo v1 identity or fixed boundary is invalid.")
    suite_files = _files(root / "acceptance", python_only=True)
    template_files = _files(root / "template")
    return ClinicProfile(
        id=PROFILE_ID,
        timezone=definition["timezone"],
        slot_minutes=definition["slot_minutes"],
        profile_hash=tree_hash(
            {"profile.json": text_hash(definition_json), "schemas.json": text_hash(schemas_json)}
        ),
        suite_hash=tree_hash({item.relative_path: item.content_hash for item in suite_files}),
        template_hash=tree_hash({item.relative_path: item.content_hash for item in template_files}),
        template_files=template_files,
        root=root,
        _definition_json=definition_json,
        _schemas_json=schemas_json,
    )
