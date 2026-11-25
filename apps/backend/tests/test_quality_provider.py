from dataclasses import replace

import pytest

from codehead.llm.provider import ProviderFailure, ProviderRequest
from codehead.llm.quality_provider import evidence_status
from codehead.llm.test_provider import TestProvider


def request(context):
    inputs = tuple(
        {
            "id": kind,
            "version": 1,
            "artifact_type": kind,
            "content": kind,
            "content_hash": "a" * 64,
            "relative_path": f"{kind}.md",
        }
        for kind in ("requirements", "architecture", "api_contract", "decision")
    )
    return ProviderRequest(
        "qa", "Clinic", "Synthetic clinic appointments.", 1, inputs, quality_context=context
    )


@pytest.mark.parametrize("context", [None, "text", {}, {"tools": []}, {"tools": "text"}])
def test_malformed_quality_request_has_a_safe_provider_failure(context):
    with pytest.raises(ProviderFailure):
        TestProvider(with_files=True).prepare(request(context))


def test_quality_context_is_not_allowed_on_document_role():
    with pytest.raises(ProviderFailure):
        TestProvider().prepare(replace(request({}), role="product_manager"))


@pytest.mark.parametrize("exit_code", [2, 3, 4, 5])
def test_pytest_infrastructure_exit_is_not_a_domain_bug(exit_code):
    pins = {
        "run_id": "run",
        "task_id": "qa",
        "candidate_id": "candidate",
        "revision": 3,
        "tree_hash": "a" * 64,
        "manifest_artifact_id": "manifest",
        "manifest_hash": "b" * 64,
        "profile_version": "clinic_demo/v1",
        "profile_hash": "c" * 64,
        "acceptance_suite_hash": "d" * 64,
        "template_hash": "e" * 64,
    }
    report = {
        "status": "failed",
        "exit_code": exit_code,
        "profile_hash": pins["profile_hash"],
        "profile_hash_after": pins["profile_hash"],
        "suite_hash": pins["acceptance_suite_hash"],
        "suite_hash_after": pins["acceptance_suite_hash"],
        "candidate_hash": "f" * 64,
        "candidate_hash_after": "f" * 64,
        "isolation_level": "process_only",
    }
    tools = [
        {
            "id": operation,
            "operation_id": operation,
            "status": "succeeded",
            "exit_code": 0,
            "error_code": None,
            "report": None,
        }
        for operation in ("validate_backend", "test_backend", "build_frontend")
    ]
    tools[1].update(status="failed", exit_code=exit_code, error_code="tool_failed", report=report)
    context = {
        "cycle_id": "cycle",
        "iteration": 0,
        "pins": pins,
        "prior_bug_ids": [],
        "execution_tree_hash": "f" * 64,
        "tools": tools,
    }
    with pytest.raises(ProviderFailure):
        evidence_status(context)
