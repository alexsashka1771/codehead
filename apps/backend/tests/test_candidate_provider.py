import hashlib
import inspect
import json
from dataclasses import replace

import pytest

from codehead.clinic.files import ROLE_PATHS
from codehead.clinic.profile import load_profile
from codehead.llm.provider import ProviderFailure, ProviderRequest, ProviderResult
from codehead.llm.redaction import redact
from codehead.llm.test_provider import TestProvider


def source_request(role="backend", name="Synthetic clinic", max_output_tokens=65536):
    assert "candidate_files" in ProviderRequest.__dataclass_fields__, "File bases are missing"
    profile = load_profile()
    inputs = tuple(
        {
            "id": f"input-{kind}",
            "version": 1,
            "artifact_type": kind,
            "content": f"# Synthetic {kind}\n",
            "content_hash": "a" * 64,
            "relative_path": f"docs/{kind}.md",
        }
        for kind in ("requirements", "architecture", "api_contract", "decision")
    )
    bases = tuple(
        {"relative_path": path, "base_hash": None, "artifact_id": None, "version": None}
        for path in sorted(ROLE_PATHS[role])
    )
    return ProviderRequest(
        role,
        name,
        "Doctors, synthetic patients and appointments.",
        1,
        inputs,
        max_output_tokens=max_output_tokens,
        candidate_files=bases,
        profile_version=profile.id,
        profile_hash=profile.profile_hash,
        acceptance_suite_hash=profile.suite_hash,
    )


def source_provider(**kwargs):
    assert "with_files" in inspect.signature(TestProvider).parameters, "Source provider is missing"
    return TestProvider(with_files=True, **kwargs)


def test_provider_result_keeps_files_separate_from_documents():
    assert "files" in ProviderResult.__dataclass_fields__
    result = ProviderResult((), "", "", "stop", None, 0, 0, 0, 0)
    assert result.files == ()


@pytest.mark.parametrize("role", ["backend", "frontend"])
def test_source_provider_returns_complete_bounded_role_files_with_explicit_test_usage(role):
    result = source_provider().run(source_request(role))
    assert result.artifacts == ()
    assert {file.relative_path for file in result.files} == ROLE_PATHS[role]
    assert result.stop_reason == "stop"
    assert result.input_tokens == result.output_tokens == result.cost_usd == 0
    assert all(
        file.base_hash is None and len(file.content.encode("utf-8")) <= 65536
        for file in result.files
    )
    raw = json.loads(result.raw_response)
    assert {file["relative_path"] for file in raw["files"]} == ROLE_PATHS[role]
    assert raw["summary"] == result.summary
    assert source_provider().model == "clinic-fixture-v2"


def test_source_provider_preserves_pinned_base_and_source_input_version():
    request = source_request()
    content = "# previous source\n"
    digest = hashlib.sha256(content.encode()).hexdigest()
    previous = {
        "id": "previous-source",
        "version": 2,
        "artifact_type": "source_code",
        "relative_path": "backend/clinic_api.py",
        "content_hash": digest,
        "content": content,
    }
    bases = tuple(
        {**file, "base_hash": digest, "artifact_id": previous["id"], "version": 2}
        if file["relative_path"] == previous["relative_path"]
        else file
        for file in request.candidate_files
    )
    request = replace(request, candidate_files=bases, inputs=(*request.inputs, previous))
    provider = source_provider()
    prompt = json.loads(provider.prepare(request))
    assert prompt["candidate_files"] == list(bases)
    output = provider.run(request)
    assert (
        next(
            file for file in output.files if file.relative_path == previous["relative_path"]
        ).base_hash
        == digest
    )


def test_source_provider_requires_the_approved_architecture_inputs():
    request = source_request()
    request = replace(
        request,
        inputs=tuple(item for item in request.inputs if item["artifact_type"] != "decision"),
    )
    with pytest.raises(ProviderFailure) as failure:
        source_provider().prepare(request)
    assert failure.value.code == "missing_input_artifacts"


