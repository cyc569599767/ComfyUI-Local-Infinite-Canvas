"""Run the desktop-owned ComfyUI entry without consoles for ordinary children.

Usage: python desktop-comfy-bootstrap.py ABSOLUTE_MAIN_PY [COMFY_ARGUMENTS...]
The subprocess policy is process-local; the ComfyUI installation is not changed.
"""

import inspect
import os
import runpy
import subprocess
import sys


def install_windows_subprocess_policy():
    """Keep Popen a class and add CREATE_NO_WINDOW only on Windows.

    Explicit requests for a new console or a detached process take precedence.
    Binding the original signature handles keyword and positional creationflags
    without changing stdio, shell, cwd, env, or other caller-provided options.
    subprocess.run/check_output and subsequently imported Popen aliases use the
    same class; no process-wide environment variables or on-disk hooks are set.
    """
    if sys.platform != "win32":
        return False

    original_popen = subprocess.Popen
    if getattr(original_popen, "_canvas_windows_no_window", False):
        return True

    signature = inspect.signature(original_popen)
    no_window = subprocess.CREATE_NO_WINDOW
    explicit_console_mode = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_CONSOLE
    default_flags = signature.parameters["creationflags"].default

    class WindowlessPopen(original_popen):
        _canvas_windows_no_window = True

        def __init__(self, *args, **kwargs):
            bound = signature.bind(*args, **kwargs)
            flags = bound.arguments.get("creationflags", default_flags)
            if not flags & explicit_console_mode:
                bound.arguments["creationflags"] = flags | no_window
            super().__init__(*bound.args, **bound.kwargs)

    subprocess.Popen = WindowlessPopen
    return True


class _GuardedBuffer:
    """Forward to the real buffer but swallow writes/flushes to a dead pipe."""

    def __init__(self, inner):
        self._canvas_inner = inner

    def __getattr__(self, name):
        return getattr(self._canvas_inner, name)

    def write(self, data):
        try:
            return self._canvas_inner.write(data)
        except (OSError, ValueError):
            try:
                return len(data)
            except TypeError:
                return 0

    def flush(self):
        try:
            return self._canvas_inner.flush()
        except (OSError, ValueError):
            return None


class _GuardedTextStream:
    """Text facade whose buffer is hardened for ComfyUI's LogInterceptor."""

    _canvas_stdio_guard = True

    def __init__(self, inner, buffer):
        self._canvas_inner = inner
        self._canvas_buffer = buffer

    @property
    def buffer(self):
        return self._canvas_buffer

    @property
    def encoding(self):
        return getattr(self._canvas_inner, "encoding", "utf-8")

    @property
    def line_buffering(self):
        return bool(getattr(self._canvas_inner, "line_buffering", False))

    def write(self, data):
        try:
            return self._canvas_inner.write(data)
        except (OSError, ValueError):
            try:
                return len(data)
            except TypeError:
                return 0

    def flush(self):
        try:
            return self._canvas_inner.flush()
        except (OSError, ValueError):
            return None

    def isatty(self):
        try:
            return bool(self._canvas_inner.isatty())
        except (OSError, ValueError):
            return False

    def __getattr__(self, name):
        return getattr(self._canvas_inner, name)


def install_stdio_guard():
    """Keep stdout/stderr writes from raising when the console pipe is gone.

    A desktop-launched ComfyUI inherits stdio pipes whose reader (the launcher)
    can exit or be torn down. tqdm -- used by the MiniMax Music3 AR sampler --
    calls flush() on every progress update, so a dead pipe aborts generation
    with "OSError: [Errno 22] Invalid argument" before any audio is produced.

    Patching flush() on sys.stderr is not enough: ComfyUI's app/logger.py
    rebinds sys.stderr to a LogInterceptor(io.TextIOWrapper) that wraps
    stream.buffer and calls io.TextIOWrapper.flush() itself, never the wrapped
    stream's own flush. The reliable chokepoint is therefore the buffer object,
    exposed through a proxy that delegates everything else. Only writes and
    flushes are guarded; live output still reaches the pipe unchanged and the
    original encoding is preserved.
    """
    for name in ("stdout", "stderr"):
        stream = getattr(sys, name, None)
        if stream is None or getattr(stream, "_canvas_stdio_guard", False):
            continue
        buffer = getattr(stream, "buffer", None)
        if buffer is None:
            continue
        setattr(sys, name, _GuardedTextStream(stream, _GuardedBuffer(buffer)))


def main(arguments=None):
    arguments = list(sys.argv[1:] if arguments is None else arguments)
    if not arguments or not os.path.isabs(arguments[0]):
        raise SystemExit(
            "Usage: desktop-comfy-bootstrap.py ABSOLUTE_MAIN_PY [COMFY_ARGUMENTS...]"
        )

    main_path = arguments[0]
    install_windows_subprocess_policy()
    install_stdio_guard()
    sys.argv = arguments
    main_directory = os.path.dirname(main_path)
    bootstrap_directory = os.path.dirname(os.path.abspath(__file__))
    # Embedded Python's ._pth may start with its standard-library zip rather
    # than this script directory. Never replace that required search entry.
    if sys.path and os.path.normcase(os.path.abspath(sys.path[0])) == os.path.normcase(bootstrap_directory):
        sys.path[0] = main_directory
    else:
        sys.path.insert(0, main_directory)
    runpy.run_path(main_path, run_name="__main__")


if __name__ == "__main__":
    main()
