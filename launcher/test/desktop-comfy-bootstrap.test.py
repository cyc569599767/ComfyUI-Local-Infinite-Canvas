"""Standard-library tests; run directly with python -B <this file>."""

import contextlib
import importlib.util
import inspect
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock


BOOTSTRAP = Path(__file__).resolve().parents[1] / "desktop-comfy-bootstrap.py"
SPEC = importlib.util.spec_from_file_location("desktop_comfy_bootstrap", BOOTSTRAP)
bootstrap = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bootstrap)

NO_WINDOW = 0x08000000
NEW_CONSOLE = 0x00000010
DETACHED = 0x00000008
NEW_PROCESS_GROUP = 0x00000200


class FakePopen:
    calls = []
    next_error = None

    def __init__(self, args, bufsize=-1, executable=None, stdin=None, stdout=None,
                 stderr=None, preexec_fn=None, close_fds=True, shell=False,
                 cwd=None, env=None, universal_newlines=None, startupinfo=None,
                 creationflags=0, restore_signals=True, start_new_session=False,
                 pass_fds=(), *, text=None, encoding=None, errors=None):
        type(self).calls.append(dict(locals()))
        if type(self).next_error is not None:
            raise type(self).next_error
        self.args = args
        self.returncode = 0
        self.stdout = stdout
        self.stderr = stderr
        self.text_mode = bool(text or universal_newlines or encoding)
        self.entered = False
        self.exited = False
        self.communication = None

    def __enter__(self):
        self.entered = True
        return self

    def __exit__(self, *exception_info):
        self.exited = True

    def communicate(self, input=None, timeout=None):
        self.communication = (input, timeout)
        return ("captured" if self.text_mode else b"captured", None)

    def poll(self):
        return self.returncode

    def wait(self, timeout=None):
        return self.returncode

    def kill(self):
        self.returncode = -1


@contextlib.contextmanager
def simulated_platform(platform="win32"):
    FakePopen.calls = []
    FakePopen.next_error = None
    with contextlib.ExitStack() as stack:
        stack.enter_context(mock.patch.object(bootstrap.sys, "platform", platform))
        stack.enter_context(mock.patch.object(subprocess, "Popen", FakePopen))
        for name, value in (("CREATE_NO_WINDOW", NO_WINDOW),
                            ("CREATE_NEW_CONSOLE", NEW_CONSOLE),
                            ("DETACHED_PROCESS", DETACHED)):
            stack.enter_context(mock.patch.object(subprocess, name, value, create=True))
        yield


def run_bootstrap(*arguments, **kwargs):
    # The test driver itself must not flash a Windows console either.
    return subprocess.run(
        [sys.executable, "-B", str(BOOTSTRAP), *map(str, arguments)],
        capture_output=True, text=True,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        timeout=30, **kwargs,
    )


