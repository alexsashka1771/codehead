"""Run state transitions."""


def transition_run(current: str, command: str, *, has_running_tasks: bool = False) -> str:
    if command == "pause" and current in {"created", "running"}:
        return "pausing" if has_running_tasks else "paused"
    if command == "resume" and current == "paused":
        return "created"
    if command == "cancel" and current in {"created", "running", "pausing", "paused", "blocked"}:
        return "cancelled"
    raise ValueError(f"Invalid run transition: {current} -> {command}")
