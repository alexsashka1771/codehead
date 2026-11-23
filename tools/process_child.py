"""Wait for job assignment before creating the requested child process."""

import subprocess
import sys


def main():
    # EOF means the supervisor exited before authorizing the launch.
    if sys.stdin.buffer.readline() != b"start\n":
        return 1
    sys.stdin.close()
    return subprocess.run(
        sys.argv[1:],
        stdin=subprocess.DEVNULL,
        creationflags=subprocess.CREATE_NO_WINDOW,
        check=False,
        shell=False,
        close_fds=True,
    ).returncode


if __name__ == "__main__":
    raise SystemExit(main())