class SubprocessPolicyTests(unittest.TestCase):
    def test_windows_default_is_an_inheriting_class_and_idempotent(self):
        with simulated_platform():
            self.assertTrue(bootstrap.install_windows_subprocess_policy())
            installed = subprocess.Popen
            self.assertTrue(inspect.isclass(installed))
            self.assertTrue(issubclass(installed, FakePopen))
            process = installed(["tool"])
            self.assertIsInstance(process, FakePopen)
            self.assertEqual(FakePopen.calls[-1]["creationflags"], NO_WINDOW)
            self.assertIs(installed.__enter__, FakePopen.__enter__)
            self.assertTrue(bootstrap.install_windows_subprocess_policy())
            self.assertIs(subprocess.Popen, installed)

    def test_positional_creationflags_and_other_options_are_preserved(self):
        with simulated_platform():
            bootstrap.install_windows_subprocess_policy()
            environment = {"EXAMPLE": "value"}
            startup = object()
            process = subprocess.Popen(
                ["tool"], 4, "exe", 101, 102, 103, None, False, True,
                "working-dir", environment, True, startup, NEW_PROCESS_GROUP,
                False, True, (5,), text=True, encoding="utf-8", errors="replace",
            )
            call = FakePopen.calls[-1]
            self.assertEqual(call["creationflags"], NEW_PROCESS_GROUP | NO_WINDOW)
            for field, expected in (("args", ["tool"]), ("bufsize", 4),
                                    ("executable", "exe"), ("stdin", 101),
                                    ("stdout", 102), ("stderr", 103),
                                    ("close_fds", False), ("shell", True),
                                    ("cwd", "working-dir"),
                                    ("universal_newlines", True),
                                    ("restore_signals", False),
                                    ("start_new_session", True), ("pass_fds", (5,)),
                                    ("text", True), ("encoding", "utf-8"),
                                    ("errors", "replace")):
                self.assertEqual(call[field], expected, field)
            self.assertIs(call["env"], environment)
            self.assertIs(call["startupinfo"], startup)
            with process as entered:
                self.assertIs(entered, process)
                self.assertTrue(process.entered)
            self.assertTrue(process.exited)

    def test_explicit_creationflags_are_ored_unless_console_mode_is_requested(self):
        with simulated_platform():
            bootstrap.install_windows_subprocess_policy()
            for flags, expected in ((0, NO_WINDOW),
                                    (NEW_PROCESS_GROUP, NEW_PROCESS_GROUP | NO_WINDOW),
                                    (NO_WINDOW, NO_WINDOW),
                                    (NEW_CONSOLE, NEW_CONSOLE),
                                    (DETACHED, DETACHED),
                                    (NEW_CONSOLE | NEW_PROCESS_GROUP, NEW_CONSOLE | NEW_PROCESS_GROUP),
                                    (DETACHED | NEW_PROCESS_GROUP, DETACHED | NEW_PROCESS_GROUP),
                                    (NO_WINDOW | NEW_CONSOLE, NO_WINDOW | NEW_CONSOLE)):
                with self.subTest(flags=flags):
                    subprocess.Popen(["tool"], creationflags=flags)
                    self.assertEqual(FakePopen.calls[-1]["creationflags"], expected)

    def test_positional_console_request_is_not_overridden(self):
        with simulated_platform():
            bootstrap.install_windows_subprocess_policy()
            for flags in (NEW_CONSOLE, DETACHED):
                subprocess.Popen(["tool"], -1, None, None, None, None, None,
                                 True, False, None, None, None, None, flags)
                self.assertEqual(FakePopen.calls[-1]["creationflags"], flags)

    def test_run_check_output_and_later_import_alias_use_subclass(self):
        with simulated_platform():
            bootstrap.install_windows_subprocess_policy()
            from subprocess import Popen
            self.assertIs(Popen, subprocess.Popen)
            Popen(["direct"])
            result = subprocess.run(["run"], capture_output=True, input=b"in", timeout=2)
            self.assertEqual(result.stdout, b"captured")
            process = FakePopen.calls[-1]["self"]
            self.assertEqual(process.communication, (b"in", 2))
            self.assertTrue(process.entered)
            self.assertTrue(process.exited)
            self.assertEqual(subprocess.check_output(["check"], text=True), "captured")
            self.assertEqual(len(FakePopen.calls), 3)
            self.assertTrue(all(call["creationflags"] == NO_WINDOW for call in FakePopen.calls))

    def test_underlying_errors_propagate_and_bad_argument_binding_fails(self):
        with simulated_platform():
            bootstrap.install_windows_subprocess_policy()
            expected = FileNotFoundError("missing executable")
            FakePopen.next_error = expected
            with self.assertRaises(FileNotFoundError) as raised:
                subprocess.Popen(["missing"])
            self.assertIs(raised.exception, expected)
            FakePopen.next_error = None
            with self.assertRaises(TypeError):
                subprocess.Popen(["tool"], unknown_option=True)
            with self.assertRaises(TypeError):
                subprocess.Popen(["tool"], args=["duplicate"])

    def test_non_windows_does_not_patch(self):
        for platform in ("linux", "darwin"):
            with self.subTest(platform=platform), simulated_platform(platform):
                self.assertFalse(bootstrap.install_windows_subprocess_policy())
                self.assertIs(subprocess.Popen, FakePopen)
                subprocess.Popen(["tool"])
                self.assertEqual(FakePopen.calls[-1]["creationflags"], 0)


