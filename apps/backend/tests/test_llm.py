import ast
import builtins
import io
import json
import os
import socket
import subprocess
import time
from dataclasses import FrozenInstanceError, asdict, replace

import pytest


def request_for(role="product_manager", inputs=(), **changes):
    from codehead.llm.provider import ProviderRequest

    values = {
        "role": role,
        "project_name": "Clinic North",
        "description": "Doctors, synthetic patients and appointment rescheduling.",
        "requirements_version": 3,
        "inputs": inputs,
    }
    return ProviderRequest(**(values | changes))


def input_artifact(kind, artifact_id, version):
    return {
        "id": artifact_id,
        "version": version,
        "artifact_type": kind,
        "content": f"Approved {kind} for Clinic North.",
        "content_hash": "a" * 64,
        "relative_path": f"{kind}/v{version}.md",
    }


def architecture_inputs():
    return (input_artifact("requirements", "req-primary-12", 3),)


def cto_inputs():
    return architecture_inputs() + (
        input_artifact("architecture", "arch-candidate-27", 4),
        input_artifact("api_contract", "http-contract-31", 2),
    )


def test_provider_contracts_are_frozen_and_preserve_unknown_live_usage():
    from codehead.llm.provider import ArtifactDraft, ProviderFailure, ProviderResult

    request = request_for()
    artifact = ArtifactDraft("requirements", "Complete document")
    result = ProviderResult((artifact,), "Summary", "{}", "stop", None, None, None, None, 0.0)
    assert request.max_output_tokens == 2048
    assert artifact.media_type == "text/markdown"
    assert result.input_tokens is result.output_tokens is result.cost_usd is None
    for value, field in ((request, "role"), (artifact, "content"), (result, "summary")):
        with pytest.raises(FrozenInstanceError):
            setattr(value, field, "changed")

    failure = ProviderFailure("preflight_failed", "Invalid configuration")
    assert failure.code == "preflight_failed"
    assert failure.message == str(failure) == "Invalid configuration"
    assert failure.dispatched is failure.uncertain is False
    assert failure.raw_response is failure.stop_reason is None
    dispatched = ProviderFailure(
        "request_lost",
        "Outcome unknown",
        dispatched=True,
        uncertain=True,
        raw_response="partial",
        stop_reason="length",
    )
    assert dispatched.dispatched is dispatched.uncertain is True
    assert dispatched.raw_response == "partial"
    assert dispatched.stop_reason == "length"


@pytest.mark.parametrize(
    ("name", "description", "version"),
    [
        ("Clinic North", "Synthetic patients and appointments for north campus.", 3),
        ("Clinic South", "Synthetic doctors and appointment cancellation for south campus.", 7),
    ],
)
def test_pm_requirements_reflect_the_current_project(name, description, version):
    from codehead.llm.test_provider import TestProvider

    result = TestProvider().run(
        request_for(
            project_name=name,
            description=description,
            requirements_version=version,
        )
    )
    assert [artifact.artifact_type for artifact in result.artifacts] == ["requirements"]
    content = result.artifacts[0].content
    assert name in content
    assert description in content
    assert f"Requirements version: {version}" in content
    assert "test" in content.lower()
    assert "clinic-fixture-v1" in content
    for criterion in (
        "REQ-001",
        "REQ-002",
        "REQ-003",
        "30",
        "Asia/Yekaterinburg",
        "UTC",
        "409",
        "201",
        "synthetic",
        "scheduled",
        "cancelled",
    ):
        assert criterion in content
    assert "LLM" in content


