#!/usr/bin/env python3
"""Trusted local-process worker for the non-hardened development backend."""

from __future__ import annotations

import ast
import builtins
import contextlib
import ctypes
import io
import json
import os
from pathlib import Path
import signal
import socket
import sys
import sysconfig
import threading
import time
import traceback
from typing import Any


PROJECT_ROOT = Path(os.environ["RLM_PROJECT_ROOT"]).resolve()
ARTIFACT_ROOT = Path(os.environ["RLM_ARTIFACT_ROOT"]).resolve()
CONTROL_SOCKET = Path(os.environ["RLM_CONTROL_SOCKET"])
SESSION_ID = os.environ["RLM_SESSION_ID"]
LANE_ID = os.environ["RLM_LANE_ID"]
MAX_PROTOCOL_LINE = 2_500_000
RUNTIME_READ_ROOTS = (
    Path(__file__).resolve().parent,
    *tuple(
        Path(path).resolve()
        for path in {
            value
            for key, value in sysconfig.get_paths().items()
            if key in {"stdlib", "platstdlib", "purelib", "platlib"} and value
        }
    ),
)


def _set_parent_death_signal() -> None:
    if sys.platform != "linux":
        return
    libc = ctypes.CDLL(None)
    if libc.prctl(1, signal.SIGTERM) != 0:  # PR_SET_PDEATHSIG
        raise RuntimeError("failed to set parent-death signal")
    if os.getppid() == 1:
        raise RuntimeError("control plane exited before worker initialization")


_set_parent_death_signal()


def _watch_parent(parent_pid: int) -> None:
    while True:
        time.sleep(0.1)
        if os.getppid() != parent_pid:
            os._exit(0)


def _serve_control(listener: socket.socket) -> None:
    while True:
        connection, _address = listener.accept()
        with connection:
            connection.settimeout(1.0)
            wire = connection.recv(4096)
            try:
                request = json.loads(wire)
            except (json.JSONDecodeError, UnicodeDecodeError):
                connection.sendall(b'{"ok":false}\n')
                continue
            matches = (
                request.get("operation") == "stop"
                and request.get("session_id") == SESSION_ID
                and request.get("lane_id") == LANE_ID
            )
            if not matches:
                connection.sendall(b'{"ok":false}\n')
                continue
            connection.sendall(
                json.dumps(
                    {
                        "ok": True,
                        "session_id": SESSION_ID,
                        "lane_id": LANE_ID,
                    },
                    separators=(",", ":"),
                ).encode("utf-8")
                + b"\n"
            )
            connection.shutdown(socket.SHUT_WR)
            os._exit(0)


def _start_lifecycle_controls() -> None:
    if CONTROL_SOCKET.exists():
        CONTROL_SOCKET.unlink()
    listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    listener.bind(str(CONTROL_SOCKET))
    os.chmod(CONTROL_SOCKET, 0o600)
    listener.listen(1)
    threading.Thread(
        target=_serve_control,
        args=(listener,),
        name="rlm-control",
        daemon=True,
    ).start()
    threading.Thread(
        target=_watch_parent,
        args=(os.getppid(),),
        name="rlm-parent-watchdog",
        daemon=True,
    ).start()


_start_lifecycle_controls()


def _is_within(root: Path, candidate: Path) -> bool:
    try:
        candidate.relative_to(root)
        return True
    except ValueError:
        return False


def _resolved_path(raw_path: object) -> Path | None:
    if isinstance(raw_path, int):
        return None
    try:
        candidate = Path(os.fsdecode(raw_path))
    except TypeError:
        raise PermissionError("unsupported filesystem path")
    if not candidate.is_absolute():
        candidate = Path.cwd() / candidate
    return candidate.resolve(strict=False)


def _write_target_allowed(raw_path: object) -> bool:
    candidate = _resolved_path(raw_path)
    return candidate is None or _is_within(ARTIFACT_ROOT, candidate)


def _read_target_allowed(raw_path: object) -> bool:
    candidate = _resolved_path(raw_path)
    if candidate is None:
        return True
    return any(
        _is_within(root, candidate)
        for root in (PROJECT_ROOT, ARTIFACT_ROOT, *RUNTIME_READ_ROOTS)
    )


