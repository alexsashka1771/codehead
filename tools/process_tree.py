"""Own local Windows process trees with a kernel Job Object."""

import ctypes
import os
import subprocess
import sys
import time
from ctypes import wintypes
from pathlib import Path

JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000
JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION = 1
JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9
PROCESS_TERMINATE = 0x0001
PROCESS_SET_QUOTA = 0x0100


class BasicLimitInformation(ctypes.Structure):
    _fields_ = [
        ("PerProcessUserTimeLimit", ctypes.c_longlong),
        ("PerJobUserTimeLimit", ctypes.c_longlong),
        ("LimitFlags", wintypes.DWORD),
        ("MinimumWorkingSetSize", ctypes.c_size_t),
        ("MaximumWorkingSetSize", ctypes.c_size_t),
        ("ActiveProcessLimit", wintypes.DWORD),
        ("Affinity", ctypes.c_size_t),
        ("PriorityClass", wintypes.DWORD),
        ("SchedulingClass", wintypes.DWORD),
    ]


class IoCounters(ctypes.Structure):
    _fields_ = [
        (name, ctypes.c_ulonglong)
        for name in (
            "ReadOperationCount",
            "WriteOperationCount",
            "OtherOperationCount",
            "ReadTransferCount",
            "WriteTransferCount",
            "OtherTransferCount",
        )
    ]


class ExtendedLimitInformation(ctypes.Structure):
    _fields_ = [
        ("BasicLimitInformation", BasicLimitInformation),
        ("IoInfo", IoCounters),
        ("ProcessMemoryLimit", ctypes.c_size_t),
        ("JobMemoryLimit", ctypes.c_size_t),
        ("PeakProcessMemoryUsed", ctypes.c_size_t),
        ("PeakJobMemoryUsed", ctypes.c_size_t),
    ]


class BasicAccountingInformation(ctypes.Structure):
    _fields_ = [
        ("TotalUserTime", ctypes.c_longlong),
        ("TotalKernelTime", ctypes.c_longlong),
        ("ThisPeriodTotalUserTime", ctypes.c_longlong),
        ("ThisPeriodTotalKernelTime", ctypes.c_longlong),
        ("TotalPageFaultCount", wintypes.DWORD),
        ("TotalProcesses", wintypes.DWORD),
        ("ActiveProcesses", wintypes.DWORD),
        ("TotalTerminatedProcesses", wintypes.DWORD),
    ]


def checked_handle(result):
    if not result:
        raise ctypes.WinError(ctypes.get_last_error())
    return result


class WindowsJob:
    def __init__(self):
        self.api = ctypes.WinDLL("kernel32", use_last_error=True)
        self.api.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
        self.api.CreateJobObjectW.restype = wintypes.HANDLE
        self.api.SetInformationJobObject.argtypes = [
            wintypes.HANDLE,
            ctypes.c_int,
            ctypes.c_void_p,
            wintypes.DWORD,
        ]
        self.api.SetInformationJobObject.restype = wintypes.BOOL
        self.api.QueryInformationJobObject.argtypes = [
            wintypes.HANDLE,
            ctypes.c_int,
            ctypes.c_void_p,
            wintypes.DWORD,
            ctypes.POINTER(wintypes.DWORD),
        ]
        self.api.QueryInformationJobObject.restype = wintypes.BOOL
        self.api.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        self.api.OpenProcess.restype = wintypes.HANDLE
        self.api.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
        self.api.AssignProcessToJobObject.restype = wintypes.BOOL
        self.api.TerminateJobObject.argtypes = [wintypes.HANDLE, wintypes.UINT]
        self.api.TerminateJobObject.restype = wintypes.BOOL
        self.api.CloseHandle.argtypes = [wintypes.HANDLE]
        self.api.CloseHandle.restype = wintypes.BOOL
        # An unnamed, non-inheritable handle belongs only to this supervisor.
        self.handle = checked_handle(self.api.CreateJobObjectW(None, None))
        limits = ExtendedLimitInformation()
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        try:
            checked_handle(
                self.api.SetInformationJobObject(
                    self.handle,
                    JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
                    ctypes.byref(limits),
                    ctypes.sizeof(limits),
                )
            )
        except BaseException:
            self.api.CloseHandle(self.handle)
            self.handle = None
            raise

    def assign(self, pid):
        process_handle = checked_handle(
            self.api.OpenProcess(
                PROCESS_SET_QUOTA | PROCESS_TERMINATE,
                False,
                pid,
            )
        )
        try:
            checked_handle(self.api.AssignProcessToJobObject(self.handle, process_handle))
        finally:
            checked_handle(self.api.CloseHandle(process_handle))

    def close(self):
        if self.handle is None:
            return
        try:
            checked_handle(self.api.TerminateJobObject(self.handle, 1))
            deadline = time.monotonic() + 10
            accounting = BasicAccountingInformation()
            while True:
                checked_handle(
                    self.api.QueryInformationJobObject(
                        self.handle,
                        JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION,
                        ctypes.byref(accounting),
                        ctypes.sizeof(accounting),
                        None,
                    )
                )
                if accounting.ActiveProcesses == 0:
                    break
                if time.monotonic() >= deadline:
                    raise RuntimeError("Timed out stopping a CodeHead process tree.")
                time.sleep(0.01)
        finally:
            # Also kills the tree if normal termination or accounting failed.
            checked_handle(self.api.CloseHandle(self.handle))
            self.handle = None


class ProcessTree:
    def __init__(self, command, *, cwd, env, stdout=None, stderr=None):
        self._process = None
        self._job = None
        try:
            if os.name == "nt":
                self._job = WindowsJob()
                # A venv python.exe redirects through another process before running Python code.
                # Use the base interpreter without site hooks so the barrier cannot spawn early.
                python = Path(sys.base_prefix) / "python.exe"
                wrapper = Path(__file__).with_name("process_child.py")
                self._process = subprocess.Popen(
                    [str(python), "-I", "-S", "-X", "utf8", str(wrapper), *command],
                    cwd=cwd,
                    env=env,
                    stdin=subprocess.PIPE,
                    stdout=stdout,
                    stderr=stderr,
                    bufsize=0,
                    creationflags=subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP,
                    shell=False,
                    close_fds=True,
                )
                self._job.assign(self._process.pid)
                self._process.stdin.write(b"start\n")
                self._process.stdin.close()
            else:
                self._process = subprocess.Popen(
                    command, cwd=cwd, env=env, shell=False, stdout=stdout, stderr=stderr
                )
        except BaseException:
            self.stop()
            raise

    @property
    def pid(self):
        return self._process.pid

    @property
    def stdout(self):
        return self._process.stdout

    @property
    def stderr(self):
        return self._process.stderr

    def poll(self):
        return self._process.poll()

    def wait(self, timeout=None):
        return self._process.wait(timeout=timeout)

    def stop(self):
        try:
            # The job still owns descendants after the direct process has exited.
            if self._job is not None:
                self._job.close()
        finally:
            if self._process is not None:
                if self._process.stdin is not None:
                    self._process.stdin.close()
                if self._process.poll() is None:
                    self._process.terminate()
                try:
                    self._process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    self._process.kill()
                    self._process.wait(timeout=5)