def test_architect_links_exact_requirements_and_maps_the_fixed_http_scope():
    from codehead.llm.test_provider import TestProvider

    request = request_for("architect", architecture_inputs())
    result = TestProvider().run(request)
    assert [artifact.artifact_type for artifact in result.artifacts] == [
        "architecture",
        "api_contract",
    ]
    for artifact in result.artifacts:
        assert "Clinic North" in artifact.content
        assert request.description in artifact.content
        assert "Requirements version: 3" in artifact.content
        assert "req-primary-12@v3" in artifact.content
        assert "(requirements/v3.md)" in artifact.content
        assert "a" * 64 in artifact.content
    architecture, api_contract = (artifact.content for artifact in result.artifacts)
    for term in ("FastAPI", "React", "SQLite", "PostgreSQL", "transaction", "UNIQUE"):
        assert term in architecture
    for endpoint in (
        "/api/doctors",
        "/api/doctors/{id}",
        "/api/patients",
        "/api/patients/{id}",
        "/api/appointments",
        "/api/appointments/{id}",
        "/api/appointments/{id}/cancel",
        "/health",
    ):
        assert endpoint in api_contract
    for term in (
        "GET",
        "POST",
        "PATCH",
        "name",
        "specialty",
        "full_name",
        "doctor_id",
        "patient_id",
        "starts_at",
        "UUID",
        "[]",
        "201",
        "200",
        "404",
        "409",
        "422",
        "RFC 3339",
        "30",
        "Asia/Yekaterinburg",
        "scheduled",
        "cancelled",
    ):
        assert term in api_contract


def test_cto_recommendation_is_linked_to_all_selected_source_versions():
    from codehead.llm.test_provider import TestProvider

    result = TestProvider().run(request_for("cto", cto_inputs()))
    assert [artifact.artifact_type for artifact in result.artifacts] == ["decision"]
    content = result.artifacts[0].content
    assert "Clinic North" in content
    for artifact in cto_inputs():
        assert f"{artifact['id']}@v{artifact['version']}" in content
        assert f"({artifact['relative_path']})" in content
    assert "REQ-003" in content
    assert "рекомендац" in result.summary.lower()
    assert "test" in result.summary.lower()
    assert "approval" in content.lower()
    assert "LLM" in content


@pytest.mark.parametrize(
    ("role", "inputs"),
    [("product_manager", ()), ("architect", architecture_inputs()), ("cto", cto_inputs())],
)
def test_results_are_deterministic_small_complete_documents(role, inputs):
    from codehead.llm.test_provider import TestProvider

    provider = TestProvider()
    request = request_for(role, inputs)
    prompt = provider.prepare(request)
    result = provider.run(request)
    repeated = provider.run(request)
    assert provider.name == "test"
    assert provider.model == "clinic-fixture-v1"
    assert prompt == provider.prepare(request)
    assert result.artifacts == repeated.artifacts
    assert result.summary == repeated.summary
    assert result.raw_response == repeated.raw_response
    assert result.request_id == repeated.request_id
    assert result.request_id
    assert result.stop_reason == "stop"
    assert result.input_tokens == result.output_tokens == result.cost_usd == 0
    assert result.latency_ms >= 0
    assert 1 <= len(result.artifacts) <= 2
    assert all(0 < len(item.content.encode("utf-8")) <= 64 * 1024 for item in result.artifacts)
    assert all(item.media_type == "text/markdown" for item in result.artifacts)
    assert all("```" not in item.content for item in result.artifacts)
    response = json.loads(result.raw_response)
    assert response == {
        "artifacts": [asdict(item) for item in result.artifacts],
        "summary": result.summary,
    }
    assert "tool_requests" not in response
    assert "chain_of_thought" not in response


def test_prompt_preserves_pinned_input_metadata_and_content_without_mutation():
    from codehead.llm.test_provider import TestProvider

    inputs = cto_inputs()
    before = json.dumps(inputs, sort_keys=True)
    request = request_for("cto", inputs)
    prompt = TestProvider().prepare(request)
    for artifact in inputs:
        for key in ("id", "artifact_type", "content", "content_hash", "relative_path"):
            assert artifact[key] in prompt
        assert f'"version": {artifact["version"]}' in prompt
    assert request.project_name in prompt
    assert request.description in prompt
    assert '"requirements_version": 3' in prompt
    assert "test" in prompt.lower()
    assert json.dumps(inputs, sort_keys=True) == before


@pytest.mark.parametrize("method", ["prepare", "run"])
@pytest.mark.parametrize("role", ["backend", "frontend", "qa", "devops", "", "Product Manager"])
def test_unsupported_roles_fail_explicitly(method, role):
    from codehead.llm.provider import ProviderFailure
    from codehead.llm.test_provider import TestProvider

    with pytest.raises(ProviderFailure) as raised:
        getattr(TestProvider(), method)(request_for(role))
    assert raised.value.code == "unsupported_role"
    assert raised.value.dispatched is raised.value.uncertain is False


