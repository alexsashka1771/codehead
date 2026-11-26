"""Bind the Clinic socket before importing its pinned workstation entry point."""

import argparse
import os
import runpy
import socket
import sys
from pathlib import Path

import uvicorn

from codehead.delivery.bridge import LOOPBACK, announce_port


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("workspace", type=Path)
    parser.add_argument("port_file", type=Path)
    args = parser.parse_args()
    backend = args.workspace / "backend"
    with socket.socket() as listener:
        if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            listener.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        listener.bind((LOOPBACK, 0))
        port = listener.getsockname()[1]
        os.environ["CLINIC_PORT"] = str(port)
        sys.path.insert(0, str(backend))
        application = runpy.run_path(str(backend / "main.py"))["app"]
        announce_port(args.port_file, port)
        server = uvicorn.Server(
            uvicorn.Config(
                application,
                host=LOOPBACK,
                port=port,
                access_log=False,
                log_level="warning",
                proxy_headers=False,
                ws="none",
                limit_concurrency=32,
            )
        )
        server.run(sockets=[listener])


if __name__ == "__main__":
    main()
