from dataclasses import dataclass
from datetime import UTC, datetime
from types import SimpleNamespace
from uuid import uuid4

import pytest
from sqlalchemy import select

from codehead.clinic.files import FileConflict, text_hash, tree_hash
from codehead.contracts import CreateProject, FileProposal, StartRun
from codehead.persistence import models
from codehead.persistence.models import AgentRun, Artifact, Run, Task
from codehead.persistence.service import ProjectService


def test_candidate_has_relational_storage():
    assert hasattr(models, "Candidate"), "Candidate persistence is missing"
    assert {"run_id", "revision", "files", "manifest_artifact_id"} <= set(
        models.Candidate.__table__.columns.keys()
    )


def test_rejected_template_does_not_leave_pending_artifacts(database):
    from codehead.clinic.files import InvalidFile
    from codehead.persistence.candidates import CandidateStore

    service = ProjectService(database)
    project = service.create_project(
        CreateProject(name="Rejected template", description="Synthetic template validation."),
        "rejected-project",
    )
    run = service.start_run(project.id, StartRun(mode="test"), "rejected-run", "rejected")
    profile = SimpleNamespace(
        id="clinic_demo/v1",
        profile_hash="a" * 64,
        suite_hash="b" * 64,
        template_hash="c" * 64,
        template_files=(TemplateFile("backend/main.py", "# entry\n"),),
    )
    store = CandidateStore(profile, clock=lambda: datetime.now(UTC))
    with database.sessions.begin() as session:
        persisted = session.get(Run, run.id)
        persisted.profile_version, persisted.profile_hash = profile.id, profile.profile_hash
        persisted.acceptance_suite_hash = profile.suite_hash
        persisted.template_hash = profile.template_hash
        with pytest.raises(InvalidFile):
            store.ensure(session, persisted)
        session.flush()
        assert list(session.scalars(select(Artifact).where(Artifact.run_id == run.id))) == []


@dataclass(frozen=True)
class TemplateFile:
    relative_path: str
    content: str
    media_type: str = "text/plain"

    @property
    def content_hash(self):
        return text_hash(self.content)


@pytest.fixture
def prepared(database):
    assert hasattr(models, "Candidate"), "Candidate persistence is missing"
    from codehead.persistence.candidates import CandidateStore

    service = ProjectService(database)
    project = service.create_project(
        CreateProject(name="Candidate clinic", description="Synthetic clinic candidate."),
        "candidate-project",
    )
    run = service.start_run(project.id, StartRun(mode="test"), "candidate-run", "candidate")
    files = (TemplateFile("backend/main.py", "# Trusted entry\n"),)
    profile = SimpleNamespace(
        id="clinic_demo/v1",
        profile_hash="a" * 64,
        suite_hash="b" * 64,
        template_hash=tree_hash({file.relative_path: file.content_hash for file in files}),
        template_files=files,
    )
    store = CandidateStore(profile, clock=lambda: datetime.now(UTC))
    with database.sessions.begin() as session:
        persisted = session.get(Run, run.id)
        persisted.profile_version = profile.id
        persisted.profile_hash = profile.profile_hash
        persisted.acceptance_suite_hash = profile.suite_hash
        persisted.template_hash = profile.template_hash
        store.ensure(session, persisted)
    return database, service, store, run


def apply(prepared, role, proposals):
    database, service, store, run = prepared
    with database.sessions.begin() as session:
        persisted = session.scalar(select(Run).where(Run.id == run.id).with_for_update())
        task = session.scalar(select(Task).where(Task.run_id == run.id, Task.role == role))
        agent = next(item for item in service._agents(session, run.id) if item.role == role)
        attempt = AgentRun(
            id=str(uuid4()),
            run_id=run.id,
            task_id=task.id,
            agent_id=agent.id,
            number=task.attempt + 1,
            fencing_token=task.fencing_token + 1,
            status="running",
            provider="test",
            model="clinic-fixture-v2",
            input_versions={},
            parameters={},
            created_at=datetime.now(UTC),
        )
        task.attempt += 1
        session.add(attempt)
        store.apply(session, persisted, task, attempt, proposals, input_versions={})
        service._emit_workflow(session, persisted, "candidate.updated")
    return service.snapshot(run.id)


