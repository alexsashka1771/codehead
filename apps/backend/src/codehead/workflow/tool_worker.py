"""Run trusted checks outside database transactions and stop on control or lost lease."""

import threading

from sqlalchemy.exc import SQLAlchemyError

from codehead.errors import DomainError


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