class BootstrapExecutionTests(unittest.TestCase):
    def test_embedded_stdlib_path_is_preserved_and_script_path_is_replaced(self):
        main = str(BOOTSTRAP.parent / "fixture-app" / "main.py")
        app_directory = os.path.dirname(main)
        bootstrap_directory = str(BOOTSTRAP.parent)
        stdlib_zip = str(BOOTSTRAP.parent / "python313.zip")
        site_packages = str(BOOTSTRAP.parent / "Lib" / "site-packages")
        for initial, expected in (
            ([stdlib_zip, site_packages], [app_directory, stdlib_zip, site_packages]),
            ([bootstrap_directory, stdlib_zip], [app_directory, stdlib_zip]),
            ([], [app_directory]),
        ):
            with self.subTest(initial=initial), \
                    mock.patch.object(bootstrap.sys, "path", list(initial)), \
                    mock.patch.object(bootstrap.sys, "argv", ["bootstrap"]), \
                    mock.patch.object(bootstrap, "install_windows_subprocess_policy"), \
                    mock.patch.object(bootstrap.runpy, "run_path") as run_path:
                bootstrap.main([main, "--port", "8188"])
                self.assertEqual(sys.path, expected)
                self.assertEqual(sys.argv, [main, "--port", "8188"])
                run_path.assert_called_once_with(main, run_name="__main__")

    def test_runpy_preserves_native_arguments_import_path_and_working_directory(self):
        with tempfile.TemporaryDirectory(prefix="canvas-bootstrap-test-") as directory:
            root = Path(directory)
            app = root / "app with spaces"
            app.mkdir()
            main = app / "main.py"
            (app / "bootstrap_local_dependency.py").write_text("VALUE = 'local import works'\n", encoding="utf-8")
            main.write_text(
                "import json, os, sys, subprocess\n"
                "from bootstrap_local_dependency import VALUE\n"
                "print(json.dumps({'argv':sys.argv,'path0':sys.path[0],"
                "'cwd':os.getcwd(),'name':__name__,'file':__file__,'import':VALUE,"
                "'env':os.environ['CANVAS_BOOTSTRAP_TEST_VALUE'],"
                "'patched':getattr(subprocess.Popen,'_canvas_windows_no_window',False)}))\n",
                encoding="utf-8",
            )
            arguments = ["--port", "8189", "space value", "中文参数", "--", "-c"]
            env = dict(os.environ, CANVAS_BOOTSTRAP_TEST_VALUE="unchanged")
            result = run_bootstrap(main, *arguments, cwd=root, env=env)
            self.assertEqual(result.returncode, 0, result.stderr)
            observed = json.loads(result.stdout)
            self.assertEqual(observed["argv"], [str(main), *arguments])
            self.assertEqual(observed["path0"], str(app))
            self.assertEqual(observed["cwd"], str(root))
            self.assertEqual(observed["name"], "__main__")
            self.assertEqual(observed["file"], str(main))
            self.assertEqual(observed["import"], "local import works")
            self.assertEqual(observed["env"], "unchanged")
            self.assertEqual(observed["patched"], sys.platform == "win32")

    def test_real_subprocess_wrappers_errors_timeout_and_context_manager(self):
        with tempfile.TemporaryDirectory(prefix="canvas-bootstrap-process-") as directory:
            main = Path(directory) / "main.py"
            main.write_text(
                "import json, subprocess, sys\n"
                "from subprocess import Popen\n"
                "result = subprocess.run([sys.executable,'-c','print(42)'],capture_output=True,text=True,check=True)\n"
                "assert result.stdout.strip() == '42'\n"
                "assert subprocess.check_output([sys.executable,'-c','print(43)']).strip() == b'43'\n"
                "with Popen([sys.executable,'-c','print(44)'],stdout=subprocess.PIPE,text=True) as child:\n"
                "    assert child.communicate(timeout=10)[0].strip() == '44'\n"
                "assert child.returncode == 0\n"
                "try:\n"
                "    subprocess.run([sys.executable,'-c','raise SystemExit(7)'],check=True,capture_output=True)\n"
                "except subprocess.CalledProcessError as error:\n"
                "    assert error.returncode == 7\n"
                "else:\n"
                "    raise AssertionError('missing CalledProcessError')\n"
                "try:\n"
                "    subprocess.run([sys.executable,'-c','import time;time.sleep(10)'],timeout=0.05,capture_output=True)\n"
                "except subprocess.TimeoutExpired:\n"
                "    pass\n"
                "else:\n"
                "    raise AssertionError('missing TimeoutExpired')\n"
                "try:\n"
                "    Popen(['canvas-bootstrap-test-executable-that-does-not-exist'])\n"
                "except OSError:\n"
                "    pass\n"
                "else:\n"
                "    raise AssertionError('missing OSError')\n"
                "print(json.dumps({'ok':True}))\n",
                encoding="utf-8",
            )
            result = run_bootstrap(main, cwd=directory)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout), {"ok": True})

    def test_entry_exit_status_and_relative_path_refusal(self):
        refused = run_bootstrap("relative-main.py")
        self.assertNotEqual(refused.returncode, 0)
        self.assertIn("ABSOLUTE_MAIN_PY", refused.stderr)
        with tempfile.TemporaryDirectory(prefix="canvas-bootstrap-exit-") as directory:
            main = Path(directory) / "main.py"
            main.write_text("raise SystemExit(23)\n", encoding="utf-8")
            result = run_bootstrap(main)
            self.assertEqual(result.returncode, 23, result.stderr)


if __name__ == "__main__":
    unittest.main(verbosity=2)
