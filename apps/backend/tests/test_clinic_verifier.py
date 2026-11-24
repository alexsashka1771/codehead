import importlib.util
import socket
from pathlib import Path

import pytest


def verifier():
    path = Path(__file__).resolve().parents[3] / "tools/verify_clinic_candidate.py"
    spec = importlib.util.spec_from_file_location("clinic_verifier_test", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_closed_listener_in_time_wait_is_not_reported_as_running(monkeypatch):
    module = verifier()
    assert hasattr(module, "_assert_listener_stopped")
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
        listener.listen()
        with socket.create_connection(("127.0.0.1", port)) as client:
            connection, _ = listener.accept()
            connection.close()
            assert client.recv(1) == b""

    def time_wait_bind(*_):
        raise OSError(10048, "The closed server port remains in TIME_WAIT.")

    monkeypatch.setattr(socket.socket, "bind", time_wait_bind)
    module._assert_listener_stopped(port)


def test_active_listener_is_reported_as_still_running():
    module = verifier()
    assert hasattr(module, "_assert_listener_stopped")
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        listener.listen()
        with pytest.raises(RuntimeError, match="still accepting"):
            module._assert_listener_stopped(listener.getsockname()[1])
