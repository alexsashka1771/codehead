"""Typed QA analysis of trusted tool evidence; never assigns workflow status."""

import json

from pydantic import ValidationError

from codehead.clinic.workspace import _unique_json
from codehead.contracts import Bug, QualityPins, TestReport
from codehead.llm.provider import ArtifactDraft, ProviderFailure

REQUIREMENTS = tuple(f"REQ-{number:03d}" for number in range(1, 9))
HTTP_REQUIREMENTS = {"REQ-001", "REQ-002", "REQ-003", "REQ-004", "REQ-005", "REQ-007"}


def evidence_status(context):
    if not isinstance(context, dict) or not isinstance(context.get("tools"), list):
        raise ProviderFailure("invalid_quality_evidence", "Неверный формат входа QA.")
    tools = context["tools"]
    if any(
        not isinstance(tool, dict)
        or not {"id", "operation_id", "status", "exit_code", "error_code", "report"}.issubset(tool)
        for tool in tools
    ):
        raise ProviderFailure("invalid_quality_evidence", "Неверный формат проверки QA.")
    if len(tools) != 3 or {tool["operation_id"] for tool in tools} != {
        "validate_backend",
        "test_backend",
        "build_frontend",
    }:
        raise ProviderFailure("invalid_quality_evidence", "Нужны три закреплённые проверки.")
    try:
        QualityPins.model_validate(context.get("pins"), strict=True)
        if (
            not isinstance(context.get("cycle_id"), str)
            or type(context.get("iteration")) is not int
            or context["iteration"] not in {0, 1, 2}
            or not isinstance(context.get("prior_bug_ids"), list)
            or any(not isinstance(value, str) for value in context["prior_bug_ids"])
            or not isinstance(context.get("execution_tree_hash"), str)
            or len(context["execution_tree_hash"]) != 64
        ):
            raise ValueError("Invalid QA metadata")
    except (ValidationError, ValueError) as failure:
        raise ProviderFailure(
            "invalid_quality_evidence", "Неверные закреплённые версии QA."
        ) from failure
    for tool in tools:
        if (
            tool["status"] not in {"succeeded", "failed"}
            or (
                tool["status"] == "succeeded"
                and (tool.get("exit_code") != 0 or tool.get("error_code"))
            )
            or (tool["status"] == "failed" and tool.get("error_code") != "tool_failed")
        ):
            raise ProviderFailure(
                "quality_technical_failure", "Проверка имеет технический или неизвестный исход."
            )
    http = next(tool for tool in tools if tool["operation_id"] == "test_backend")
    if http["status"] == "failed" and http.get("exit_code") != 1:
        raise ProviderFailure(
            "quality_technical_failure", "HTTP-suite завершился инфраструктурной ошибкой pytest."
        )
    report = http.get("report")
    if (
        not isinstance(report, dict)
        or report.get("status") != ("passed" if http["status"] == "succeeded" else "failed")
        or report.get("exit_code") != http.get("exit_code")
    ):
        raise ProviderFailure(
            "invalid_quality_evidence", "HTTP-отчёт не соответствует исходу проверки."
        )
    pins = context["pins"]
    expected = {
        "profile_hash": pins["profile_hash"],
        "profile_hash_after": pins["profile_hash"],
        "suite_hash": pins["acceptance_suite_hash"],
        "suite_hash_after": pins["acceptance_suite_hash"],
        "candidate_hash": context["execution_tree_hash"],
        "candidate_hash_after": context["execution_tree_hash"],
        "isolation_level": "process_only",
    }
    if any(report.get(name) != value for name, value in expected.items()):
        raise ProviderFailure(
            "invalid_quality_evidence", "HTTP-отчёт ссылается на другую версию или проверки."
        )
    if any(tool["status"] == "failed" for tool in tools if tool["operation_id"] != "test_backend"):
        raise ProviderFailure(
            "quality_technical_failure", "Python или сборка не завершились успешно."
        )
    return "passed" if http["status"] == "succeeded" else "failed"


