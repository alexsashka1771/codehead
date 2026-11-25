"""Read versioned test-only defect/repair inputs from outside agent write areas."""

import os
from dataclasses import dataclass

from codehead.clinic.files import text_hash, validate_text, workspace_path
from codehead.clinic.profile import load_profile


@dataclass(frozen=True)
class QualityFixture:
    fixture_id: str
    version: str
    relative_path: str
    content: str
    content_hash: str


def _load(path, fixture_id, version):
    root = load_profile().root
    file = workspace_path(root, path)
    with file.open("rb") as stream:
        if os.fstat(stream.fileno()).st_size > 65536:
            raise ValueError("Quality fixture exceeds the permitted file size.")
        data = stream.read(65537)
    if len(data) > 65536:
        raise ValueError("Quality fixture exceeds the permitted file size.")
    content = data.decode("utf-8-sig").replace("\r\n", "\n").replace("\r", "\n")
    validate_text(content)
    return QualityFixture(
        fixture_id, version, "backend/clinic_storage.py", content, text_hash(content)
    )


def storage_fixture():
    return _load("fixtures/defects/clinic_storage.py", "check-then-insert", "v1")


def repair_storage_fixture(scenario, iteration):
    if (
        scenario not in {"repair_success", "repair_blocked"}
        or type(iteration) is not int
        or iteration not in {1, 2}
    ):
        raise ValueError("Unsupported test repair scenario or iteration.")
    if scenario == "repair_success":
        return _load("fixtures/backend/clinic_storage.py", "slot-uniqueness", "v1")
    return _load(
        f"fixtures/defects/repair_{iteration}.py", "insufficient-slot-repair", f"v{iteration}"
    )