def test_source_provider_rejects_foreign_file_bases_before_preparing_a_prompt():
    request = source_request()
    bases = (
        *request.candidate_files[:-1],
        {
            "relative_path": "frontend/src/App.tsx",
            "base_hash": None,
            "artifact_id": None,
            "version": None,
        },
    )
    with pytest.raises(ProviderFailure) as failure:
        source_provider().prepare(replace(request, candidate_files=bases))
    assert failure.value.code == "invalid_file_bases"


@pytest.mark.parametrize(
    ("kind", "path"),
    [
        ("source_code", "frontend/src/App.tsx"),
        ("source_code", "backend/clinic_api.py"),
        ("build_output", "reports/build.txt"),
    ],
)
def test_source_provider_rejects_inputs_outside_the_ancestors_and_pinned_bases(kind, path):
    request = source_request()
    content = "# unexpected input\n"
    extra = {
        "id": "extra-input",
        "version": 1,
        "artifact_type": kind,
        "relative_path": path,
        "content_hash": hashlib.sha256(content.encode()).hexdigest(),
        "content": content,
    }
    with pytest.raises(ProviderFailure) as failure:
        source_provider().prepare(replace(request, inputs=(*request.inputs, extra)))
    assert failure.value.code == "invalid_file_bases"


def test_source_provider_rejects_duplicate_pinned_input_identity():
    request = source_request()
    with pytest.raises(ProviderFailure) as failure:
        source_provider().prepare(
            replace(request, inputs=(*request.inputs, dict(request.inputs[0])))
        )
    assert failure.value.code == "invalid_file_bases"


def test_truncated_source_fixture_is_diagnosed_without_returning_partial_files():
    with pytest.raises(ProviderFailure) as failure:
        source_provider().run(source_request(max_output_tokens=1))
    assert failure.value.code == "incomplete_provider_output"
    assert failure.value.stop_reason == "length"


def test_source_project_name_is_json_encoded_and_secrets_do_not_reach_files_or_trace():
    canary = "CANARY_" + "secretvalue" * 3
    name = 'Clinic "; globalThis.injected = true; //' + canary
    request = source_request("frontend", name)
    provider = source_provider(secrets=(canary,))
    result = provider.run(request)
    app = next(file for file in result.files if file.relative_path.endswith("/App.tsx"))
    assert canary not in app.content + result.raw_response + provider.prepare(request)
    line = next(
        line for line in app.content.splitlines() if line.startswith("const CLINIC_NAME = ")
    )
    encoded = line.removeprefix("const CLINIC_NAME = ").removesuffix(";")
    assert json.loads(encoded).startswith('Clinic "; globalThis.injected = true; //')


@pytest.mark.parametrize(
    "name",
    [
        "Clinic password=source-name-canary",
        "Clinic Authorization: Bearer source-name-canary",
        "Clinic Bearer source-name-canary",
        "Clinic postgresql://user:source-name-canary@localhost/clinic",
    ],
)
def test_redacted_project_names_keep_valid_source_literals_and_identical_trace_content(name):
    provider = source_provider()
    request = source_request("frontend", name)
    assert json.loads(provider.prepare(request))["project_name"] == redact(name)
    result = provider.run(request)
    app = next(file for file in result.files if file.relative_path.endswith("/App.tsx"))
    line = next(
        line for line in app.content.splitlines() if line.startswith("const CLINIC_NAME = ")
    )
    encoded = line.removeprefix("const CLINIC_NAME = ").removesuffix(";")
    assert json.loads(encoded) == redact(name)
    traced = next(
        file
        for file in json.loads(result.raw_response)["files"]
        if file["relative_path"] == app.relative_path
    )
    assert traced["content"] == app.content
    assert "source-name-canary" not in app.content + result.raw_response


def test_old_test_provider_and_live_do_not_silently_enable_source_generation():
    request = source_request()
    with pytest.raises(ProviderFailure) as failure:
        TestProvider().run(request)
    assert failure.value.code == "unsupported_role"
    from codehead.llm.provider import LiveProviderUnavailable

    with pytest.raises(ProviderFailure) as failure:
        LiveProviderUnavailable().run(request)
    assert failure.value.code == "provider_unavailable"
