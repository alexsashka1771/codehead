"""Provider execution and lease renewal outside HTTP handlers."""

import threading
from concurrent.futures import ThreadPoolExecutor

from sqlalchemy.exc import SQLAlchemyError

from codehead.clinic.files import InvalidFile
from codehead.delivery.runtime import RuntimeResult
from codehead.errors import DomainError
from codehead.llm.provider import ProviderFailure
from codehead.persistence.preview import PREVIEW_HEALTH_SECONDS
from codehead.workflow.tool_worker import ToolWorker


class Worker:
    def __init__(self, service, *, owner, provider=None):
        self.service = service
        self.owner = owner
        self.provider = provider

    def run_once(self, *, maintain_previews=True):
        recovered = self.service.recover()
        self.service.register(self.owner)
        previews = self._maintain_previews() if maintain_previews else 0
        accepted = self.service.accept_decisions()
        runtime_tool = self.service.claim_runtime_tool(self.owner)
        if runtime_tool is not None:
            ToolWorker(self.service).execute_runtime(runtime_tool)
            return True
        delivery = self.service.claim_delivery(self.owner)
        if delivery is not None:
            self._publish_delivery(delivery)
            return True
        tool = self.service.claim_tool(self.owner)
        if tool is not None:
            ToolWorker(self.service).execute(tool)
            return True
        publication = self.service.claim_publication(self.owner)
        if publication is not None:
            self._publish(publication)
            return True
        lease = self.service.claim(self.owner, self.provider)
        if lease is None:
            return bool(previews or recovered or accepted)
        try:
            if not self.service.begin(lease):
                return True
        except DomainError as failure:
            if failure.code != "stale_attempt":
                raise
            return True
        done = threading.Event()
        lease_lost = threading.Event()

        def renew():
            while not done.wait(self.service.lease_seconds / 3):
                try:
                    self.service.heartbeat(lease)
                except DomainError:
                    lease_lost.set()
                    return

        renewal = threading.Thread(target=renew, daemon=True)
        renewal.start()
        try:
            try:
                if lease.request.role == "devops":
                    try:
                        self.service._verify_devops_package(lease.run_id)
                    except (InvalidFile, OSError, ValueError) as failure:
                        raise ProviderFailure(
                            "package_unavailable",
                            "Целостность пакета перед DevOps не подтверждена.",
                        ) from failure
                result = lease.provider.run(lease.request)
                if lease_lost.is_set():
                    self.service.recover()
                else:
                    if lease.request.role == "devops":
                        try:
                            self.service._verify_devops_package(lease.run_id)
                        except (InvalidFile, OSError, ValueError) as failure:
                            raise ProviderFailure(
                                "package_unavailable",
                                "Пакет изменился во время анализа DevOps.",
                                dispatched=True,
                                raw_response=result.raw_response,
                                stop_reason=result.stop_reason,
                            ) from failure
                    self.service.finish(lease, result)
            except ProviderFailure as failure:
                try:
                    self.service.fail(lease, failure)
                except DomainError as stale:
                    if stale.code != "stale_attempt":
                        raise
                    self.service.recover()
            except DomainError as failure:
                if failure.code != "stale_attempt":
                    raise
                self.service.recover()
        finally:
            done.set()
            renewal.join()
        return True

    def _publish_delivery(self, lease):
        done, lease_lost = threading.Event(), threading.Event()

        def renew():
            while not done.wait(self.service.lease_seconds / 3):
                try:
                    self.service.heartbeat_delivery(lease)
                except (DomainError, SQLAlchemyError):
                    lease_lost.set()
                    return

        renewal = threading.Thread(target=renew, daemon=True)
        renewal.start()
        try:
            try:
                try:
                    package = self.service.package_compiler.publish(lease.request)
                    self.service.package_compiler.verify(package)
                except (InvalidFile, OSError, ValueError):
                    if not lease_lost.is_set():
                        self.service.fail_delivery(lease)
                else:
                    if not lease_lost.is_set():
                        self.service.finish_delivery(lease, package)
            except DomainError as failure:
                if failure.code != "stale_delivery":
                    raise
        finally:
            done.set()
            renewal.join()

    def _maintain_previews(self, *, shutdown=False):
        changed = 0
        runtime = self.service.preview_runtime
        for target in self.service.preview_probe_targets(self.owner, shutdown=shutdown):
            if shutdown or target.status == "uncertain":
                result = runtime.confirmed_stop(target.id, self.owner)
                if result is None:
                    if not runtime.owns(target.id, self.owner) and not shutdown:
                        continue
                    result = runtime.stop(target.id, self.owner)
            else:
                result = runtime.probe(target.id, self.owner)
                if result.status == "ready" and (
                    result.origin != target.origin
                    or (result.backend_pid, result.bridge_pid)
                    != (target.backend_pid, target.bridge_pid)
                ):
                    stopped = runtime.stop(target.id, self.owner)
                    result = RuntimeResult(
                        "failed" if stopped.status == "stopped" else "uncertain",
                        error_code="preview_ownership_changed",
                        error_message="Процессы preview не совпадают с закреплённой сессией.",
                    )
            changed += self.service.record_preview_probe(target, result)
        return changed

    def close(self):
        try:
            self._maintain_previews(shutdown=True)
        finally:
            self.service.disconnect(self.owner)

    def _publish(self, lease):
        done = threading.Event()
        lease_lost = threading.Event()

        def renew():
            while not done.wait(self.service.lease_seconds / 3):
                try:
                    self.service.heartbeat_publication(lease)
                except DomainError:
                    lease_lost.set()
                    return

        renewal = threading.Thread(target=renew, daemon=True)
        renewal.start()
        try:
            try:
                destination = self.service.materializer(
                    self.service.workspace_root,
                    lease.candidate,
                    lease.contents,
                    lease.manifest_content,
                )
                if lease_lost.is_set():
                    self.service.recover()
                else:
                    self.service.finish_publication(lease, destination)
            except (InvalidFile, OSError) as failure:
                self.service.fail_publication(lease, failure)
        finally:
            done.set()
            renewal.join()