@pytest.mark.parametrize("method", ["prepare", "run"])
@pytest.mark.parametrize(
    "canary",
    [
        r"private\quoted-canary-901",
        "private\nnewline-canary-901",
        "private'\"both-quotes-canary-901",
    ],
)
def test_unsupported_role_errors_do_not_reveal_encoded_secrets(method, canary):
    from codehead.llm.provider import ProviderFailure
    from codehead.llm.test_provider import TestProvider

    provider = TestProvider(secrets=(canary,))
    with pytest.raises(ProviderFailure) as raised:
        getattr(provider, method)(request_for(role=f"unsupported-{canary}"))
    failure = raised.value
    assert failure.code == "unsupported_role"
    assert failure.dispatched is failure.uncertain is False
    assert failure.raw_response is None
    for channel in (failure.message, str(failure)):
        literal_tail = channel.partition(": ")[2]
        if literal_tail.startswith(("'", '"')):
            assert canary not in ast.literal_eval(literal_tail)
        assert canary not in channel
        assert repr(canary)[1:-1] not in channel


@pytest.mark.parametrize("method", ["prepare", "run"])
def test_unsupported_role_errors_never_invoke_an_input_object_repr(method):
    from codehead.llm.provider import ProviderFailure
    from codehead.llm.test_provider import TestProvider

    class UnprintableRole:
        def __repr__(self):
            raise AssertionError("Provider diagnostics must not invoke arbitrary input repr")

    with pytest.raises(ProviderFailure) as raised:
        getattr(TestProvider(), method)(request_for(role=UnprintableRole()))
    assert raised.value.code == "unsupported_role"


@pytest.mark.parametrize("method", ["prepare", "run"])
@pytest.mark.parametrize(
    ("role", "inputs", "missing"),
    [
        ("architect", (), "requirements"),
        ("cto", (), "architecture"),
        ("cto", (input_artifact("architecture", "arch-only", 1),), "api_contract"),
        ("cto", (input_artifact("api_contract", "api-only", 1),), "architecture"),
    ],
)
def test_missing_required_input_artifacts_are_rejected(method, role, inputs, missing):
    from codehead.llm.provider import ProviderFailure
    from codehead.llm.test_provider import TestProvider

    with pytest.raises(ProviderFailure) as raised:
        getattr(TestProvider(), method)(request_for(role, inputs))
    assert raised.value.code == "missing_input_artifacts"
    assert missing in raised.value.message
    assert raised.value.dispatched is raised.value.uncertain is False


@pytest.mark.parametrize("method", ["prepare", "run"])
def test_unconfigured_live_never_returns_test_fixtures(method):
    from codehead.llm.provider import LiveProviderUnavailable, ProviderFailure

    provider = LiveProviderUnavailable()
    assert provider.name == "unconfigured"
    assert provider.model is None
    with pytest.raises(ProviderFailure) as raised:
        getattr(provider, method)(request_for())
    assert raised.value.code == "provider_unavailable"
    assert raised.value.dispatched is raised.value.uncertain is False
    assert raised.value.raw_response is None


@pytest.mark.parametrize(
    "text",
    [
        "Authorization: Bearer auth-canary-917",
        "authorization = Basic auth-canary-917",
        '"Authorization": "Bearer auth-canary-917"',
        "Bearer auth-canary-917",
        "Cookie: session=auth-canary-917; preference=dark",
        "Set-Cookie: session=auth-canary-917; HttpOnly; Secure",
        '"Cookie": "session=auth-canary-917"',
        "api_key=auth-canary-917",
        '"password": "auth-canary-917"',
        "password='auth-canary-917'",
        "postgresql+psycopg://user-canary:auth-canary-917@127.0.0.1:5432/codehead",
        "postgresql://user-canary@localhost/codehead",
    ],
)
def test_redaction_masks_common_authentication_and_database_credentials(text):
    from codehead.llm.redaction import redact

    redacted = redact(text)
    assert "auth-canary-917" not in redacted
    assert "user-canary" not in redacted
    assert "REDACTED" in redacted


