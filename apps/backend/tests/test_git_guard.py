import importlib.util
from pathlib import Path

import pytest

GUARD = Path(__file__).resolve().parents[3] / "tools" / "git_guard.py"


def guard():
    assert GUARD.is_file(), "The staged Git credential guard is missing"
    spec = importlib.util.spec_from_file_location("git_guard", GUARD)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.mark.parametrize(
    "path", [".env", ".data/postgres/secret", "node_modules/code.js", "key.pem"]
)
def test_private_paths_cannot_be_committed(path):
    assert guard().scan_blob(path, b"example", {})


def test_known_environment_secret_is_blocked_without_echoing_its_value():
    value = "CANARY_" + "sensitive" * 4
    findings = guard().scan_blob("app.py", ("prefix\n" + value).encode(), {"API_KEY": value})
    assert findings and findings[0]["line"] == 2
    assert value not in str(findings)


def test_github_token_pattern_is_detected_without_an_environment_value():
    value = "ghp_" + "A1b2" * 9
    assert guard().scan_blob("settings.py", value.encode(), {})


def test_examples_and_ordinary_source_are_allowed():
    module = guard()
    assert module.scan_blob(".env.example", b"API_KEY=\n", {}) == []
    assert module.scan_blob("app.py", b"api_key = os.environ.get('API_KEY')\n", {}) == []
