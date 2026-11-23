"""Provider execution and lease renewal outside HTTP handlers."""

import threading

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