def test_redaction_preserves_harmless_text_and_masks_exact_explicit_secrets():
    from codehead.llm.redaction import redact

    harmless = "Clinic North: doctors, synthetic patients, UTC and HTTP 409.\nREQ-003."
    assert redact(harmless) == harmless
    text = "prefix unusual-canary-42 suffix auth-canary-917"
    redacted = redact(text, ("", "unusual-canary-42", "auth-canary-917"))
    assert "unusual-canary-42" not in redacted
    assert "auth-canary-917" not in redacted
    assert "prefix " in redacted and " suffix " in redacted
    assert redact(redacted, ("unusual-canary-42", "auth-canary-917")) == redacted


@pytest.mark.parametrize(
    ("text", "canary"),
    [
        ("Cookie: [REDACTED:cookies]; session=mixed-cookie-canary", "mixed-cookie-canary"),
        ("Cookie: '[REDACTED:cookies]; session=mixed-cookie-canary'", "mixed-cookie-canary"),
        ('"Cookie": "[REDACTED:cookies]; session=mixed-cookie-canary"', "mixed-cookie-canary"),
        ("Set-Cookie: [REDACTED:cookies]; session=mixed-cookie-canary", "mixed-cookie-canary"),
        ("Cookie: '[REDACTED:cookies]'; session=mixed-cookie-canary", "mixed-cookie-canary"),
        (
            "Authorization: [REDACTED:authorization] Basic mixed-auth-canary",
            "mixed-auth-canary",
        ),
        (
            "Authorization: '[REDACTED:authorization] Basic mixed-auth-canary'",
            "mixed-auth-canary",
        ),
        (
            '"Authorization": "[REDACTED:authorization] Basic mixed-auth-canary"',
            "mixed-auth-canary",
        ),
        (
            "Authorization: '[REDACTED:authorization]' Basic mixed-auth-canary",
            "mixed-auth-canary",
        ),
        (
            "Proxy-Authorization=[REDACTED:authorization] Bearer mixed-auth-canary",
            "mixed-auth-canary",
        ),
        ("api_key=[REDACTED:credential]mixed-key-canary", "mixed-key-canary"),
        ("api_key='[REDACTED:credential] mixed-key-canary'", "mixed-key-canary"),
        ('"password": "[REDACTED:credential] mixed-key-canary"', "mixed-key-canary"),
        ("Bearer [REDACTED:bearer]mixed-bearer-canary", "mixed-bearer-canary"),
    ],
)
def test_redaction_does_not_trust_a_marker_prefix_with_unredacted_suffix(text, canary):
    from codehead.llm.redaction import redact

    redacted = redact(text)
    assert canary not in redacted
    assert "REDACTED" in redacted
    assert redact(redacted) == redacted


@pytest.mark.parametrize(
    "text",
    [
        "Cookie: [REDACTED:cookies]",
        '"Cookie": "[REDACTED:cookies]"',
        "Authorization: '[REDACTED:authorization]'",
        '"password": "[REDACTED:secret]"',
        "api_key=[REDACTED:credential]",
        "Bearer [REDACTED:bearer]",
        "postgresql://[REDACTED:credentials]@localhost/codehead",
    ],
)
def test_redaction_preserves_only_complete_known_markers(text):
    from codehead.llm.redaction import redact

    assert redact(text) == text
    assert redact(redact(text)) == text


@pytest.mark.parametrize(
    "value", ["[REDACTED:invented]", "[REDACTED:secret", "[REDACTED:secret]suffix"]
)
def test_invented_incomplete_or_suffixed_markers_are_not_trusted(value):
    from codehead.llm.redaction import redact

    assert redact(f'"password": "{value}"') == '"password": "[REDACTED:credential]"'


def test_mixed_marker_canaries_are_removed_before_provider_channels_and_diagnostics():
    from codehead.llm.provider import ProviderFailure
    from codehead.llm.test_provider import TestProvider

    cookie = "Cookie: [REDACTED:cookies]; session=mixed-cookie-canary"
    authorization = "Authorization: '[REDACTED:authorization] Basic mixed-auth-canary'"
    artifact = input_artifact("requirements", "req-mixed-markers", 3)
    artifact["content"] += f"\n{cookie}"
    request = request_for(
        "architect", (artifact,), description=f"Synthetic patients. {authorization}"
    )
    provider = TestProvider()
    result = provider.run(request)
    failure = ProviderFailure(
        "rejected", authorization, raw_response=json.dumps({"Cookie": cookie})
    )
    channels = [provider.prepare(request), result.raw_response, result.summary]
    channels.extend(item.content for item in result.artifacts)
    channels.extend([failure.message, str(failure), failure.raw_response])
    for channel in channels:
        assert "mixed-cookie-canary" not in channel
        assert "mixed-auth-canary" not in channel


