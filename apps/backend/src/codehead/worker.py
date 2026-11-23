"""Run the supervised test worker as a separate process, never inside HTTP."""

import signal
import threading
from uuid import uuid4

from codehead.persistence.database import Database
from codehead.settings import Settings
from codehead.workflow.worker import Worker
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
    worker = Worker(service, owner=owner)
    stopped = threading.Event()
    signal.signal(signal.SIGINT, lambda *_: stopped.set())
    signal.signal(signal.SIGTERM, lambda *_: stopped.set())
    try:
        print("CodeHead worker connected: explicit test provider; live unavailable.", flush=True)
        while not stopped.is_set():
            worker.run_once()
            stopped.wait(settings.worker_poll_seconds)
    finally:
        service.disconnect(owner)
        database.close()


if __name__ == "__main__":
    main()
