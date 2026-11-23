"""Inspect staged blobs without exposing credentials or reading ignored local data."""

import json
import os
import re
import subprocess

PRIVATE_DIRECTORIES = {
    ".data",
    ".venv",
    "node_modules",
    "__pycache__",
    ".pytest_cache",
    ".ruff_cache",
}
PRIVATE_SUFFIXES = (".pem", ".key", ".pfx", ".p12", ".sqlite", ".sqlite3", ".db")
TOKEN_PATTERN = re.compile(
    rb"\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}"
    rb"|sk-(?:proj-|ant-api\d+-)?[A-Za-z0-9_-]{24,})\b"
)
PRIVATE_KEY_PATTERN = re.compile(
    rb"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----\s+"
    rb"[A-Za-z0-9+/=\s]{80,}-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"
)


def scan_blob(path, data, secrets):
    components = path.replace("\\", "/").casefold().split("/")
    name = components[-1]
    findings = []
    if (
        PRIVATE_DIRECTORIES.intersection(components)
        or (name.startswith(".env") and name != ".env.example")
        or name.endswith(PRIVATE_SUFFIXES)
        or name in {"id_rsa", "id_ed25519", ".pypirc"}
    ):
        findings.append({"path": path, "reason": "private-local-file", "line": 1})
    for name, value in secrets.items():
        if len(value) < 8:
            continue
        offset = data.find(value.encode("utf-8"))
        if offset >= 0:
            findings.append(
                {
                    "path": path,
                    "reason": f"environment-secret:{name}",
                    "line": data[:offset].count(b"\n") + 1,
                }
            )
    for pattern in (TOKEN_PATTERN, PRIVATE_KEY_PATTERN):
        for match in pattern.finditer(data.replace(b"\\n", b"\n")):
            findings.append(
                {
                    "path": path,
                    "reason": "credential-pattern",
                    "line": data[: match.start()].count(b"\n") + 1,
                }
            )
    return findings


def _git(arguments, *, input=None):
    result = subprocess.run(
        ["git", *arguments],
        input=input,
        capture_output=True,
        check=False,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    if result.returncode:
        raise RuntimeError("Git could not read the staged index.")
    return result.stdout


def check_staged():
    entries = []
    for entry in _git(["ls-files", "--stage", "-z"]).split(b"\0"):
        if not entry:
            continue
        metadata, path = entry.split(b"\t", 1)
        mode, object_id, stage = metadata.split()
        if mode not in {b"100644", b"100755"} or stage != b"0":
            raise RuntimeError("Resolve unmerged or non-regular staged entries before committing.")
        entries.append((object_id, path.decode("utf-8")))
    secrets = {
        name: value
        for name, value in os.environ.items()
        if re.search(r"(?:API_KEY|TOKEN|PASSWORD|SECRET|PRIVATE_KEY|DATABASE_URL)$", name)
    }
    blobs = (
        _git(["cat-file", "--batch"], input=b"\n".join(key for key, _ in entries) + b"\n")
        if entries
        else b""
    )
    offset, findings = 0, []
    for object_id, path in entries:
        end = blobs.index(b"\n", offset)
        header = blobs[offset:end].split()
        if len(header) != 3 or header[0] != object_id or header[1] != b"blob":
            raise RuntimeError("A staged object is missing or is not a file.")
        size = int(header[2])
        if size > 100 * 1024 * 1024:
            findings.append({"path": path, "reason": "file-over-100-MiB", "line": 1})
        start = end + 1
        findings.extend(scan_blob(path, blobs[start : start + size], secrets))
        offset = start + size + 1
    if findings:
        print(json.dumps({"files": len(entries), "findings": findings}, ensure_ascii=False))
        return 1
    print(f"Git guard: {len(entries)} staged files checked; no credentials or private data found.")
    return 0


if __name__ == "__main__":
    raise SystemExit(check_staged())
