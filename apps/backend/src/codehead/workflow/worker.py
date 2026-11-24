"""Provider execution and lease renewal outside HTTP handlers."""

import threading
from concurrent.futures import ThreadPoolExecutor

from codehead.clinic.files import InvalidFile
from codehead.errors import DomainError
from codehead.llm.provider import ProviderFailure


class Worker:
    def __init__(self, service, *, owner, provider=None):
        self.service = service
        self.owner = owner
        self.provider = provider

    def run_once(self):
        self.service.register(self.owner)
        recovered = self.service.recover()
        accepted = self.service.accept_decisions()
        publication = self.service.claim_publication(self.owner)
        if publication is not None:
            self._publish(publication)
            return True
        lease = self.service.claim(self.owner, self.provider)
        if lease is None:
            return bool(recovered or accepted)
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
                result = lease.provider.run(lease.request)
                if lease_lost.is_set():
                    self.service.recover()
                else:
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
                    worker.run_once()
                    stopped.wait(poll_seconds)
            finally:
                stopped.set()

        futures = [self.executor.submit(consume, worker) for worker in self.workers]
        try:
            for future in futures:
                future.result()
        finally:
            stopped.set()

    def close(self):
        self.executor.shutdown(wait=True, cancel_futures=False)
        for worker in self.workers:
            worker.service.disconnect(worker.owner)
