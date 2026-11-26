import pytest
from pydantic import ValidationError

from codehead import contracts
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


@pytest.mark.parametrize("operation", ["smoke_test", "start_preview", "stop_preview"])
def test_delivery_tool_operations_are_worker_only(operation):
    from typing import get_args

    assert operation in get_args(contracts.ToolRunView.model_fields["operation_id"].annotation)
    with pytest.raises(ValidationError):
        contracts.ToolCommand(
            operation_id=operation,
            workspace_id="9c2e48d6-4c40-4637-8311-e21f889bd4ef",
            snapshot_version=1,
        )


@pytest.mark.parametrize(
    "origin",
    [
        "https://127.0.0.1:5319",
        "http://localhost:5319",
        "http://127.0.0.2:5319",
        "http://[::1]:5319",
        "http://127.0.0.1.evil.example:5319",
        "http://127.0.0.1:0",
        "http://127.0.0.1:65536",
        "http://127.0.0.1:05319",
        "http://127.0.0.1:5319/",
        "http://127.0.0.1:5319?foo",
        "http://127.0.0.1:5319#foo",
        "http://username@127.0.0.1:5319",
        " http://127.0.0.1:5319",
    ],
)
def test_preview_access_rejects_noncanonical_loopback_origins(origin):
    with pytest.raises(ValidationError):
        contracts.PreviewAccess(
            status="available",
            run_id="r",
            package_id="p",
            preview_session_id="s",
            version=1,
            origin=origin,
        )


def test_preview_access_exposes_origin_only_for_available_pinned_session():
    pins = dict(run_id="r", package_id="p", preview_session_id="s", version=1)
    origin = "http://127.0.0.1:65535"
    assert contracts.PreviewAccess(status="available", origin=origin, **pins).origin == origin
    with pytest.raises(ValidationError):
        contracts.PreviewAccess(status="unavailable", origin=origin, reason="Недоступен.", **pins)
    with pytest.raises(ValidationError):
        contracts.PreviewAccess(status="available", origin=origin, run_id="r")
    with pytest.raises(ValidationError):
        contracts.PreviewAccess(status="unavailable", run_id="r")


def test_preview_command_checks_operation_scope_and_optimistic_version():
    package_id = "9c2e48d6-4c40-4637-8311-e21f889bd4ef"
    preview_session_id = "ba87f6e1-8624-482b-8ca8-04464c02aebd"
    command = contracts.PreviewCommand
    assert command(command="start", package_id=package_id, expected_version=0).expected_version == 0
    assert (
        command(
            command="stop",
            package_id=package_id,
            preview_session_id=preview_session_id,
            expected_version=2,
        ).preview_session_id
        == preview_session_id
    )
    for payload in (
        dict(command="start", preview_session_id=preview_session_id, expected_version=0),
        dict(command="start", expected_version=-1),
        dict(command="start", expected_version=True),
        dict(command="stop", expected_version=2),
        dict(command="stop", preview_session_id=preview_session_id, expected_version=0),
    ):
        with pytest.raises(ValidationError):
            command(package_id=package_id, **payload)


def test_preview_session_timestamps_have_one_representation_before_and_after_persistence():
    fields = {
        "id": "session",
        "run_id": "run",
        "package_id": "package",
        "package_generation": 1,
        "package_tree_hash": "a" * 64,
        "status": "stopped",
        "version": 3,
    }
    times = ("created_at", "updated_at", "ready_at", "finished_at")
    before = contracts.PreviewSessionView(
        **fields, **{name: "2026-11-26T17:15:34.365953Z" for name in times}
    )
    after = contracts.PreviewSessionView(
        **fields, **{name: "2026-11-26T22:15:34.365953+05:00" for name in times}
    )
    assert after.model_dump(mode="json") == before.model_dump(mode="json")
