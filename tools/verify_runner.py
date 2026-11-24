"""Exercise three real checks through persisted worker ToolRuns in an isolated test schema."""

import argparse
import os
from pathlib import Path

from sqlalchemy.engine import make_url
from verify_clinic_candidate import _prepare, _save

from codehead.contracts import ToolCommand
from codehead.persistence.database import Database
from codehead.runner.execution import RestrictedProcessRunner
from codehead.workflow.worker import Worker
from codehead.workflow.worker_service import WorkerService


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--schema", required=True)
    parser.add_argument("--report-root", type=Path, required=True)
    args = parser.parse_args()
    url = os.environ["CODEHEAD_TEST_DATABASE_URL"]
    if not (make_url(url).database or "").endswith("_test"):
        raise SystemExit("Only an explicit isolated test database is allowed.")
    report = args.report_root.absolute()
    report.mkdir(parents=True, exist_ok=True)
    database = Database(url, schema=args.schema)
    service = WorkerService(
        database,
        workspace_root=report / "candidates",
        tool_runner=RestrictedProcessRunner(workspace_root=report / "tools"),
    )
    worker = Worker(service, owner="runner-check")
    try:
        candidate, *_ = _prepare(service, report)
        before = service.snapshot(candidate.run_id)
        results = []
        for operation in ("validate_backend", "test_backend", "build_frontend"):
            print(f"Queueing {operation} for candidate v{candidate.revision}...", flush=True)
            command = ToolCommand(
                operation_id=operation,
                workspace_id=candidate.id,
                snapshot_version=candidate.revision,
            )
            tool = service.queue_tool(
                candidate.run_id, command, f"runner-{operation}", "runner-check"
            )
            if not worker.run_once():
                raise RuntimeError("The worker did not claim the queued check.")
            current = next(
                item for item in service.tool_runs(candidate.run_id) if item.id == tool.id
            )
            _save(report / f"{operation}.json", current.model_dump(mode="json"))
            print(current.stdout, end="" if current.stdout.endswith("\n") else "\n", flush=True)
            if current.stderr:
                print(current.stderr, flush=True)
            if current.status != "succeeded" or current.exit_code != 0:
                raise RuntimeError(f"{operation}: {current.status}/{current.error_code}")
            if (
                service.queue_tool(candidate.run_id, command, f"runner-{operation}", "runner-check")
                != tool
            ):
                raise RuntimeError("Command receipt did not preserve the original ToolRun.")
            results.append(current.model_dump(mode="json"))
        after = service.snapshot(candidate.run_id)
        if (
            before.candidate != after.candidate
            or before.agent_runs != after.agent_runs
            or before.usage != after.usage
        ):
            raise RuntimeError("A check modified candidate or LLM evidence.")
        _save(report / "snapshot.json", after.model_dump(mode="json"))
        events, cursor = [], 0
        while True:
            page = service.events(candidate.run_id, after_seq=cursor, limit=200)
            events.extend(event.model_dump(mode="json") for event in page.events)
            if not page.has_more:
                break
            cursor = page.next_after_seq
        _save(report / "events.json", events)
        _save(
            report / "summary.json",
            {
                "status": "passed",
                "run_id": candidate.run_id,
                "candidate_id": candidate.id,
                "revision": candidate.revision,
                "isolation_level": "process_only",
                "llm_calls": after.usage.request_count,
                "operations": [
                    {
                        "id": result["id"],
                        "operation_id": result["operation_id"],
                        "exit_code": result["exit_code"],
                    }
                    for result in results
                ],
                "qa": "unavailable",
                "preview": "unavailable",
                "live": "unavailable",
            },
        )
        print(
            "Runner verified: 3 real ToolRuns; compile/HTTP/build passed; LLM evidence unchanged.",
            flush=True,
        )
        return 0
    finally:
        service.disconnect(worker.owner)
        database.close()


if __name__ == "__main__":
    raise SystemExit(main())
