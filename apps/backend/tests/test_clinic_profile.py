import hashlib
import json
import shutil
from dataclasses import FrozenInstanceError
from pathlib import Path

import pytest

PROFILE_ROOT = Path(__file__).resolve().parents[3] / "profiles" / "clinic_demo" / "v1"


def test_profile_has_a_fixed_http_boundary():
    assert (PROFILE_ROOT / "profile.json").is_file(), "The versioned Clinic profile is missing"
    from codehead.clinic.profile import load_profile

    profile = load_profile()
    assert profile.id == "clinic_demo/v1"
    assert profile.timezone == "Asia/Yekaterinburg"
    assert profile.slot_minutes == 30
    assert len(profile.profile_hash) == len(profile.suite_hash) == 64
    assert {"/api/doctors", "/api/patients", "/api/appointments", "/health"} <= set(
        profile.definition["endpoints"]
    )
    assert profile.definition["errors"] == [404, 409, 422]


def test_template_is_locked_and_has_no_application_implementation():
    assert (PROFILE_ROOT / "template").is_dir(), "The trusted technical template is missing"
    from codehead.clinic.profile import load_profile

    profile = load_profile()
    paths = {item.relative_path for item in profile.template_files}
    assert {"backend/main.py", "requirements.lock", "frontend/package-lock.json"} <= paths
    assert not any("clinic_api.py" in path or path.endswith("/App.tsx") for path in paths)
    assert "@app." not in next(
        item.content for item in profile.template_files if item.relative_path == "backend/main.py"
    )
    for item in profile.template_files:
        assert item.content_hash == hashlib.sha256(item.content.encode("utf-8")).hexdigest()


@pytest.mark.parametrize("entity", ["doctor", "patient", "appointment", "error"])
def test_http_schemas_are_versioned_and_forbid_unknown_fields(entity):
    assert (PROFILE_ROOT / "schemas.json").is_file(), "The HTTP JSON schemas are missing"
    schema = json.loads((PROFILE_ROOT / "schemas.json").read_text(encoding="utf-8"))
    assert schema["$schema"] == "https://json-schema.org/draft/2020-12/schema"
    assert schema["$defs"][entity]["type"] == "object"
    assert schema["$defs"][entity]["additionalProperties"] is False


def test_profile_snapshots_cannot_mutate_the_frozen_profile():
    from codehead.clinic.profile import load_profile

    profile = load_profile()
    with pytest.raises(FrozenInstanceError):
        profile.slot_minutes = 15
    definition = profile.definition
    definition["slot_minutes"] = 15
    definition["endpoints"].clear()
    assert profile.definition["slot_minutes"] == 30
    assert "/api/appointments" in profile.definition["endpoints"]


@pytest.mark.parametrize(
    ("content", "expected"),
    [
        (b"\xef\xbb\xbfa  \r\nb\r", "a  \nb\n"),
        (b"a\n", "a\n"),
        (b"a", "a"),
        ("\ufeffa\r\nb", "a\nb"),
    ],
)
def test_text_hash_normalization_preserves_spaces_and_final_newline(content, expected):
    from codehead.clinic.profile import normalize_text

    assert normalize_text(content) == expected
    with pytest.raises(UnicodeDecodeError):
        normalize_text(b"\xff")


def test_hashes_pin_only_their_trusted_source_boundaries(tmp_path):
    from codehead.clinic.profile import load_profile

    root = tmp_path / "profile"
    shutil.copytree(PROFILE_ROOT, root)
    baseline = load_profile(root)
    for path in root.rglob("*"):
        if path.is_file() and path.suffix in {".py", ".json", ".ts", ".tsx", ".html", ".lock"}:
            original = (
                path.read_bytes().decode("utf-8-sig").replace("\r\n", "\n").replace("\r", "\n")
            )
            path.write_bytes(b"\xef\xbb\xbf" + original.replace("\n", "\r\n").encode("utf-8"))
    windows = load_profile(root)
    assert (windows.profile_hash, windows.suite_hash, windows.template_hash) == (
        baseline.profile_hash,
        baseline.suite_hash,
        baseline.template_hash,
    )

    fixture = root / "fixtures" / "backend" / "clinic_api.py"
    fixture.parent.mkdir(parents=True, exist_ok=True)
    fixture.write_text("# An untrusted implementation fixture.\n", encoding="utf-8")
    assert load_profile(root).suite_hash == baseline.suite_hash
    assert load_profile(root).template_hash == baseline.template_hash

    suite = root / "acceptance" / "test_http.py"
    suite.write_bytes(suite.read_bytes() + b"\n# Changed trusted acceptance source.\n")
    changed = load_profile(root)
    assert changed.suite_hash != baseline.suite_hash
    assert changed.profile_hash == baseline.profile_hash
    assert changed.template_hash == baseline.template_hash

    template = root / "template" / "backend" / "main.py"
    template.write_bytes(template.read_bytes() + b" \n")
    assert load_profile(root).template_hash != baseline.template_hash


@pytest.mark.parametrize("entity", ["doctor_patch", "patient_patch", "appointment_patch"])
def test_patch_schemas_reject_empty_and_unknown_fields(entity):
    from codehead.clinic.profile import load_profile

    schema = load_profile().schemas["$defs"][entity]
    assert schema["minProperties"] == 1
    assert schema["additionalProperties"] is False
    assert not schema.get("required")


def test_trusted_template_entry_points_accept_only_local_database_and_test_clock():
    from codehead.clinic.profile import load_profile

    files = {item.relative_path: item.content for item in load_profile().template_files}
    entry = files["backend/main.py"]
    assert "from clinic_api import create_app" in entry
    assert "database_path=" in entry and "fixed_now=" in entry
    assert "CLINIC_DATABASE_PATH" in entry and "CLINIC_TEST_NOW" in entry
    assert "DATABASE_URL" not in entry
    assert "from './App'" in files["frontend/src/main.tsx"]
    package = json.loads(files["frontend/package.json"])
    lock = json.loads(files["frontend/package-lock.json"])
    assert lock["lockfileVersion"] == 3
    assert lock["packages"][""]["dependencies"] == package["dependencies"]
    assert package["dependencies"]["react"] == "19.3.1"
    assert package["devDependencies"]["vite"] == "8.3.8"


def test_missing_dependency_cache_is_reported_without_installing(tmp_path):
    from codehead.clinic.cache import inspect_dependency_cache
    from codehead.clinic.profile import load_profile

    cache = inspect_dependency_cache(load_profile(), repository_root=tmp_path)
    assert cache.status == "dependency_unavailable"
    assert cache.missing
    assert len(cache.key) == 64
    assert cache.profile_id == "clinic_demo/v1"
    assert cache.requirements_hash and cache.package_lock_hash


@pytest.mark.parametrize("corrupted", [b"{", b"\xff"])
def test_malformed_dependency_metadata_is_dependency_unavailable(tmp_path, corrupted):
    from codehead.clinic.cache import inspect_dependency_cache
    from codehead.clinic.profile import load_profile

    package = tmp_path / "node_modules" / "react" / "package.json"
    package.parent.mkdir(parents=True)
    package.write_bytes(corrupted)
    cache = inspect_dependency_cache(load_profile(), repository_root=tmp_path)
    assert cache.status == "dependency_unavailable"
    assert "npm:react@19.3.1" in cache.missing