@pytest.mark.parametrize(
    ("text", "canary"),
    [
        (r"DATABASE_PASSWORD=prefix\canary-db-password-722", "canary-db-password-722"),
        (r"DATABASE_PASSWORD=prefix\'canary-db-password-722", "canary-db-password-722"),
        (r"api_key=prefix\canary-api-key-722", "canary-api-key-722"),
        (r"Authorization: Basic prefix\canary-auth-722", "canary-auth-722"),
        (r"Authorization: Basic prefix\'canary-auth-722", "canary-auth-722"),
        (r"Authorization: Bearer prefix\canary-auth-722", "canary-auth-722"),
        (r"Cookie: session=prefix\canary-cookie-722", "canary-cookie-722"),
        (r"Cookie: session=prefix\"canary-cookie-722", "canary-cookie-722"),
        (r"Bearer prefix\canary-bearer-722", "canary-bearer-722"),
        (r"Bearer prefix\"canary-bearer-722", "canary-bearer-722"),
    ],
)
def test_redaction_masks_complete_unquoted_values_containing_backslashes(text, canary):
    from codehead.llm.redaction import redact

    redacted = redact(text)
    assert canary not in redacted
    assert "prefix" not in redacted
    assert redact(redacted) == redacted


@pytest.mark.parametrize(
    ("text", "canary"),
    [
        (r"DATABASE_PASSWORD=prefix\canary-db-password-722", "canary-db-password-722"),
        (r"Authorization: Basic prefix\canary-auth-722", "canary-auth-722"),
        (r"Bearer prefix\canary-bearer-722", "canary-bearer-722"),
    ],
)
def test_backslash_credentials_never_reach_provider_channels_or_failure_diagnostics(text, canary):
    from codehead.llm.provider import ProviderFailure
    from codehead.llm.test_provider import TestProvider

    artifact = input_artifact("requirements", "req-backslash", 3)
    artifact["content"] += f"\n{text}"
    request = request_for("architect", (artifact,), description=f"Synthetic patients. {text}")
    provider = TestProvider()
    result = provider.run(request)
    failure = ProviderFailure("rejected", text, raw_response=json.dumps({"diagnostic": text}))
    channels = [provider.prepare(request), result.raw_response, result.summary]
    channels.extend(item.content for item in result.artifacts)
    channels.extend([failure.message, str(failure), failure.raw_response])
    for channel in channels:
        assert canary not in channel
    response = json.loads(result.raw_response)
    assert response["artifacts"] == [asdict(item) for item in result.artifacts]


def test_json_redaction_preserves_safe_lines_and_quotes_around_backslash_credentials():
    from codehead.llm.redaction import redact

    text = 'Safe "intro".\nAuthorization: Basic prefix\\canary-auth-722\nSafe final line.'
    payload = {
        "description": text,
        "DATABASE_PASSWORD": r"prefix\canary-db-password-722",
        "nested": [{"Cookie": r"session=prefix\canary-cookie-722"}],
    }
    redacted = redact(json.dumps(payload))
    parsed = json.loads(redacted)
    for canary in ("canary-auth-722", "canary-db-password-722", "canary-cookie-722"):
        assert canary not in redacted
    assert parsed["description"] == (
        'Safe "intro".\nAuthorization: [REDACTED:authorization]\nSafe final line.'
    )
    assert parsed["DATABASE_PASSWORD"].startswith("[REDACTED:")
    assert parsed["nested"][0]["Cookie"].startswith("[REDACTED:")
    assert redact(redacted) == redacted


