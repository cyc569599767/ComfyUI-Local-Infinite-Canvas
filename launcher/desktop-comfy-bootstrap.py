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


def install_windows_file_response_policy():
    """Use aiohttp's supported chunked file sender in this owned process.

    On some Windows event-loop/driver combinations FileResponse sends correct
    200/206 headers but loop.sendfile never delivers the body. HEAD still works,
    which makes video players wait forever. The documented fallback preserves
    Content-Length, byte ranges and MIME; it does not transcode or buffer a whole
    video. Set this before main.py imports aiohttp, without editing ComfyUI or
    site-packages, and never change another already-running service.
    """
    if sys.platform != "win32":
        return False
    os.environ["AIOHTTP_NOSENDFILE"] = "1"
    return True


def main(arguments=None):
    arguments = list(sys.argv[1:] if arguments is None else arguments)
    if not arguments or not os.path.isabs(arguments[0]):
        raise SystemExit(
            "Usage: desktop-comfy-bootstrap.py ABSOLUTE_MAIN_PY [COMFY_ARGUMENTS...]"
        )

    main_path = arguments[0]
    install_windows_subprocess_policy()
    install_windows_file_response_policy()
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
