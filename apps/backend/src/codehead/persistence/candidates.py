"""Candidate manifests mutate only inside the caller's locked Run transaction."""

import json
from uuid import uuid4

from sqlalchemy import select

from codehead.clinic.files import (
    InvalidFile,
    normalize_relative_path,
    text_hash,
    tree_hash,
    validate_batch,
    validate_text,
)
from codehead.contracts import CandidateFileView, CandidateView
from codehead.persistence.models import Artifact, Candidate


def candidate_view(session, run_id):
    candidate = session.scalar(select(Candidate).where(Candidate.run_id == run_id))
    if candidate is None:
        return None
    manifest = session.get(Artifact, candidate.manifest_artifact_id)
    if (
        manifest is None
        or manifest.run_id != candidate.run_id
        or manifest.version != candidate.revision
    ):
        raise InvalidFile("Immutable manifest кандидата недоступен или принадлежит другой версии.")
    value = {
        name: getattr(candidate, name)
        for name in CandidateView.model_fields
        if hasattr(candidate, name)
    }
    value.update(manifest_hash=manifest.content_hash, manifest_byte_size=manifest.byte_size)
    return CandidateView.model_validate(value)


class CandidateStore:
    def __init__(self, profile, *, clock):
        self.profile = profile
        self.clock = clock

    @staticmethod
    def view(session, run_id):
        return candidate_view(session, run_id)

    def ensure(self, session, run):
        if (
            run.profile_version != self.profile.id
            or run.profile_hash != self.profile.profile_hash
            or run.acceptance_suite_hash != self.profile.suite_hash
            or run.template_hash != self.profile.template_hash
        ):
            raise InvalidFile(
                "Закреплённый профиль, каркас или набор проверок изменился после Start."
            )
        candidate = session.scalar(select(Candidate).where(Candidate.run_id == run.id))
        if candidate is not None:
            if candidate.template_hash != self.profile.template_hash:
                raise InvalidFile("Технический каркас изменился после создания кандидата.")
            return candidate
        files = []
        artifacts = []
        for file in self.profile.template_files:
            relative_path = normalize_relative_path(file.relative_path)
            content = validate_text(file.content)
            if text_hash(content) != file.content_hash:
                raise InvalidFile("Хэш технического каркаса не соответствует содержимому.")
            artifact = Artifact(
                id=str(uuid4()),
                run_id=run.id,
                task_id=None,
                artifact_type="source_code",
                version=1,
                content_hash=file.content_hash,
                relative_path=relative_path,
                author_role=None,
                input_versions={},
                created_at=self.clock(),
                provenance={"origin": "template", "producer_id": None, "parent_artifact_id": None},
                media_type=file.media_type,
                byte_size=len(content.encode("utf-8")),
                content_text=content,
            )
            artifacts.append(artifact)
            files.append(
                CandidateFileView(
                    relative_path=relative_path,
                    artifact_id=artifact.id,
                    version=1,
                    content_hash=file.content_hash,
                    media_type=file.media_type,
                    byte_size=artifact.byte_size,
                    origin="template",
                    source="template",
                ).model_dump(mode="json")
            )
        manifest_tree = tree_hash({file["relative_path"]: file["content_hash"] for file in files})
        if manifest_tree != self.profile.template_hash:
            raise InvalidFile("Manifest технического каркаса не соответствует его хэшу.")
        stamp = self.clock()
        candidate = Candidate(
            id=str(uuid4()),
            run_id=run.id,
            revision=1,
            status="assembling",
            profile_version=run.profile_version,
            profile_hash=run.profile_hash,
            acceptance_suite_hash=run.acceptance_suite_hash,
            template_hash=self.profile.template_hash,
            tree_hash=manifest_tree,
            manifest_artifact_id=str(uuid4()),
            files=sorted(files, key=lambda item: item["relative_path"]),
            created_at=stamp,
            updated_at=stamp,
            publication_fence=0,
        )
        self._manifest(session, run, candidate)
        session.add_all(artifacts)
        session.add(candidate)
        return candidate

    def apply(self, session, run, task, attempt, proposals, *, input_versions):
        candidate = self.ensure(session, run)
        current = {file["relative_path"]: file for file in candidate.files}
        prepared = validate_batch(
            task.role,
            proposals,
            {path: file["content_hash"] for path, file in current.items()},
            max_file_bytes=run.limits.get("max_file_bytes", 65536),
            max_files=run.limits.get("max_files_per_proposal", 4),
            max_total_bytes=run.limits.get("max_proposal_bytes", 262144),
        )
        artifact_ids = []
        for file in prepared:
            parent = current.get(file.relative_path)
            artifact = Artifact(
                id=str(uuid4()),
                run_id=run.id,
                task_id=task.id,
                artifact_type="source_code",
                version=parent["version"] + 1 if parent else 1,
                content_hash=file.content_hash,
                relative_path=file.relative_path,
                author_role=task.role,
                input_versions=dict(input_versions),
                created_at=self.clock(),
                provenance={
                    "origin": "test" if attempt.provider == "test" else "llm",
                    "producer_id": attempt.id,
                    "parent_artifact_id": parent["artifact_id"] if parent else None,
                },
                media_type=file.media_type,
                byte_size=file.byte_size,
                content_text=file.content,
            )
            session.add(artifact)
            artifact_ids.append(artifact.id)
            current[file.relative_path] = CandidateFileView(
                relative_path=file.relative_path,
                artifact_id=artifact.id,
                version=artifact.version,
                content_hash=file.content_hash,
                media_type=file.media_type,
                byte_size=file.byte_size,
                origin="test_injected" if attempt.provider == "test" else "generated",
                source="test" if attempt.provider == "test" else "live",
                producer_id=attempt.id,
                producer_role=task.role,
                parent_artifact_id=parent["artifact_id"] if parent else None,
                parent_hash=parent["content_hash"] if parent else None,
                input_versions=dict(input_versions),
            ).model_dump(mode="json")
        candidate.files = sorted(current.values(), key=lambda item: item["relative_path"])
        candidate.tree_hash = tree_hash(
            {path: file["content_hash"] for path, file in current.items()}
        )
        candidate.revision += 1
        candidate.updated_at = self.clock()
        candidate.status, candidate.blocked_reason = "assembling", None
        candidate.workspace_path = None
        self._manifest(
            session, run, candidate, task=task, attempt=attempt, input_versions=input_versions
        )
        return tuple(artifact_ids)

    def inject_test_file(self, session, run, fixture):
        candidate = self.ensure(session, run)
        if candidate.status != "ready" or fixture.relative_path != "backend/clinic_storage.py":
            raise InvalidFile("Инъекция требует готовый кандидат и доверенную область storage.")
        current = {file["relative_path"]: file for file in candidate.files}
        parent = current[fixture.relative_path]
        content = validate_text(fixture.content)
        if (
            text_hash(content) != fixture.content_hash
            or len(content.encode("utf-8")) > run.limits["max_file_bytes"]
        ):
            raise InvalidFile("Доверенная fixture не соответствует хэшу или лимиту.")
        before = {
            "revision": candidate.revision,
            "tree_hash": candidate.tree_hash,
            "manifest_artifact_id": candidate.manifest_artifact_id,
            "manifest_hash": session.get(Artifact, candidate.manifest_artifact_id).content_hash,
            "storage_hash": parent["content_hash"],
        }
        artifact = Artifact(
            id=str(uuid4()),
            run_id=run.id,
            task_id=None,
            artifact_type="source_code",
            version=parent["version"] + 1,
            content_hash=fixture.content_hash,
            relative_path=fixture.relative_path,
            author_role=None,
            input_versions={parent["artifact_id"]: parent["version"]},
            created_at=self.clock(),
            provenance={
                "origin": "test",
                "producer_id": None,
                "parent_artifact_id": parent["artifact_id"],
            },
            media_type=parent["media_type"],
            byte_size=len(content.encode("utf-8")),
            content_text=content,
        )
        session.add(artifact)
        current[fixture.relative_path] = CandidateFileView(
            relative_path=fixture.relative_path,
            artifact_id=artifact.id,
            version=artifact.version,
            content_hash=artifact.content_hash,
            media_type=artifact.media_type,
            byte_size=artifact.byte_size,
            origin="test_injected",
            source="test",
            producer_id=None,
            producer_role=None,
            parent_artifact_id=parent["artifact_id"],
            parent_hash=parent["content_hash"],
            input_versions=artifact.input_versions,
        ).model_dump(mode="json")
        candidate.files = sorted(current.values(), key=lambda file: file["relative_path"])
        candidate.tree_hash = tree_hash(
            {path: file["content_hash"] for path, file in current.items()}
        )
        candidate.revision += 1
        candidate.status, candidate.workspace_path = "materializing", None
        candidate.updated_at = self.clock()
        self._manifest(
            session, run, candidate, input_versions=artifact.input_versions, system_test=True
        )
        return before, {
            "revision": candidate.revision,
            "tree_hash": candidate.tree_hash,
            "manifest_artifact_id": candidate.manifest_artifact_id,
            "manifest_hash": session.get(Artifact, candidate.manifest_artifact_id).content_hash,
            "storage_hash": artifact.content_hash,
        }

    def _manifest(
        self,
        session,
        run,
        candidate,
        *,
        task=None,
        attempt=None,
        input_versions=None,
        system_test=False,
    ):
        parent = candidate.manifest_artifact_id if candidate.revision > 1 else None
        content = (
            json.dumps(
                {
                    "candidate_id": candidate.id,
                    "run_id": run.id,
                    "revision": candidate.revision,
                    "profile_version": candidate.profile_version,
                    "profile_hash": candidate.profile_hash,
                    "acceptance_suite_hash": candidate.acceptance_suite_hash,
                    "template_hash": candidate.template_hash,
                    "tree_hash": candidate.tree_hash,
                    "normalization_version": "utf8-lf-v1",
                    "files": candidate.files,
                },
                ensure_ascii=False,
                sort_keys=True,
                indent=2,
            )
            + "\n"
        )
        artifact = Artifact(
            id=str(uuid4()),
            run_id=run.id,
            task_id=task.id if task else None,
            artifact_type="candidate_manifest",
            version=candidate.revision,
            content_hash=text_hash(content),
            relative_path=f"manifests/{candidate.id}/v{candidate.revision}.json",
            author_role=task.role if task else None,
            input_versions=dict(input_versions or {}),
            created_at=self.clock(),
            provenance={
                "origin": "test"
                if system_test or attempt and attempt.provider == "test"
                else "template",
                "producer_id": attempt.id if attempt else None,
                "parent_artifact_id": parent,
            },
            media_type="application/json",
            byte_size=len(content.encode("utf-8")),
            content_text=content,
        )
        session.add(artifact)
        candidate.manifest_artifact_id = artifact.id