def provider_text_channels(text):
    from codehead.llm.provider import ProviderFailure
    from codehead.llm.test_provider import TestProvider

    artifact = input_artifact("requirements", "req-redaction-boundary", 3)
    artifact["content"] = text
    request = request_for("architect", (artifact,), description=text, max_output_tokens=8192)
    provider = TestProvider()
    prompt = provider.prepare(request)
    result = provider.run(request)
    failure = ProviderFailure("rejected", text, raw_response=text)
    assert json.loads(result.raw_response)["artifacts"] == [
        asdict(item) for item in result.artifacts
    ]
    return {
        "prompt": prompt,
        "raw_response": result.raw_response,
        "summary": result.summary,
        "message": failure.message,
        "error": str(failure),
        "diagnostic": failure.raw_response,
        **{f"artifact_{index}": item.content for index, item in enumerate(result.artifacts)},
    }


@pytest.mark.parametrize("delimiter", [";", ",", "}"])
def test_plain_credentials_mask_the_entire_line_even_with_json_like_delimiters(delimiter):
    from codehead.llm.redaction import redact

    canary = "delimiter-secret-canary"
    text = f"DATABASE_PASSWORD=prefix{delimiter}{canary}\nSafe public context."
    channels = {"redacted": redact(text), **provider_text_channels(text)}
    for name, channel in channels.items():
        assert canary not in channel
        if name != "summary":
            assert "Safe public context." in channel
        channel.encode("utf-8")
    assert redact(text) == "DATABASE_PASSWORD=[REDACTED:credential]\nSafe public context."
    assert redact(redact(text)) == redact(text)


@pytest.mark.parametrize("line_break", ["\n", "\r\n"])
@pytest.mark.parametrize("quote", ["'", '"'])
def test_multiline_quoted_credentials_are_masked_before_json_and_line_splitting(line_break, quote):
    from codehead.llm.redaction import redact

    text = (
        f"Public before.{line_break}DATABASE_PASSWORD={quote}first-line"
        f"{line_break}[1, 2]{line_break}multiline-secret-canary{quote}"
        f"{line_break}Public after."
    )
    expected = (
        f"Public before.{line_break}DATABASE_PASSWORD={quote}[REDACTED:credential]{quote}"
        f"{line_break}Public after."
    )
    channels = {"redacted": redact(text), **provider_text_channels(text)}
    for name, channel in channels.items():
        assert "multiline-secret-canary" not in channel
        assert "first-line" not in channel
        if name != "summary":
            assert "Public before." in channel
            assert "Public after." in channel
        channel.encode("utf-8")
    assert redact(text) == expected
    assert redact(expected) == expected


def test_multiline_credentials_inside_json_fragments_preserve_other_fields_and_text():
    from codehead.llm.redaction import redact

    fragment = json.dumps(
        {
            "note": "DATABASE_PASSWORD='first-line\nmultiline-secret-canary'",
            "public": "kept",
        }
    )
    text = f"Public before.\n{fragment}\nPublic after."
    redacted = redact(text)
    assert "multiline-secret-canary" not in redacted
    assert redacted.startswith("Public before.\n")
    assert redacted.endswith("\nPublic after.")
    parsed = json.loads(redacted[len("Public before.\n") : -len("\nPublic after.")])
    assert parsed == {"note": "DATABASE_PASSWORD='[REDACTED:credential]'", "public": "kept"}
    assert redact(redacted) == redacted


def test_unterminated_multiline_quoted_credentials_remain_redacted_through_end_of_text():
    from codehead.llm.redaction import redact

    text = "DATABASE_PASSWORD='first-line\n[1, 2]\nmultiline-secret-canary"
    assert redact(text) == "DATABASE_PASSWORD=[REDACTED:credential]"


@pytest.mark.parametrize(
    "text",
    [
        '{"headers":[{"name":"Cookie","value":"session=header-secret-canary"}]}',
        '[["Authorization","Basic header-secret-canary"]]',
    ],
)
def test_structured_sensitive_headers_are_redacted_across_provider_channels(text):
    from codehead.llm.redaction import redact

    channels = {"redacted": redact(text), **provider_text_channels(text)}
    for channel in channels.values():
        assert "header-secret-canary" not in channel
        channel.encode("utf-8")
    json.loads(redact(text))
    assert redact(redact(text)) == redact(text)


