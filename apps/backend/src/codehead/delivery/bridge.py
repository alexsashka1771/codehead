"""Serve the compiled Clinic UI and relay bounded JSON to its own backend."""

import argparse
import http.client
import json
import re
import socket
import threading
from contextlib import closing
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote

from codehead.clinic.files import InvalidFile, normalize_relative_path
from codehead.delivery.package import DIST, PackageCompiler, read_file

LOOPBACK = "127.0.0.1"
MAX_BODY = 65536
METHODS = {"GET", "HEAD", "POST", "PATCH"}
WRITE_METHODS = {"POST", "PATCH"}
FRAME_ORIGIN = re.compile(r"http://(?:127\.0\.0\.1|localhost):([1-9][0-9]{0,4})")
CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
    ".svg": "image/svg+xml",
    ".woff2": "font/woff2",
}


def frame_origins(values):
    for value in values:
        match = FRAME_ORIGIN.fullmatch(value)
        if not match or int(match[1]) > 65535:
            raise ValueError("The preview frame origin must be a loopback HTTP origin.")
    return tuple(dict.fromkeys(values))


class PreviewServer(ThreadingHTTPServer):
    allow_reuse_address = False
    request_queue_size = 16

    def __init__(self, package, backend_port, platform_origins):
        self.slots = threading.BoundedSemaphore(self.request_queue_size)
        self.backend_port = backend_port
        self.frame_origins = frame_origins(platform_origins)
        self.assets = {
            file.path.removeprefix(f"{DIST}/"): file
            for file in package.files
            if file.path.startswith(f"{DIST}/")
        }
        self.root = package.root
        super().__init__((LOOPBACK, 0), PreviewHandler)
        self.host = f"{LOOPBACK}:{self.server_port}"
        self.origin = f"http://{self.host}"

    def process_request(self, request, address):
        if not self.slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, address)
        except BaseException:
            self.slots.release()
            raise

    def server_bind(self):
        if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()

    def process_request_thread(self, request, address):
        try:
            super().process_request_thread(request, address)
        finally:
            self.slots.release()


