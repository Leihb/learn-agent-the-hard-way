# 危险的东西要先用代码确认拦得住，再交给模型——练习 9 就定下的规矩。
# 跑法: python3 test_sandbox.py
import os
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import main as harness  # noqa: E402


def run(command, sandboxed):
    harness.ACTIVE_SANDBOX = harness.default_sandbox_policy() if sandboxed else None
    try:
        argv = harness.shell_command(command)
        result = subprocess.run(argv, cwd=harness.WORK_DIR,
                                 stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        return result.stdout.decode(errors="replace"), result.returncode
    finally:
        harness.ACTIVE_SANDBOX = None


@unittest.skipUnless(harness.sandbox_available(), "这台机器提供不了 sandbox-exec")
class SandboxTests(unittest.TestCase):
    def test_allows_cwd_write(self):
        target = os.path.join(harness.WORK_DIR, "sandbox-smoke.txt")
        try:
            out, code = run("echo ok > sandbox-smoke.txt", sandboxed=True)
            self.assertEqual(code, 0, out)
        finally:
            if os.path.exists(target):
                os.remove(target)

    def test_allows_tmp_write(self):
        target = os.path.join(tempfile.gettempdir(), "sandbox-smoke-tmp.txt")
        try:
            out, code = run(f"echo ok > {target}", sandboxed=True)
            self.assertEqual(code, 0, out)
        finally:
            if os.path.exists(target):
                os.remove(target)

    def test_blocks_home_write(self):
        target = os.path.join(os.path.expanduser("~"), "smoke-should-fail.txt")
        try:
            out, code = run(f"echo pwned > {target}", sandboxed=True)
            self.assertNotEqual(code, 0, f"家目录写入应当被拦: out={out!r}")
            self.assertFalse(os.path.exists(target), "文件不应该存在——命令报错但文件写成了？")
        finally:
            if os.path.exists(target):
                os.remove(target)

    def test_blocks_secret_read(self):
        home = os.path.expanduser("~")
        out, code = run(f"cat {home}/.zshrc", sandboxed=True)
        self.assertNotEqual(code, 0, out)

    def test_blocks_network(self):
        out, code = run("curl -s --max-time 3 https://example.com", sandboxed=True)
        self.assertNotEqual(code, 0, out)

    def test_no_sandbox_control(self):
        # 对照组：不开沙箱时家目录写入畅通无阻，证明拦住上面那几个的
        # 是沙箱，不是别的什么碰巧失败。
        target = os.path.join(os.path.expanduser("~"), "smoke-control.txt")
        try:
            out, code = run(f"echo control > {target}", sandboxed=False)
            self.assertEqual(code, 0, f"不开沙箱时家目录写入应当成功: out={out!r}")
        finally:
            if os.path.exists(target):
                os.remove(target)


if __name__ == "__main__":
    unittest.main(verbosity=2)