def test_structured_header_redaction_preserves_unrelated_name_value_objects_and_pairs():
    from codehead.llm.redaction import redact

    payload = {
        "headers": [
            {"name": "Cookie", "value": "session=header-secret-canary", "source": "fixture"},
            {"name": "X-Color", "value": "blue"},
        ],
        "fields": [{"name": "clinic_title", "value": "Clinic North"}],
        "pairs": [
            ["Authorization", "Basic header-secret-canary"],
            ["clinic_title", "Clinic North"],
        ],
    }
    parsed = json.loads(redact(json.dumps(payload)))
    assert parsed["headers"][0] == {
        "name": "Cookie",
        "value": "[REDACTED:cookies]",
        "source": "fixture",
    }
    assert parsed["headers"][1] == payload["headers"][1]
    assert parsed["fields"] == payload["fields"]
    assert parsed["pairs"][0] == ["Authorization", "[REDACTED:authorization]"]
    assert parsed["pairs"][1] == payload["pairs"][1]


@pytest.mark.parametrize(
    "text",
    [
        '{"password":"duplicate-secret-canary","password":"[REDACTED:credential]"}',
        '{"outer":{"password":"duplicate-secret-canary",'
        '"password":"[REDACTED:credential]"},"public":"retained"}',
    ],
)
def test_duplicate_json_keys_cannot_bypass_redaction_by_shadowing_a_secret(text):
    from codehead.llm.redaction import redact

    channels = {"redacted": redact(text), **provider_text_channels(text)}
    for channel in channels.values():
        assert "duplicate-secret-canary" not in channel
        channel.encode("utf-8")
    assert json.loads(redact(text)) == json.loads(text)
    assert redact(redact(text)) == redact(text)


@pytest.mark.parametrize("name", ["Cookie", "Authorization"])
def test_duplicate_header_names_cannot_erase_a_sensitive_name_value_association(name):
    from codehead.llm.redaction import redact

    text = (
        '{"headers":[{"name":"' + name + '","name":"X-Color",'
        '"value":"session=duplicate-header-canary"}]}'
    )
    channels = {"redacted": redact(text), **provider_text_channels(text)}
    for channel in channels.values():
        assert "duplicate-header-canary" not in channel
        channel.encode("utf-8")
    parsed = json.loads(redact(text))
    assert parsed["headers"][0]["name"] == "X-Color"
    assert parsed["headers"][0]["value"].startswith("[REDACTED:")
    assert redact(redact(text)) == redact(text)


@pytest.mark.parametrize("escape", [r"\ud800", r"\udfff"])
def test_redacted_json_keeps_isolated_surrogates_safely_escaped(escape):
    from codehead.llm.redaction import redact

    text = '{"note":"' + escape + '","password":"irrelevant-value"}'
    redacted = redact(text)
    redacted.encode("utf-8")
    assert json.loads(redacted)["note"] == json.loads(text)["note"]
    assert "irrelevant-value" not in redacted
    assert redact(redacted) == redacted


def test_surrogate_json_is_safe_in_prompt_response_artifacts_and_diagnostics():
    from codehead.llm.redaction import redact
    from codehead.llm.test_provider import TestProvider

    text = r'{"note":"\ud800","password":"irrelevant-value"}'
    for channel in provider_text_channels(text).values():
        channel.encode("utf-8")
    request = request_for(description=text)
    provider = TestProvider()
    prompt_description = json.loads(provider.prepare(request))["description"]
    assert json.loads(prompt_description)["note"] == json.loads(text)["note"]
    result = provider.run(request)
    assert f"Описание проекта: {redact(text)}" in result.artifacts[0].content


def test_redaction_never_returns_an_unencodable_plain_surrogate():
    from codehead.llm.redaction import redact

    text = "Safe text \ud800 tail."
    redacted = redact(text)
    redacted.encode("utf-8")
    assert redacted == r"Safe text \ud800 tail."


