import pytest
from pydantic import ValidationError

from codehead.contracts import CreateProject, RunLimits, StartRun


def test_default_file_limits_preserve_legacy_start_receipt_hash():
    import hashlib
    import json

    from codehead.persistence.service import payload_hash

    payload = StartRun(mode="test").model_dump(mode="json")
    payload.pop("workflow_version")
    payload.pop("test_scenario")
    for field in ("max_file_bytes", "max_files_per_proposal", "max_proposal_bytes"):
        payload["limits"].pop(field)
    legacy = hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    assert payload_hash(StartRun(mode="test")) == legacy
    assert payload_hash(StartRun(mode="test", limits=RunLimits(max_file_bytes=16384))) != legacy


@pytest.mark.parametrize("name", ["", "  ", "a" * 121])
def test_project_requires_a_non_empty_bounded_name(name):
    with pytest.raises(ValidationError):
        CreateProject(name=name, description="A synthetic clinic application")


def test_only_supported_product_profile_is_accepted():
    with pytest.raises(ValidationError):
        CreateProject(
            name="Clinic", description="A synthetic clinic application", profile="anything"
        )


@pytest.mark.parametrize(
    "limits",
    [
        {"max_parallel_tasks": 3},
        {"max_repair_iterations": 3},
        {"max_llm_calls": 0},
        {"max_tokens": -1},
        {"max_cost_usd": float("inf")},
        {"max_cost_usd": 0},
    ],
)
def test_run_rejects_invalid_limits(limits):
    with pytest.raises(ValidationError):
        RunLimits(**limits)


def test_start_never_silently_accepts_fake_mode():
    with pytest.raises(ValidationError):
        StartRun(mode="fake")


def test_unknown_command_fields_are_not_treated_as_permissions():
    with pytest.raises(ValidationError):
        StartRun(allow_shell=True)


def test_call_guard_is_secondary_to_configured_token_and_cost_budgets():
    assert RunLimits().max_llm_calls == 64
    assert RunLimits(max_llm_calls=128).max_llm_calls == 128
    with pytest.raises(ValidationError):
        RunLimits(max_llm_calls=129)
