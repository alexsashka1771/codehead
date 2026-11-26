"""Lease publication of immutable candidates without performing filesystem I/O."""

from dataclasses import dataclass
from datetime import timedelta
from pathlib import Path

from sqlalchemy import select

from codehead.clinic.files import InvalidFile, text_hash
from codehead.contracts import CandidateView
from codehead.errors import DomainError
from codehead.persistence.candidates import candidate_view
from codehead.persistence.models import Artifact, Candidate, Run
from codehead.workflow.definition import CANDIDATE_WORKFLOW_VERSIONS, QUALITY_WORKFLOW_VERSIONS

NEXT_STAGE_REASON = "Следующий этап Clinic Demo ещё не подключён: QA, DevOps и preview."


@dataclass(frozen=True)
class PublicationLease:
    run_id: str
    candidate_id: str
    revision: int
    manifest_artifact_id: str
    owner: str
    fence: int
    candidate: CandidateView
    contents: dict[str, str]
    manifest_content: str


class PublicationTransactions:
    @staticmethod
    def _content(session, run_id, artifact_id, *, kind, version, digest, byte_size):
        artifact = session.get(Artifact, artifact_id)
        if (
            artifact is None
            or artifact.run_id != run_id
            or artifact.artifact_type != kind
            or artifact.version != version
            or artifact.content_hash != digest
            or artifact.byte_size != byte_size
            or artifact.content_text is None
        ):
            raise InvalidFile("Immutable версия кандидата недоступна или изменилась.")
        content = artifact.content_text
        if text_hash(content) != digest or len(content.encode("utf-8")) != byte_size:
            raise InvalidFile("Хэш или размер immutable содержимого кандидата не совпадает.")
        return content

    def claim_publication(self, owner):
        self.register(owner)
        with self.database.sessions.begin() as session:
            run = session.scalar(
                select(Run)
                .where(
                    Run.workflow_version.in_(CANDIDATE_WORKFLOW_VERSIONS),
                    Run.status == "running",
                    Run.cancel_requested.is_(False),
                    Run.pause_requested.is_(False),
                )
                .order_by(Run.created_at)
                .with_for_update(skip_locked=True)
            )
            if run is None:
                return None
            candidate = session.scalar(select(Candidate).where(Candidate.run_id == run.id))
            if candidate is None or candidate.status != "materializing":
                return None
            if (
                candidate.publication_owner is not None
                and candidate.publication_expires_at is not None
                and candidate.publication_expires_at > self.clock()
            ):
                return None
            try:
                self.candidates.ensure(session, run)
                view = candidate_view(session, run.id)
                contents = {
                    file.relative_path: self._content(
                        session,
                        run.id,
                        file.artifact_id,
                        kind="source_code",
                        version=file.version,
                        digest=file.content_hash,
                        byte_size=file.byte_size,
                    )
                    for file in view.files
                }
                manifest = self._content(
                    session,
                    run.id,
                    view.manifest_artifact_id,
                    kind="candidate_manifest",
                    version=view.revision,
                    digest=view.manifest_hash,
                    byte_size=view.manifest_byte_size,
                )
            except InvalidFile as failure:
                self._publication_blocked(session, run, candidate, str(failure), owner)
                return None
            candidate.publication_fence += 1
            candidate.publication_owner = owner
            candidate.publication_expires_at = self.clock() + timedelta(seconds=self.lease_seconds)
            candidate.updated_at = self.clock()
            lease = PublicationLease(
                run.id,
                candidate.id,
                candidate.revision,
                candidate.manifest_artifact_id,
                owner,
                candidate.publication_fence,
                view,
                contents,
                manifest,
            )
            self._emit_workflow(session, run, "candidate.materialization_claimed", actor_id=owner)
            return lease

    def _publication_current(self, session, run, lease):
        candidate = session.get(Candidate, lease.candidate_id)
        valid = (
            run.status == "running"
            and not run.pause_requested
            and not run.cancel_requested
            and candidate is not None
            and candidate.run_id == run.id
            and candidate.status == "materializing"
            and candidate.revision == lease.revision
            and candidate.manifest_artifact_id == lease.manifest_artifact_id
            and candidate.publication_owner == lease.owner
            and candidate.publication_fence == lease.fence
            and candidate.publication_expires_at is not None
            and candidate.publication_expires_at > self.clock()
            and run.profile_version == candidate.profile_version == lease.candidate.profile_version
            and run.profile_hash == candidate.profile_hash == lease.candidate.profile_hash
            and run.acceptance_suite_hash
            == candidate.acceptance_suite_hash
            == lease.candidate.acceptance_suite_hash
            and run.template_hash == candidate.template_hash == lease.candidate.template_hash
        )
        return candidate if valid else None

    def heartbeat_publication(self, lease):
        with self.database.sessions.begin() as session:
            run = self._run(session, lease.run_id, for_update=True)
            candidate = self._publication_current(session, run, lease)
            if candidate is None:
                raise DomainError(
                    "stale_publication", "Lease публикации кандидата больше не актуален."
                )
            self._register(session, lease.owner)
            candidate.publication_expires_at = self.clock() + timedelta(seconds=self.lease_seconds)
            self._emit_workflow(
                session, run, "candidate.materialization_renewed", actor_id=lease.owner
            )

    def finish_publication(self, lease, destination):
        expected = self.workspace_root / lease.candidate_id / f"v{lease.revision}"
        if str(Path(destination).absolute()).casefold() != str(expected.absolute()).casefold():
            raise InvalidFile("Материализация вернула путь другой версии кандидата.")
        with self.database.sessions.begin() as session:
            run = self._run(session, lease.run_id, for_update=True)
            candidate = self._publication_current(session, run, lease)
            if candidate is None:
                return False
            candidate.status, candidate.blocked_reason = "ready", None
            candidate.workspace_path = str(expected.absolute())
            candidate.publication_owner, candidate.publication_expires_at = None, None
            candidate.updated_at = self.clock()
            self._emit_workflow(session, run, "candidate.ready", actor_id=lease.owner)
            if run.workflow_version in QUALITY_WORKFLOW_VERSIONS:
                try:
                    self._quality_ready(session, run, candidate)
                except (InvalidFile, ValueError, OSError) as failure:
                    self._publication_blocked(session, run, candidate, str(failure), lease.owner)
                return True
            self._block(
                session,
                run,
                [
                    task
                    for task in self._tasks(session, run.id)
                    if task.role == "qa" and task.status == "queued"
                ],
                NEXT_STAGE_REASON,
                "stage.unavailable",
            )
            return True

    def _publication_blocked(self, session, run, candidate, reason, owner):
        candidate.status, candidate.blocked_reason = "blocked", reason
        candidate.workspace_path = None
        candidate.publication_owner, candidate.publication_expires_at = None, None
        candidate.publication_fence += 1
        candidate.updated_at = self.clock()
        run.status, run.blocked_reason = "blocked", reason
        self._emit_workflow(session, run, "candidate.materialization_failed", actor_id=owner)

    def fail_publication(self, lease, failure):
        with self.database.sessions.begin() as session:
            run = self._run(session, lease.run_id, for_update=True)
            candidate = self._publication_current(session, run, lease)
            if candidate is None:
                return False
            reason = (
                str(failure)
                if isinstance(failure, InvalidFile)
                else (
                    "Не удалось записать или проверить workspace кандидата; "
                    "существующие файлы сохранены."
                )
            )
            self._publication_blocked(session, run, candidate, reason, lease.owner)
            return True

    def _recover_publication(self, session, run):
        candidate = session.scalar(select(Candidate).where(Candidate.run_id == run.id))
        if candidate is None or candidate.publication_owner is None:
            return 0
        if (
            candidate.publication_expires_at is not None
            and candidate.publication_expires_at > self.clock()
            and not run.pause_requested
            and not run.cancel_requested
        ):
            return 0
        candidate.publication_owner, candidate.publication_expires_at = None, None
        candidate.publication_fence += 1
        candidate.updated_at = self.clock()
        self._emit_workflow(session, run, "candidate.materialization_recovered")
        return 1
