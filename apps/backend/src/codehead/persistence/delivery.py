"""Pinned delivery records and the read-only archive boundary."""

from sqlalchemy import select

from codehead.clinic.files import InvalidFile
from codehead.contracts import DeliveryView
from codehead.errors import DomainError
from codehead.persistence.models import Delivery, ToolRun
from codehead.persistence.tools import PIN_FIELDS

DELIVERY_VERSION = "clinic-v4"
RUNTIME_TOOLS = ("smoke_test", "start_preview", "stop_preview")
PACKAGE_FIELDS = (
    "manifest_hash",
    "manifest_byte_size",
    "tree_hash",
    "archive_hash",
    "archive_byte_size",
    "payload_byte_size",
    "file_count",
)


class DeliveryTransactions:
    @staticmethod
    def _delivery(session, run_id):
        return session.scalar(select(Delivery).where(Delivery.run_id == run_id))

    def _has_active_delivery_publication(self, session, run_id):
        delivery = self._delivery(session, run_id)
        return delivery is not None and delivery.status == "publishing"

    @staticmethod
    def _ready_delivery(run, delivery):
        return (
            run.mode == "test"
            and run.workflow_version == DELIVERY_VERSION
            and run.status == "succeeded"
            and delivery is not None
            and delivery.run_id == run.id
            and delivery.status == "ready"
        )

    def _load_delivery_package(self, delivery):
        package = self.package_compiler.load(
            delivery.id,
            delivery.package_generation,
            manifest_hash=delivery.package_manifest_hash,
            archive_hash=delivery.package_archive_hash,
            archive_byte_size=delivery.package_archive_byte_size,
        )
        if (
            (package.package_id, package.generation, package.run_id, package.candidate_id)
            != (delivery.id, delivery.package_generation, delivery.run_id, delivery.candidate_id)
            or package.revision != delivery.revision
            or any(getattr(package, name) != getattr(delivery, name) for name in PIN_FIELDS)
            or any(
                getattr(package, name) != getattr(delivery, f"package_{name}")
                for name in PACKAGE_FIELDS
            )
        ):
            raise InvalidFile("Закреплённая версия пакета изменилась.")
        return package

    def delivery_archive(self, run_id, package_id):
        with self.database.read() as session:
            run = self._run(session, run_id)
            delivery = self._delivery(session, run.id)
            if delivery is None or delivery.id != package_id:
                raise DomainError("not_found", "Пакет запуска не найден.", status=404)
            if not self._ready_delivery(run, delivery):
                raise DomainError("delivery_not_ready", "Пакет ещё не прошёл проверки доставки.")
            result = DeliveryView.model_validate(delivery)
        try:
            package = self._load_delivery_package(result)
            content = self.package_compiler.read_archive(package)
        except (InvalidFile, OSError, ValueError) as failure:
            raise DomainError(
                "package_unavailable", "Целостность архива пакета не подтверждена."
            ) from failure
        return result, content

    def _new_delivery_tool(self, session, delivery, operation, *, preview_id=None):
        from codehead.persistence.service import identifier

        tool = ToolRun(
            id=identifier(),
            run_id=delivery.run_id,
            delivery_id=delivery.id,
            preview_session_id=preview_id,
            operation_id=operation,
            workspace_id=delivery.candidate_id,
            snapshot_version=delivery.revision,
            tree_hash=delivery.tree_hash,
            manifest_artifact_id=delivery.manifest_artifact_id,
            manifest_hash=delivery.manifest_hash,
            **{name: getattr(delivery, name) for name in PIN_FIELDS},
            required_isolation="process_only",
            timeout_seconds=20,
            output_limit_bytes=65536,
            status="created",
            created_at=self.clock(),
        )
        session.add(tool)
        return tool

    def _remaining_duration(self, run):
        return run.limits["max_duration_seconds"] - (self.clock() - run.created_at).total_seconds()

    def _settle_delivery_control(self, session, run, *, running, uncertain):
        delivery = self._delivery(session, run.id)
        if delivery is None or not (run.cancel_requested or run.pause_requested):
            return
        if run.cancel_requested and not (running or uncertain):
            delivery.status, delivery.updated_at, delivery.finished_at = (
                "cancelled",
                self.clock(),
                self.clock(),
            )