class PreviewHandler(BaseHTTPRequestHandler):
    timeout = 5
    protocol_version = "HTTP/1.0"
    server_version = "CodeHeadPreview"
    sys_version = ""

    def log_message(self, *_):
        pass

    def version_string(self):
        return self.server_version

    def _respond(self, status, content=b"", content_type="application/json", *, preflight=False):
        origin = self.server.origin
        ancestors = " ".join(self.server.frame_origins) or "'none'"
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header(
            "Content-Security-Policy",
            f"default-src 'none'; script-src {origin}; style-src {origin}; img-src {origin}; "
            f"font-src {origin}; connect-src {origin}; base-uri 'none'; form-action {origin}; "
            f"frame-ancestors {ancestors}",
        )
        self.send_header("Vary", "Origin")
        if getattr(self, "headers", None):
            origins = self.headers.get_all("Origin")
            if origins in (["null"], [origin]):
                self.send_header("Access-Control-Allow-Origin", origins[0])
        if preflight:
            self.send_header("Access-Control-Allow-Methods", "GET, HEAD, POST, PATCH")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()
        if getattr(self, "command", None) != "HEAD" and content:
            self.wfile.write(content)

    def send_error(self, code, message=None, explain=None):
        errors = {
            400: "invalid_request",
            403: "request_forbidden",
            404: "preview_resource_not_found",
            405: "method_not_allowed",
            411: "length_required",
            413: "request_too_large",
            415: "unsupported_media_type",
            502: "clinic_unavailable",
            503: "preview_file_unavailable",
        }
        self._respond(
            code, json.dumps({"code": errors.get(code, "preview_request_failed")}).encode()
        )

    def _path(self):
        # Read the original request target; http.server normalizes two leading slashes.
        target = self.requestline.split()[1]
        if len(target) > 512 or not target.startswith("/"):
            raise InvalidFile("Invalid preview request path.")
        path = unquote(target, errors="strict")
        if path == "/":
            return path
        relative = path[1:]
        if normalize_relative_path(relative) != relative or "\\" in relative:
            raise InvalidFile("Invalid preview request path.")
        return path

    def _serve(self):
        origins = self.headers.get_all("Origin", [])
        if self.headers.get_all("Host") != [self.server.host] or origins not in (
            [],
            ["null"],
            [self.server.origin],
        ):
            self.send_error(403)
            return
        try:
            path = self._path()
        except (InvalidFile, UnicodeError):
            self.send_error(400)
            return
        if self.headers.get_all("Transfer-Encoding"):
            self.send_error(400)
            return
        lengths = self.headers.get_all("Content-Length", [])
        if lengths and (len(lengths) != 1 or not re.fullmatch(r"[0-9]{1,8}", lengths[0])):
            self.send_error(400)
            return
        size = int(lengths[0]) if lengths else 0
        if size > MAX_BODY:
            self.send_error(413)
            return
        endpoint = path == "/health" or path.startswith("/api/")
        if self.command == "OPTIONS":
            requested = self.headers.get("Access-Control-Request-Method")
            names = self.headers.get("Access-Control-Request-Headers", "")
            permitted = {item.strip().lower() for item in names.split(",")} <= {"", "content-type"}
            if not origins or requested not in METHODS or not permitted or size:
                self.send_error(403)
                return
            self._respond(204, preflight=True)
        elif self.command in WRITE_METHODS:
            if not path.startswith("/api/"):
                self.send_error(405)
            elif not lengths:
                self.send_error(411)
            elif (
                self.headers.get_content_type() != "application/json"
                or len(self.headers.get_all("Content-Type", [])) != 1
            ):
                self.send_error(415)
            else:
                body = self.rfile.read(size)
                if len(body) == size:
                    self._proxy(path, body)
                else:
                    self.send_error(400)
        elif size:
            self.send_error(400)
        elif endpoint:
            self._proxy(path, None)
        else:
            self._static(path)

    def _proxy(self, path, body):
        method = "GET" if self.command == "HEAD" else self.command
        try:
            with closing(
                http.client.HTTPConnection(LOOPBACK, self.server.backend_port, timeout=5)
            ) as client:
                headers = {"Accept": "application/json"}
                if body is not None:
                    headers["Content-Type"] = "application/json"
                client.request(method, path, body=body, headers=headers)
                response = client.getresponse()
                data = response.read(MAX_BODY + 1)
                if (
                    len(data) > MAX_BODY
                    or not (200 <= response.status < 300 or 400 <= response.status < 600)
                    or response.headers.get_content_type() != "application/json"
                ):
                    self.send_error(502)
                    return
                status = response.status
        except (OSError, http.client.HTTPException):
            self.send_error(502)
            return
        self._respond(status, data)

    def _static(self, path):
        name = "index.html" if path == "/" else path[1:]
        file = self.server.assets.get(name)
        if file is None:
            self.send_error(404)
            return
        try:
            content = read_file(self.server.root, file)
        except (InvalidFile, OSError):
            self.send_error(503)
            return
        self._respond(
            200, content, CONTENT_TYPES.get(Path(name).suffix, "application/octet-stream")
        )

    do_GET = do_HEAD = do_POST = do_PATCH = do_OPTIONS = _serve


def announce_port(path, port):
    with Path(path).open("x", encoding="ascii") as stream:
        stream.write(str(port))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("package_root", type=Path)
    parser.add_argument("package_id")
    parser.add_argument("generation", type=int)
    parser.add_argument("manifest_hash")
    parser.add_argument("archive_hash")
    parser.add_argument("archive_byte_size", type=int)
    parser.add_argument("backend_port", type=int)
    parser.add_argument("port_file", type=Path)
    parser.add_argument("frame_origins", nargs="*")
    args = parser.parse_args()
    package = PackageCompiler(package_root=args.package_root).load(
        args.package_id,
        args.generation,
        manifest_hash=args.manifest_hash,
        archive_hash=args.archive_hash,
        archive_byte_size=args.archive_byte_size,
    )
    with PreviewServer(package, args.backend_port, args.frame_origins) as server:
        announce_port(args.port_file, server.server_port)
        server.serve_forever()


if __name__ == "__main__":
    main()