def drafts(context):
    status = evidence_status(context)
    ids = [tool["id"] for tool in context["tools"]]
    http_id = next(
        tool["id"] for tool in context["tools"] if tool["operation_id"] == "test_backend"
    )
    build_id = next(
        tool["id"] for tool in context["tools"] if tool["operation_id"] == "build_frontend"
    )
    common = context["pins"] | {"cycle_id": context["cycle_id"], "iteration": context["iteration"]}
    report = TestReport(
        **common,
        status=status,
        tool_run_ids=ids,
        requirements=[
            {
                "requirement_id": requirement,
                "tool_run_ids": [build_id] if requirement == "REQ-006" else [http_id],
                "status": "passed"
                if status == "passed" and requirement in HTTP_REQUIREMENTS
                else "not_verified",
            }
            for requirement in REQUIREMENTS
        ],
        proposed_tests=[
            {
                "title": "Повторить конкурентную запись при нескольких независимых worker",
                "requirement_ids": ["REQ-003"],
                "status": "proposed",
            }
        ],
        resolves_bug_ids=context["prior_bug_ids"] if status == "passed" else [],
    )
    result = [
        ArtifactDraft("test_report", report.model_dump_json(indent=2) + "\n", "application/json")
    ]
    if status == "failed":
        bug = Bug(
            **common,
            tool_run_ids=[http_id],
            requirement_ids=sorted(HTTP_REQUIREMENTS),
            summary=(
                "Внешний HTTP-suite выявил нарушение Clinic Demo. "
                "См. полный вывод закреплённой проверки."
            ),
        )
        result.append(
            ArtifactDraft("bug", bug.model_dump_json(indent=2) + "\n", "application/json")
        )
    return tuple(result), f"QA iteration {context['iteration']}: {status} from pinned tools."


def validate_output(context, artifacts):
    expected_status = evidence_status(context)
    try:
        reports = [
            TestReport.model_validate(
                json.loads(draft.content, object_pairs_hook=_unique_json), strict=True
            )
            for draft in artifacts
            if draft.artifact_type == "test_report"
        ]
        bugs = [
            Bug.model_validate(
                json.loads(draft.content, object_pairs_hook=_unique_json), strict=True
            )
            for draft in artifacts
            if draft.artifact_type == "bug"
        ]
        if len(reports) != 1 or len(bugs) != (expected_status == "failed"):
            raise ValueError("Wrong QA document set")
        report = reports[0]
        ids = [tool["id"] for tool in context["tools"]]
        http = next(tool for tool in context["tools"] if tool["operation_id"] == "test_backend")
        build = next(tool for tool in context["tools"] if tool["operation_id"] == "build_frontend")
        for document in [report, *bugs]:
            if (
                any(getattr(document, name) != value for name, value in context["pins"].items())
                or document.cycle_id != context["cycle_id"]
                or document.iteration != context["iteration"]
            ):
                raise ValueError("Foreign QA pins")
        if report.status != expected_status or report.tool_run_ids != ids:
            raise ValueError("QA report claims an unverified outcome")
        if len(report.requirements) != 8 or {
            check.requirement_id for check in report.requirements
        } != set(REQUIREMENTS):
            raise ValueError("Incomplete requirement map")
        for check in report.requirements:
            tool = build if check.requirement_id == "REQ-006" else http
            expected = (
                "passed"
                if expected_status == "passed" and check.requirement_id in HTTP_REQUIREMENTS
                else "not_verified"
            )
            if check.tool_run_ids != [tool["id"]] or check.status != expected:
                raise ValueError("Requirement references wrong evidence")
        if any(
            not set(item.requirement_ids).issubset(REQUIREMENTS) or not item.requirement_ids
            for item in report.proposed_tests
        ):
            raise ValueError("Foreign proposed requirement")
        if report.resolves_bug_ids != (
            context["prior_bug_ids"] if expected_status == "passed" else []
        ):
            raise ValueError("Wrong bug resolution chain")
        for bug in bugs:
            if (
                bug.tool_run_ids != [http["id"]]
                or not bug.requirement_ids
                or not set(bug.requirement_ids).issubset(REQUIREMENTS)
            ):
                raise ValueError("Foreign bug evidence")
        if any(draft.media_type != "application/json" for draft in artifacts):
            raise ValueError("QA documents must be JSON")
    except (ValidationError, ValueError, KeyError, TypeError) as failure:
        raise ProviderFailure(
            "invalid_quality_output",
            "QA вернул неверный статус, ссылки или закреплённые версии.",
            dispatched=True,
        ) from failure
    return report, bugs