class WorkerPool:
    def __init__(self, service, *, owner, provider=None, slots=2):
        if not 1 <= slots <= 2:
            raise ValueError("A worker pool supports one or two independent slots")
        self.workers = [
            Worker(service, owner=f"{owner}-{index + 1}", provider=provider)
            for index in range(slots)
        ]
        self.executor = ThreadPoolExecutor(max_workers=slots, thread_name_prefix="codehead-worker")

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()

    def run_once(self):
        futures = [self.executor.submit(worker.run_once) for worker in self.workers]
        outcomes = [future.result() for future in futures]
        return any(outcomes)

    def run(self, stopped, *, poll_seconds):
        def consume(worker):
            try:
                while not stopped.is_set():
                    worker.run_once(maintain_previews=False)
                    stopped.wait(poll_seconds)
            finally:
                stopped.set()

        def maintain_previews():
            interval = min(poll_seconds, PREVIEW_HEALTH_SECONDS / 3)
            try:
                while not stopped.is_set():
                    for worker in self.workers:
                        if stopped.is_set():
                            return
                        worker._maintain_previews()
                    stopped.wait(interval)
            finally:
                stopped.set()

        with ThreadPoolExecutor(max_workers=1, thread_name_prefix="codehead-preview") as monitor:
            maintenance = monitor.submit(maintain_previews)
            futures = [self.executor.submit(consume, worker) for worker in self.workers]
            try:
                for future in futures:
                    future.result()
            finally:
                stopped.set()
            maintenance.result()

    def close(self):
        self.executor.shutdown(wait=True, cancel_futures=False)
        try:
            for worker in self.workers:
                worker.close()
        finally:
            self.workers[0].service.preview_runtime.close()
