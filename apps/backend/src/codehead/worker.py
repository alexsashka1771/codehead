"""Run the supervised test worker as a separate process, never inside HTTP."""

import signal
import threading
from uuid import uuid4

from codehead.persistence.database import Database
from codehead.settings import Settings
from codehead.workflow.worker import WorkerPool
from codehead.workflow.worker_service import WorkerService


def main():
    settings = Settings()
    if not settings.database_configured:
        raise SystemExit("CODEHEAD_DATABASE_URL is required; use npm run dev.")
    database = Database(settings.database_url.get_secret_value(), schema=settings.test_schema)
    owner = "worker-" + uuid4().hex
    service = WorkerService(
        database,
        lease_seconds=settings.worker_lease_seconds,
        step_delay=settings.test_step_delay_seconds,
        secrets=(settings.command_token.get_secret_value(),),
    )
    stopped = threading.Event()
    signal.signal(signal.SIGINT, lambda *_: stopped.set())
    signal.signal(signal.SIGTERM, lambda *_: stopped.set())
    try:
        print("CodeHead worker connected: two test-provider slots; live unavailable.", flush=True)
        with WorkerPool(service, owner=owner) as pool:
            pool.run(stopped, poll_seconds=settings.worker_poll_seconds)
    finally:
        database.close()


if __name__ == "__main__":
    main()
