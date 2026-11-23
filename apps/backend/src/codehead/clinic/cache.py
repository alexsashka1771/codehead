"""Read-only verification of the prepared Clinic dependency cache."""

import hashlib
import json
import os
import platform
import shutil
import subprocess
from dataclasses import asdict, dataclass
from pathlib import Path, PurePosixPath

from codehead.clinic.profile import REPOSITORY_ROOT, ClinicProfile, load_profile

_PYTHON_PROBE = """
import importlib.metadata as metadata
import json
import sys
versions = {}
for name in json.loads(sys.argv[1]):
    try:
        versions[name] = metadata.version(name)
    except metadata.PackageNotFoundError:
        versions[name] = None
print(json.dumps({"python_version": sys.version.split()[0], "packages": versions}))
"""


@dataclass(frozen=True, slots=True)
class DependencyCheck:
    ecosystem: str
    name: str
    locked_version: str
    installed_version: str | None


@dataclass(frozen=True, slots=True)
class DependencyCache:
    key: str
    status: str
    profile_id: str
    profile_hash: str
    requirements_hash: str
    package_lock_hash: str
    operating_system: str
    architecture: str
    node_version: str | None
    python_version: str | None
    node_executable: Path | None
    python_executable: Path
    node_modules: Path
    checks: tuple[DependencyCheck, ...]
    missing: tuple[str, ...]

    def to_dict(self) -> dict:
        result = asdict(self)
        for name in ("node_executable", "python_executable", "node_modules"):
            result[name] = str(result[name]) if result[name] is not None else None
        return result


def _system_environment() -> dict[str, str]:
    return {
        name: os.environ[name]
        for name in ("SYSTEMROOT", "WINDIR", "TEMP", "TMP")
        if name in os.environ
    }


def _probe(command: list[str]) -> str | None:
    try:
        result = subprocess.run(
            command,
            shell=False,
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=10,
            env=_system_environment(),
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    return result.stdout.strip() if result.returncode == 0 else None


def _eligible(entry: dict, operating_system: str, architecture: str) -> bool:
    for field, value in (("os", operating_system), ("cpu", architecture)):
        allowed = entry.get(field, [])
        if f"!{value}" in allowed:
            return False
        positive = [item for item in allowed if not item.startswith("!")]
        if positive and value not in positive:
            return False
    return True


def _resolve_package(packages: dict, parent: str, name: str) -> str:
    base = PurePosixPath(parent)
    for ancestor in (base, *base.parents):
        if ancestor.name == "node_modules":
            continue
        candidate = (ancestor / "node_modules" / name).as_posix()
        if candidate in packages:
            return candidate
    raise ValueError("The trusted npm lock has an unresolved dependency.")


def _required_npm_packages(lock: dict, operating_system: str, architecture: str) -> dict:
    packages = lock["packages"]
    selected = {}
    pending = [
        _resolve_package(packages, "", name)
        for name in (packages[""].get("dependencies", {}) | packages[""].get("devDependencies", {}))
    ]
    while pending:
        path = pending.pop()
        if path in selected:
            continue
        entry = packages[path]
        if not _eligible(entry, operating_system, architecture):
            continue
        selected[path] = entry
        dependencies = dict(entry.get("dependencies", {}))
        for name in entry.get("peerDependencies", {}):
            if not entry.get("peerDependenciesMeta", {}).get(name, {}).get("optional", False):
                dependencies[name] = entry["peerDependencies"][name]
        for name in entry.get("optionalDependencies", {}):
            dependency_path = _resolve_package(packages, path, name)
            if _eligible(packages[dependency_path], operating_system, architecture):
                dependencies[name] = entry["optionalDependencies"][name]
        pending.extend(_resolve_package(packages, path, name) for name in dependencies)
    return selected


def _installed_package_version(path: Path) -> str | None:
    try:
        metadata = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return None
    if not isinstance(metadata, dict):
        return None
    version = metadata.get("version")
    return version if isinstance(version, str) else None


def inspect_dependency_cache(
    profile: ClinicProfile | None = None, *, repository_root: Path | None = None
) -> DependencyCache:
    """Check pinned versions and runtime inputs; never download or install packages."""
    profile = profile or load_profile()
    root = (repository_root or REPOSITORY_ROOT).resolve()
    files = {item.relative_path: item for item in profile.template_files}
    requirements = files["requirements.lock"]
    frontend_lock = files["frontend/package-lock.json"]
    python_pins = {
        line.split("==", 1)[0]: line.split("==", 1)[1]
        for line in requirements.content.splitlines()
        if line and not line.startswith("#")
    }
    python_executable = root / ".venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    python_probe = _probe(
        [str(python_executable), "-I", "-c", _PYTHON_PROBE, json.dumps(list(python_pins))]
    )
    python_data = json.loads(python_probe) if python_probe else {}
    node_path = shutil.which("node")
    node_executable = Path(node_path).resolve() if node_path else None
    node_version = _probe([str(node_executable), "--version"]) if node_executable else None
    node_version = node_version.removeprefix("v") if node_version else None
    operating_system = platform.system()
    architecture = platform.machine()
    npm_os = {"Windows": "win32", "Darwin": "darwin", "Linux": "linux"}.get(operating_system, "")
    npm_cpu = {"amd64": "x64", "x86_64": "x64", "aarch64": "arm64", "arm64": "arm64"}.get(
        architecture.lower(), architecture.lower()
    )
    node_modules = root / "node_modules"
    checks = [
        DependencyCheck("python", name, expected, python_data.get("packages", {}).get(name))
        for name, expected in sorted(python_pins.items())
    ]
    for path, entry in sorted(
        _required_npm_packages(json.loads(frontend_lock.content), npm_os, npm_cpu).items()
    ):
        package_path = root / Path(path) / "package.json"
        installed = _installed_package_version(package_path)
        checks.append(
            DependencyCheck("npm", path.removeprefix("node_modules/"), entry["version"], installed)
        )
    missing = [
        f"{item.ecosystem}:{item.name}@{item.locked_version}"
        for item in checks
        if item.installed_version != item.locked_version
    ]
    python_version = python_data.get("python_version")
    if not python_version or not python_version.startswith("3.11."):
        missing.append("runtime:Python 3.11")
    if not node_version or not node_version.startswith("24."):
        missing.append("runtime:Node 24")
    if operating_system != "Windows":
        missing.append("platform:Windows")
    identity = {
        "profile_id": profile.id,
        "profile_hash": profile.profile_hash,
        "requirements_hash": requirements.content_hash,
        "package_lock_hash": frontend_lock.content_hash,
        "operating_system": operating_system,
        "architecture": architecture,
        "node_version": node_version,
        "python_version": python_version,
    }
    key = hashlib.sha256(
        json.dumps(identity, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    return DependencyCache(
        key=key,
        status="available" if not missing else "dependency_unavailable",
        node_executable=node_executable,
        python_executable=python_executable,
        node_modules=node_modules,
        checks=tuple(checks),
        missing=tuple(missing),
        **identity,
    )
