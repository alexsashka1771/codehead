"""Versioned test file outputs; no model commands or implicit live fallback."""

import json
import os

from codehead.clinic.files import ROLE_PATHS, InvalidFile, normalize_text, workspace_path
from codehead.clinic.profile import PROFILE_ROOT, load_profile
from codehead.contracts import FileProposal
from codehead.llm.provider import ProviderFailure
from codehead.llm.redaction import redact


def _source_literal(value):
    # Escaped delimiters preserve the string through later credential redaction.
    return json.dumps(value).translate(
        {ord(" "): r"\u0020", ord(":"): r"\u003a", ord("="): r"\u003d"}
    )


def clean_file_bases(request):
    profile = load_profile()
    if (
        request.profile_version != profile.id
        or request.profile_hash != profile.profile_hash
        or request.acceptance_suite_hash != profile.suite_hash
    ):
        raise ProviderFailure(
            "input_version_conflict", "Закреплённый профиль или проверки изменились."
        )
    if not isinstance(request.candidate_files, tuple):
        raise ProviderFailure("invalid_file_bases", "Неверная основа файлов кандидата.")
    inputs = {item["id"]: item for item in request.inputs}
    if len(inputs) != len(request.inputs):
        raise ProviderFailure("invalid_file_bases", "Идентификаторы входных версий повторяются.")
    allowed = ROLE_PATHS[request.role]
    bases, seen = [], set()
    for value in request.candidate_files:
        if not isinstance(value, dict) or set(value) != {
            "relative_path",
            "base_hash",
            "artifact_id",
            "version",
        }:
            raise ProviderFailure("invalid_file_bases", "Неверные поля основы файла.")
        path = value["relative_path"]
        if not isinstance(path, str) or path not in allowed or path in seen:
            raise ProviderFailure(
                "invalid_file_bases", "Основа вне области роли или путь повторяется."
            )
        seen.add(path)
        digest, artifact_id, version = value["base_hash"], value["artifact_id"], value["version"]
        if digest is None:
            if artifact_id is not None or version is not None:
                raise ProviderFailure("invalid_file_bases", "Новый файл имеет неверную основу.")
        else:
            source = inputs.get(artifact_id) if isinstance(artifact_id, str) else None
            if (
                not isinstance(digest, str)
                or len(digest) != 64
                or any(character not in "0123456789abcdef" for character in digest)
                or type(version) is not int
                or version < 1
                or source is None
                or source["artifact_type"] != "source_code"
                or source["relative_path"] != path
                or source["content_hash"] != digest
                or source["version"] != version
            ):
                raise ProviderFailure(
                    "invalid_file_bases", "Хэш или версия основы не закреплены входом."
                )
        bases.append(
            {
                "relative_path": path,
                "base_hash": digest,
                "artifact_id": artifact_id,
                "version": version,
            }
        )
    if seen != allowed:
        raise ProviderFailure("invalid_file_bases", "Нужен полный список основы файлов роли.")
    referenced = {base["artifact_id"] for base in bases if base["artifact_id"] is not None}
    documents = {"requirements", "architecture", "api_contract", "decision"}
    if request.repair_context is not None:
        documents |= {"bug", "test_report", "tool_report"}
    if any(
        item["artifact_type"] not in documents
        and not (item["artifact_type"] == "source_code" and item["id"] in referenced)
        for item in request.inputs
    ):
        raise ProviderFailure(
            "invalid_file_bases", "Вход содержит документ вне предков или незакреплённый исходник."
        )
    return tuple(bases)


def propose_files(request, secrets):
    bases = {value["relative_path"]: value for value in request.candidate_files}
    files = []
    for path in sorted(ROLE_PATHS[request.role]):
        name = path.rsplit("/", 1)[-1]
        try:
            source = workspace_path(PROFILE_ROOT / "fixtures", f"{request.role}/{name}")
            with source.open("rb") as stream:
                maximum = 65536 * 2 + 3
                if os.fstat(stream.fileno()).st_size > maximum:
                    raise InvalidFile("Fixture превышает допустимый размер.")
                raw = stream.read(maximum + 1)
            if len(raw) > maximum:
                raise InvalidFile("Fixture вырос сверх допустимого размера.")
            content = raw.decode("utf-8", errors="strict")
            if (
                request.repair_context is not None
                and path == "backend/clinic_storage.py"
                and request.repair_context["test_scenario"] != "standard"
            ):
                from codehead.clinic.quality_fixtures import repair_storage_fixture

                fixture = repair_storage_fixture(
                    request.repair_context["test_scenario"], request.repair_context["iteration"]
                )
                content = fixture.content
            if path == "frontend/src/App.tsx":
                marker = 'const CLINIC_NAME = "Clinic Demo";'
                if content.count(marker) != 1:
                    raise InvalidFile("Fixture не содержит однозначный маркер имени проекта.")
                content = content.replace(
                    marker, "const CLINIC_NAME = " + _source_literal(request.project_name) + ";"
                )
            content = redact(content, secrets)
            if len(normalize_text(content).encode("utf-8")) > 65536:
                raise InvalidFile("Fixture превышает лимит нормализованного файла.")
        except (OSError, UnicodeError, InvalidFile) as error:
            raise ProviderFailure(
                "fixture_unavailable",
                "Тестовые файлы роли недоступны или повреждены.",
                dispatched=True,
            ) from error
        media_type = (
            "text/x-python"
            if path.endswith(".py")
            else "text/css"
            if path.endswith(".css")
            else "text/typescript"
        )
        files.append(
            FileProposal(
                relative_path=path,
                base_hash=bases[path]["base_hash"],
                media_type=media_type,
                content=content,
            )
        )
    return (
        tuple(files),
        f"Test {request.role}: прикладные файлы {request.project_name} "
        "по закреплённым требованиям и архитектуре. Проверки и preview выполняются отдельно.",
    )