def test_template_manifest_has_immutable_file_descriptors(prepared):
    database, _, store, run = prepared
    with database.read() as session:
        candidate = store.view(session, run.id)
        assert candidate.revision == 1
        assert candidate.status == "assembling"
        assert candidate.files[0].origin == "template"
        assert candidate.files[0].producer_id is None
        content = session.get(Artifact, candidate.files[0].artifact_id)
        assert content.content_text == "# Trusted entry\n"
        manifest = session.get(Artifact, candidate.manifest_artifact_id)
        assert manifest.artifact_type == "candidate_manifest"
        assert manifest.content_hash == text_hash(manifest.content_text)


def test_candidate_rejects_a_profile_changed_after_start(prepared):
    database, _, store, run = prepared
    from codehead.clinic.files import InvalidFile

    with database.sessions.begin() as session:
        persisted = session.get(Run, run.id)
        persisted.profile_hash = "c" * 64
        with pytest.raises(InvalidFile):
            store.ensure(session, persisted)


def test_two_roles_keep_independent_files_and_test_provenance(prepared):
    apply(
        prepared, "backend", [FileProposal(relative_path="backend/clinic_api.py", content="one\n")]
    )
    snapshot = apply(
        prepared, "frontend", [FileProposal(relative_path="frontend/src/App.tsx", content="two\n")]
    )
    assert snapshot.candidate.revision == 3
    files = {file.relative_path: file for file in snapshot.candidate.files}
    assert files["backend/clinic_api.py"].content_hash == text_hash("one\n")
    assert files["frontend/src/App.tsx"].content_hash == text_hash("two\n")
    assert all(
        file.origin == "test_injected" and file.source == "test"
        for file in files.values()
        if file.producer_id
    )


def test_new_source_version_keeps_its_parent(prepared):
    before = apply(
        prepared, "backend", [FileProposal(relative_path="backend/clinic_api.py", content="one\n")]
    )
    first = next(
        file for file in before.candidate.files if file.relative_path == "backend/clinic_api.py"
    )
    after = apply(
        prepared,
        "backend",
        [
            FileProposal(
                relative_path=first.relative_path, content="two\n", base_hash=first.content_hash
            )
        ],
    )
    second = next(
        file for file in after.candidate.files if file.relative_path == first.relative_path
    )
    assert second.version == 2
    assert second.parent_hash == first.content_hash
    assert second.parent_artifact_id == first.artifact_id
    assert first.artifact_id != second.artifact_id
    assert {first.artifact_id, second.artifact_id} <= {artifact.id for artifact in after.artifacts}


def test_conflicting_batch_keeps_every_previous_file_and_revision(prepared):
    before = apply(
        prepared, "backend", [FileProposal(relative_path="backend/clinic_api.py", content="one\n")]
    )
    with pytest.raises(FileConflict):
        apply(
            prepared,
            "backend",
            [
                FileProposal(relative_path="backend/clinic_models.py", content="not accepted\n"),
                FileProposal(relative_path="backend/clinic_api.py", content="stale\n"),
            ],
        )
    _, service, _, run = prepared
    after = service.snapshot(run.id)
    assert after.candidate == before.candidate
    assert after.artifacts == before.artifacts


def test_events_include_the_exact_candidate_snapshot(prepared):
    snapshot = apply(
        prepared,
        "frontend",
        [FileProposal(relative_path="frontend/src/App.tsx", content="frontend\n")],
    )
    _, service, _, run = prepared
    event = service.events(run.id).events[-1]
    assert event.payload.candidate == snapshot.candidate
    assert event.payload.artifacts == snapshot.artifacts
