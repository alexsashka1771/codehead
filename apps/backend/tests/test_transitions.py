import pytest

from codehead.workflow.transitions import transition_run


@pytest.mark.parametrize(
    ("current", "command", "expected"),
    [
        ("created", "pause", "paused"),
        ("running", "pause", "paused"),
        ("paused", "resume", "created"),
        ("created", "cancel", "cancelled"),
        ("running", "cancel", "cancelled"),
        ("paused", "cancel", "cancelled"),
        ("blocked", "cancel", "cancelled"),
    ],
)
def test_valid_run_commands(current, command, expected):
    assert transition_run(current, command) == expected


def test_pause_waits_for_in_flight_tasks():
    assert transition_run("running", "pause", has_running_tasks=True) == "pausing"


@pytest.mark.parametrize("state", ["succeeded", "failed", "cancelled"])
@pytest.mark.parametrize("command", ["pause", "resume", "cancel"])
def test_terminal_run_cannot_be_reopened(state, command):
    with pytest.raises(ValueError, match="transition"):
        transition_run(state, command)


@pytest.mark.parametrize("state,command", [("created", "resume"), ("paused", "pause")])
def test_invalid_commands_are_rejected(state, command):
    with pytest.raises(ValueError, match="transition"):
        transition_run(state, command)