def test_secret_canaries_never_reach_prompt_raw_response_documents_summary_or_errors():
    from codehead.llm.provider import ProviderFailure
    from codehead.llm.test_provider import TestProvider

    canary = "private-canary-185"
    provider = TestProvider(secrets=(canary,))
    artifact = input_artifact("requirements", "req-canary", 3)
    artifact["content"] += f" {canary}\nCookie: session=cookie-canary-964"
    request = request_for(
        "architect",
        (artifact,),
        project_name=f"Clinic {canary}",
        description="Synthetic doctors. Authorization: Bearer header-canary-237",
    )
    prompt = provider.prepare(request)
    result = provider.run(request)
    channels = [prompt, result.raw_response, result.summary]
    channels.extend(item.content for item in result.artifacts)
    with pytest.raises(ProviderFailure) as raised:
        provider.run(replace(request, role=f"unsupported-{canary}"))
    channels.extend([str(raised.value), raised.value.message])
    for channel in channels:
        assert canary not in channel
        assert "header-canary-237" not in channel
        assert "cookie-canary-964" not in channel
    assert canary in request.project_name
    assert "cookie-canary-964" in artifact["content"]


def test_provider_failure_redacts_common_credentials_before_retaining_diagnostics():
    from codehead.llm.provider import ProviderFailure

    failure = ProviderFailure(
        "rejected",
        "Authorization: Bearer error-canary-581",
        raw_response='{"password": "response-canary-683"}',
        stop_reason="stop",
    )
    assert "error-canary-581" not in str(failure)
    assert "error-canary-581" not in failure.message
    assert "response-canary-683" not in failure.raw_response
    assert json.loads(failure.raw_response)["password"].startswith("[REDACTED")


@pytest.mark.parametrize("tokens", [0, -1, True, 1.5])
def test_invalid_output_limits_fail_before_generation(tokens):
    from codehead.llm.provider import ProviderFailure
    from codehead.llm.test_provider import TestProvider

    with pytest.raises(ProviderFailure) as raised:
        TestProvider().run(request_for(max_output_tokens=tokens))
    assert raised.value.code == "invalid_provider_request"
    assert raised.value.dispatched is raised.value.uncertain is False


def test_a_small_output_budget_rejects_the_complete_fixture_without_silent_truncation():
    from codehead.llm.provider import ProviderFailure
    from codehead.llm.test_provider import TestProvider

    with pytest.raises(ProviderFailure) as raised:
        TestProvider().run(request_for(max_output_tokens=1))
    assert raised.value.code == "incomplete_provider_output"
    assert raised.value.stop_reason == "length"
    assert raised.value.raw_response
    assert raised.value.dispatched is raised.value.uncertain is False


def test_oversized_documents_are_rejected_without_returning_an_artifact():
    from codehead.llm.provider import ProviderFailure
    from codehead.llm.test_provider import TestProvider

    with pytest.raises(ProviderFailure) as raised:
        TestProvider().run(request_for(description="x" * (64 * 1024), max_output_tokens=100_000))
    assert raised.value.code == "invalid_provider_output"
    assert "64 KiB" in raised.value.message


@pytest.mark.parametrize(
    "inputs",
    [
        (None,),
        ({"id": "missing-fields"},),
        (input_artifact("requirements", "bad-version", 0),),
        (input_artifact("requirements", "bad-version", True),),
    ],
)
def test_malformed_input_metadata_is_an_explicit_provider_failure(inputs):
    from codehead.llm.provider import ProviderFailure
    from codehead.llm.test_provider import TestProvider

    with pytest.raises(ProviderFailure) as raised:
        TestProvider().prepare(request_for("architect", inputs))
    assert raised.value.code == "invalid_provider_request"
    assert raised.value.dispatched is raised.value.uncertain is False


def test_test_and_unconfigured_live_providers_perform_no_unprompted_io(monkeypatch):
    from codehead.llm.provider import LiveProviderUnavailable, ProviderFailure
    from codehead.llm.test_provider import TestProvider

    def forbidden(*args, **kwargs):
        raise AssertionError("The stub provider must not perform external IO or wait at zero delay")

    request = request_for("cto", cto_inputs())
    provider = TestProvider()
    with monkeypatch.context() as guarded:
        for module, names in (
            (builtins, ("open",)),
            (io, ("open",)),
            (socket, ("socket", "create_connection")),
            (subprocess, ("Popen", "run")),
            (os, ("system", "getenv")),
            (time, ("sleep",)),
        ):
            for name in names:
                guarded.setattr(module, name, forbidden)
        provider.prepare(request)
        provider.run(request)
        for method in ("prepare", "run"):
            with pytest.raises(ProviderFailure):
                getattr(LiveProviderUnavailable(), method)(request)
