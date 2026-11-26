"""Run trusted checks outside database transactions and stop on control or lost lease."""

import threading

from sqlalchemy.exc import SQLAlchemyError

from codehead.clinic.files import InvalidFile
from codehead.delivery.runtime import RuntimeRequest, RuntimeResult
from codehead.errors import DomainError
from codehead.workflow.preview_service import valid_ready_result


class ToolWorker:
    def __init__(self, service):
        self.service = service

    def execute(self, lease):
        from codehead.runner.execution import RestrictedProcessRunner, RunnerRequest

        try:
            if not self.service.begin_tool(lease):
                return
        except DomainError as failure:
            if failure.code != "stale_tool":
                raise
            return
        runner = self.service.tool_runner or RestrictedProcessRunner(
            timeout_seconds=lease.tool.timeout_seconds,
            output_limit_bytes=lease.tool.output_limit_bytes,
            secrets=self.service.secrets,
        )
        request = RunnerRequest(
            lease.tool.id,
            lease.tool.operation_id,
            lease.candidate,
            lease.contents,
            lease.manifest_content,
        )
        done, lease_lost = threading.Event(), threading.Event()

        def should_stop():
            if lease_lost.is_set():
                return True
            try:
                return self.service.tool_should_stop(lease)
            except (DomainError, SQLAlchemyError):
                lease_lost.set()
                return True

        def renew():
            while not done.wait(self.service.lease_seconds / 3):
                try:
                    self.service.heartbeat_tool(lease)
                except (DomainError, SQLAlchemyError):
                    lease_lost.set()
                    return

        renewal = threading.Thread(target=renew, daemon=True)
        renewal.start()
        try:
            try:
                result = runner.execute(request, should_stop=should_stop)
                if lease_lost.is_set():
                    self.service.recover()
                else:
                    self.service.finish_tool(lease, result)
            except DomainError as failure:
                if failure.code != "stale_tool":
                    raise
                self.service.recover()
            except Exception as execution_failure:
                # execute may have started a process before raising; failure is not a known outcome.
                try:
                    self.service.abandon_tool(
                        lease,
                        process_id=getattr(execution_failure, "process_id", None),
                        commands=getattr(execution_failure, "commands", None),
                    )
                except DomainError as failure:
                    if failure.code != "stale_tool":
                        raise
                    self.service.recover()
        finally:
            done.set()
            renewal.join()

    def execute_runtime(self, lease):
        service = self.service
        done, lease_lost = threading.Event(), threading.Event()
        operation = lease.tool.operation_id

        def should_stop():
            if lease_lost.is_set():
                return True
            try:
                return service.runtime_tool_should_stop(lease)
            except (DomainError, SQLAlchemyError):
                lease_lost.set()
                return True

        def renew():
            while not done.wait(service.lease_seconds / 3):
                try:
                    service.heartbeat_runtime_tool(lease)
                except (DomainError, SQLAlchemyError):
                    lease_lost.set()
                    return

        renewal = threading.Thread(target=renew, daemon=True)
        renewal.start()
        runtime = service.preview_runtime
        preview_id = lease.tool.preview_session_id
        cleanup_required = False
        try:
            try:
                if operation == "stop_preview":
                    result = (
                        runtime.stop(preview_id, lease.owner_boot)
                        if runtime.owns(preview_id, lease.owner_boot)
                        else runtime.confirmed_stop(preview_id, lease.owner_boot)
                    )
                    if result is None and service.runtime_stop_before_start(lease):
                        result = RuntimeResult("stopped")
                    if result is None:
                        result = RuntimeResult(
                            "uncertain",
                            error_code="preview_ownership_unknown",
                            error_message="Worker не владеет процессами этой сессии.",
                        )
                elif should_stop():
                    result = RuntimeResult("cancelled", error_code="control_requested")
                else:
                    package = service._load_delivery_package(lease.delivery)
                    request = RuntimeRequest(
                        lease.tool.preview_session_id or lease.tool.id,
                        package,
                        service.preview_data_root,
                        lease.owner_boot,
                    )
                    execute = runtime.smoke if operation == "smoke_test" else runtime.start
                    result = execute(
                        request,
                        should_stop=should_stop,
                        timeout_seconds=lease.tool.timeout_seconds,
                        output_limit_bytes=lease.tool.output_limit_bytes,
                    )
            except (InvalidFile, OSError, ValueError):
                result = RuntimeResult(
                    "failed",
                    error_code="package_changed",
                    error_message="Целостность закреплённого пакета не подтверждена.",
                )
            except DomainError:
                lease_lost.set()
                result = RuntimeResult("uncertain")
            except Exception:
                result = RuntimeResult(
                    "uncertain",
                    error_code="runner_unknown_outcome",
                    error_message="Runner прерван после начала операции preview.",
                )
            if operation == "start_preview":
                owned = runtime.owns(preview_id, lease.owner_boot)
                cleanup_required = owned and valid_ready_result(result)
                if not cleanup_required and (owned or result.status == "ready"):
                    stopped = (
                        owned and runtime.stop(preview_id, lease.owner_boot).status == "stopped"
                    )
                    result = RuntimeResult(
                        "failed" if stopped else "uncertain",
                        error_code="preview_result_unconfirmed",
                        error_message="Runner не подтвердил готовность процессов preview.",
                    )
            if not lease_lost.is_set():
                try:
                    service.finish_runtime_tool(lease, result)
                    cleanup_required = False
                except (DomainError, SQLAlchemyError):
                    lease_lost.set()
        finally:
            done.set()
            renewal.join()
            if cleanup_required:
                runtime.stop(preview_id, lease.owner_boot)
