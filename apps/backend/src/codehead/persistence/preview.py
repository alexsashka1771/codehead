"""Read-only runtime access and transactional, optimistic preview commands."""

from datetime import timedelta

from sqlalchemy import select

from codehead.contracts import DeliveryView, PreviewAccess, PreviewSessionView, PreviewView
from codehead.errors import DomainError
from codehead.persistence.models import PreviewSession, WorkerHeartbeat

PREVIEW_HEALTH_SECONDS = 10
PREVIEW_ACTIVE = ("created", "starting", "ready", "stopping", "uncertain")


class PreviewTransactions:
    @staticmethod
    def _previews(session, run_id):
        return list(
            session.scalars(
                select(PreviewSession)
                .where(PreviewSession.run_id == run_id)
                .order_by(PreviewSession.version)
            )
        )

    @staticmethod
    def _package_matches(preview, delivery):
        return (
            preview.run_id == delivery.run_id
            and preview.package_id == delivery.id
            and preview.package_generation == delivery.package_generation
            and preview.package_tree_hash == delivery.package_tree_hash
        )

    def _preview_access(self, session, run, delivery, preview):
        metadata = {"run_id": run.id, "package_id": delivery.id if delivery else None}
        if preview is not None:
            metadata.update(preview_session_id=preview.id, version=preview.version)
        if not self._ready_delivery(run, delivery):
            reason = "Пока нет проверенного пакета этого запуска."
        elif preview is None:
            reason = "Запустите preview для этого пакета."
        elif not self._package_matches(preview, delivery) or preview.status != "ready":
            reason = preview.error_message or "Сессия preview пока недоступна."
        else:
            stamp = self.clock()
            owner = session.get(WorkerHeartbeat, preview.worker_boot_id)
            if owner is None or owner.expires_at <= stamp:
                reason = "Worker сессии preview недоступен."
            elif (
                preview.lease_expires_at <= stamp
                or preview.health_checked_at > stamp
                or preview.health_checked_at <= stamp - timedelta(seconds=PREVIEW_HEALTH_SECONDS)
            ):
                reason = "Проверка доступности preview устарела."
            else:
                return PreviewAccess(
                    **metadata,
                    status="available",
                    origin=preview.origin,
                    health_checked_at=preview.health_checked_at,
                )
        return PreviewAccess(**metadata, status="unavailable", reason=reason)

    def preview(self, run_id):
        with self.database.read() as session:
            run = self._run(session, run_id)
            delivery = self._delivery(session, run.id)
            previews = self._previews(session, run.id)
            return PreviewView(
                run_id=run.id,
                delivery=DeliveryView.model_validate(delivery) if delivery else None,
                preview_sessions=[PreviewSessionView.model_validate(row) for row in previews],
                access=self._preview_access(
                    session, run, delivery, previews[-1] if previews else None
                ),
            )

    def preview_command(self, run_id, command, key, correlation_id):
        from codehead.persistence.service import identifier, payload_hash

        scope, digest = f"preview:{run_id}", payload_hash(command)
        with self.database.sessions.begin() as session:
            self._lock_commands(session)
            run = self._run(session, run_id, for_update=True)
            existing = self._receipt(session, scope, key, digest)
            if existing is not None:
                return PreviewSessionView.model_validate(existing)
            delivery = self._delivery(session, run.id)
            if delivery is None or delivery.id != command.package_id:
                raise DomainError("not_found", "Пакет запуска не найден.", status=404)
            previews = self._previews(session, run.id)
            preview = previews[-1] if previews else None
            if command.expected_version != (preview.version if preview else 0):
                raise DomainError("conflict", "Версия сессии preview изменилась.")
            if command.command == "start":
                if not self._ready_delivery(run, delivery):
                    raise DomainError("delivery_not_ready", "Для preview нужен проверенный пакет.")
                if preview is not None and preview.status in PREVIEW_ACTIVE:
                    raise DomainError("conflict", "Предыдущая сессия preview ещё не завершена.")
                stamp = self.clock()
                preview = PreviewSession(
                    id=identifier(),
                    run_id=run.id,
                    package_id=delivery.id,
                    package_generation=delivery.package_generation,
                    package_tree_hash=delivery.package_tree_hash,
                    status="created",
                    version=command.expected_version + 1,
                    created_at=stamp,
                    updated_at=stamp,
                )
                session.add(preview)
                tool = self._new_delivery_tool(
                    session, delivery, "start_preview", preview_id=preview.id
                )
                preview.start_tool_run_id = tool.id
            else:
                if (
                    preview is None
                    or preview.id != command.preview_session_id
                    or not self._package_matches(preview, delivery)
                    or preview.status not in {"created", "starting", "ready"}
                ):
                    raise DomainError("conflict", "Эту сессию preview нельзя остановить.")
                tool = self._new_delivery_tool(
                    session, delivery, "stop_preview", preview_id=preview.id
                )
                preview.stop_tool_run_id = tool.id
                preview.status, preview.origin = "stopping", None
                preview.version += 1
                preview.updated_at = self.clock()
            self._emit_workflow(
                session,
                run,
                f"preview.{command.command}_queued",
                actor_id="local_user",
                correlation_id=correlation_id,
            )
            result = PreviewSessionView.model_validate(preview)
            self._save_receipt(session, scope, key, digest, result)
            return result
