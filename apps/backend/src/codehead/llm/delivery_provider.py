"""Typed deployment documentation from independently verified delivery evidence."""

import json
from typing import Literal

from pydantic import Field

from codehead.clinic.files import text_hash
from codehead.clinic.workspace import _unique_json
from codehead.contracts import Contract, Digest, QualityPins, TestReport
from codehead.delivery.package import document_hash
from codehead.llm.provider import ArtifactDraft, ProviderFailure


class DeploymentPackage(QualityPins):
    schema_version: Literal[1] = 1
    source: Literal["test"] = "test"
    package_id: str
    package_generation: int = Field(ge=1)
    package_manifest_hash: Digest
    package_manifest_byte_size: int = Field(ge=1)
    package_tree_hash: Digest
    package_archive_hash: Digest
    package_archive_byte_size: int = Field(ge=1)
    package_payload_byte_size: int = Field(ge=1)
    package_file_count: int = Field(ge=1)
    qa_cycle_id: str
    qa_report_artifact_id: str
    qa_report_hash: Digest
    build_tool_run_id: str
    build_report_artifact_id: str
    build_report_hash: Digest
    smoke_tool_run_id: str
    smoke_report_artifact_id: str
    smoke_report_hash: Digest


class SmokeEvidence(Contract):
    status: Literal["passed"]
    package_tree_hash: Digest
    health_status: Literal[200]
    index_status: Literal[200]
    fresh_database: Literal[True]
    owned_processes_stopped: Literal[True]


def smoke_passed(report, tree_hash):
    try:
        evidence = SmokeEvidence.model_validate(report, strict=True)
    except ValueError:
        return False
    return evidence.package_tree_hash == tree_hash


def validate_inputs(request):
    try:
        context = request.delivery_context
        package = DeploymentPackage.model_validate(context["package"], strict=True)
        build = context["build_report"]
        reports = {item["artifact_type"]: item for item in request.inputs}
        refs = {
            "candidate_manifest": (package.manifest_artifact_id, package.manifest_hash),
            "test_report": (package.qa_report_artifact_id, package.qa_report_hash),
            "tool_report": (package.build_report_artifact_id, None),
            "smoke_report": (package.smoke_report_artifact_id, package.smoke_report_hash),
        }
        if len(request.inputs) != len(refs) or reports.keys() != refs.keys():
            raise ValueError("Delivery input roles must be exact")
        for kind, (artifact_id, expected_hash) in refs.items():
            item = reports[kind]
            if (
                item["id"] != artifact_id
                or item["content_hash"] != text_hash(item["content"])
                or expected_hash is not None
                and expected_hash != item["content_hash"]
            ):
                raise ValueError("Delivery input has changed")
        qa = TestReport.model_validate_json(reports["test_report"]["content"], strict=True)
        runner = json.loads(reports["tool_report"]["content"], object_pairs_hook=_unique_json)
        smoke = json.loads(reports["smoke_report"]["content"], object_pairs_hook=_unique_json)
        common_pins = QualityPins.model_fields.keys() - {"task_id"}
        if (
            qa.status != "passed"
            or qa.cycle_id != package.qa_cycle_id
            or any(getattr(qa, name) != getattr(package, name) for name in common_pins)
            or runner["operation_id"] != "build_frontend"
            or runner["status"] != "succeeded"
            or runner["exit_code"] != 0
            or runner["cycle_id"] != qa.cycle_id
            or runner["tool_run_id"] != package.build_tool_run_id
            or package.build_tool_run_id not in qa.tool_run_ids
            or runner["build_report_hash"] != package.build_report_hash
            or not isinstance(build, dict)
            or build.get("status") != "passed"
            or document_hash(build) != package.build_report_hash
            or smoke["tool_run_id"] != package.smoke_tool_run_id
            or smoke["package_id"] != package.package_id
            or smoke["package_generation"] != package.package_generation
            or smoke["status"] != "succeeded"
            or not smoke_passed(smoke["report"], package.package_tree_hash)
        ):
            raise ValueError("Delivery gates do not match the pinned package")
    except (KeyError, TypeError, ValueError) as failure:
        raise ProviderFailure(
            "invalid_delivery_evidence", "Доказательства доставки не соответствуют пакету."
        ) from failure
    return package


def drafts(request):
    package = validate_inputs(request)
    runbook = (
        "# Локальный запуск Clinic Demo\n\n"
        f"Пакет `{package.package_id}`, генерация {package.package_generation}, "
        f"ревизия кандидата {package.revision}.\n\n"
        f"SHA-256 ZIP `{package.package_archive_hash}`. "
        f"Manifest пакета `{package.package_manifest_hash}`.\n\n"
        "1. Откройте доставку в инспекторе выбранного запуска и скачайте ZIP.\n"
        "2. Нажмите «Запустить preview» и дождитесь статуса готовности. "
        "Чтобы загрузить приложение, нажмите «Открыть».\n"
        "3. Для завершения нажмите «Остановить». Следующий старт этого пакета "
        "использует сохранённую локальную базу Clinic Demo.\n\n"
        "Inspect: перед интерактивным запуском smoke проверил HTTP 200 от /health и /, "
        "пустой список врачей в свежей SQLite и остановку собственного дерева.\n\n"
        f"QA `{package.qa_report_artifact_id}`, сборка `{package.build_tool_run_id}`, "
        f"smoke `{package.smoke_report_artifact_id}`.\n\n"
        "Профиль test. Preview использует loopback и изоляцию process_only.\n"
    )
    return (
        ArtifactDraft(
            "deployment_package", package.model_dump_json(indent=2) + "\n", "application/json"
        ),
        ArtifactDraft("runbook", runbook),
    ), "Статический пакет и локальная инструкция по подтверждённым результатам QA и smoke."


def validate_output(request, result):
    expected, _ = drafts(request)
    try:
        raw = json.loads(result.raw_response, object_pairs_hook=_unique_json)
        from dataclasses import asdict

        valid = {item.artifact_type: item for item in result.artifacts} == {
            item.artifact_type: item for item in expected
        } and raw == {
            "artifacts": [asdict(item) for item in result.artifacts],
            "summary": result.summary,
        }
    except (TypeError, ValueError):
        valid = False
    if not valid:
        raise ProviderFailure(
            "invalid_provider_output",
            "Документы DevOps не соответствуют закреплённым результатам.",
            dispatched=True,
            raw_response=result.raw_response,
            stop_reason=result.stop_reason,
        )