def _audit(event: str, args: tuple[object, ...]) -> None:
    if event in {
        "subprocess.Popen",
        "os.system",
        "os.posix_spawn",
        "socket.connect",
        "socket.bind",
        "socket.getaddrinfo",
        "ctypes.dlopen",
        "ctypes.dlsym",
    }:
        raise PermissionError(f"{event} is disabled by the local RLM backend")
    if event == "open" and len(args) >= 2:
        mode = args[1]
        flags = args[2] if len(args) >= 3 else 0
        writing = (
            isinstance(mode, str) and any(flag in mode for flag in "wax+")
        ) or (
            isinstance(flags, int)
            and flags
            & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND)
        )
        if writing and not _write_target_allowed(args[0]):
            raise PermissionError("writes are restricted to the lane artifact root")
        if not writing and not _read_target_allowed(args[0]):
            raise PermissionError(
                "reads are restricted to the project, lane artifacts, and Python runtime"
            )
    mutation_targets: dict[str, tuple[int, ...]] = {
        "os.remove": (0,),
        "os.rmdir": (0,),
        "os.mkdir": (0,),
        "os.chmod": (0,),
        "os.chown": (0,),
        "os.truncate": (0,),
        "os.utime": (0,),
        "os.setxattr": (0,),
        "os.removexattr": (0,),
        "os.rename": (0, 1),
        "os.link": (0, 1),
        "os.symlink": (1,),
    }
    indexes = mutation_targets.get(event)
    if indexes is not None and any(
        index >= len(args) or not _write_target_allowed(args[index])
        for index in indexes
    ):
        raise PermissionError(
            "filesystem mutation is restricted to the lane artifact root"
        )


sys.addaudithook(_audit)
os.chdir(ARTIFACT_ROOT)

GLOBALS: dict[str, Any] = {
    "__name__": "__rlm_lane__",
    "__builtins__": builtins,
    "PROJECT_ROOT": PROJECT_ROOT,
    "ARTIFACT_ROOT": ARTIFACT_ROOT,
    "Path": Path,
}


def _bounded(value: str, limit: int) -> tuple[str, bool]:
    encoded = value.encode("utf-8", errors="replace")
    if len(encoded) <= limit:
        return value, False
    marker = b"\n...[output truncated by Codex RLM]..."
    kept = encoded[: max(0, limit - len(marker))]
    return (kept + marker).decode("utf-8", errors="replace"), True


def _execute(code: str, output_limit: int) -> dict[str, object]:
    stdout_buffer = io.StringIO()
    stderr_buffer = io.StringIO()
    result: object | None = None
    status = "succeeded"
    error_name: str | None = None
    error_message: str | None = None

    try:
        module = ast.parse(code, mode="exec")
        body = module.body
        with contextlib.redirect_stdout(stdout_buffer), contextlib.redirect_stderr(
            stderr_buffer
        ):
            if body and isinstance(body[-1], ast.Expr):
                prefix = ast.Module(body=body[:-1], type_ignores=[])
                if prefix.body:
                    exec(compile(prefix, "<rlm-cell>", "exec"), GLOBALS, GLOBALS)
                expression = ast.Expression(body[-1].value)
                result = eval(
                    compile(expression, "<rlm-cell>", "eval"), GLOBALS, GLOBALS
                )
            else:
                exec(compile(module, "<rlm-cell>", "exec"), GLOBALS, GLOBALS)
    except BaseException as error:  # preserve every failed model-authored cell
        status = "failed"
        error_name = type(error).__name__
        error_message = str(error)
        traceback.print_exc(file=stderr_buffer)

    stdout, stdout_truncated = _bounded(stdout_buffer.getvalue(), output_limit)
    stderr, stderr_truncated = _bounded(stderr_buffer.getvalue(), output_limit)
    result_text: str | None = None
    result_truncated = False
    if result is not None:
        result_text, result_truncated = _bounded(repr(result), output_limit)

    return {
        "status": status,
        "stdout": stdout,
        "stderr": stderr,
        "result": result_text,
        "error_name": error_name,
        "error_message": error_message,
        "truncated": stdout_truncated or stderr_truncated or result_truncated,
    }


def main() -> None:
    sys.stdout.write('{"type":"ready"}\n')
    sys.stdout.flush()
    for raw_line in sys.stdin.buffer:
        if len(raw_line) > MAX_PROTOCOL_LINE:
            raise RuntimeError("worker protocol line exceeds bound")
        request = json.loads(raw_line)
        request_id = request["id"]
        response = _execute(
            str(request["code"]),
            min(max(int(request["output_limit"]), 1024), 1_000_000),
        )
        response["id"] = request_id
        wire = json.dumps(response, ensure_ascii=False, separators=(",", ":"))
        sys.stdout.write(wire + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
