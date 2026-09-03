# 后台任务层的冒烟测试，跟 Go 版 bg_test.go 逐条对应。
import subprocess
import sys
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from main import BG_ASYNC, BG_INTERACTIVE, MAX_BG_OUTPUT_BYTES, BgManager, BgProc  # noqa: E402


def new_test_bg():
    return BgManager()


class BgTests(unittest.TestCase):
    # read_new 只给增量，缓冲被挤掉时带截断标记。
    def test_read_new_incremental_and_truncation(self):
        p = BgProc("bg_x", "echo", BG_ASYNC, 0, None)
        p.append(b"\xe7\xac\xac\xe4\xb8\x80\xe6\xae\xb5\n")  # "第一段\n"
        out, _ = p.read_new()
        self.assertEqual(out, "第一段\n")
        out, _ = p.read_new()
        self.assertEqual(out, "", "没有新输出时 read_new 应为空")

        # 截断标记只在"还没读过的输出被挤掉"时出现。
        p2 = BgProc("bg_y", "echo", BG_ASYNC, 0, None)
        p2.append("这一段没人读过就会被挤掉\n".encode())
        p2.append(b"x" * MAX_BG_OUTPUT_BYTES)
        out, _ = p2.read_new()
        self.assertIn("挤出缓冲", out, "未读输出被挤掉时应有截断标记")

    # tail_lines 是快照：反复调用同一个视图，也不影响 read_new 的游标。
    def test_tail_is_snapshot(self):
        p = BgProc("bg_x", "echo", BG_ASYNC, 0, None)
        p.append(b"a\nb\nc\n")
        one, _, _ = p.tail_lines(2)
        two, _, _ = p.tail_lines(2)
        self.assertEqual(one, two, "重复 tail 应看到同一视图")
        out, _ = p.read_new()
        self.assertIn("a\nb\nc", out, "tail 不应动 read_new 的游标")

    # 防轮询：30 秒窗口内第三次空快照触发硬停；有输出就清零；退出的进程不算。
    def test_anti_polling_window(self):
        p = BgProc("bg_x", "echo", BG_ASYNC, 0, None)  # done=False 视为还在跑
        for i in range(1, 3):
            _, _, blocked = p.tail_lines(10)
            self.assertFalse(blocked, f"第 {i} 次空查还不该硬停")
        _, _, blocked = p.tail_lines(10)
        self.assertTrue(blocked, "窗口内第三次空查应硬停")

        p.append("进展\n".encode())
        _, _, blocked = p.tail_lines(10)
        self.assertFalse(blocked, "有输出的快照不算轮询")

        p2 = BgProc("bg_y", "echo", BG_ASYNC, 0, None)
        p2.finish(0)
        for _ in range(5):
            _, _, blocked = p2.tail_lines(10)
            self.assertFalse(blocked, "退出进程的空快照不应触发硬停")

    # 真实进程：快退出的命令，完成通知必须带上它的全部输出，async 秒完的
    # 还要带"不需要后台"的教育。
    def test_start_async_notify_keeps_output_and_nudges(self):
        m = new_test_bg()
        id_ = m.start("echo 干完了", BG_ASYNC)
        try:
            note = m.done.get(timeout=5)
        except Exception:
            self.fail("等完成通知超时")
        self.assertIn("干完了", note, "完成通知应带上进程输出")
        self.assertIn(id_, note)
        self.assertIn("exited: 0", note)
        self.assertIn("不需要放后台", note, "秒完的 async 应被教育")
        self.assertIn("<system-reminder>", note)

    # interactive 全链路：起一个 cat，喂 stdin，tail 看到回显，kill_all 收编。
    def test_interactive_stdin_and_kill_all(self):
        m = new_test_bg()
        id_ = m.start("cat", BG_INTERACTIVE)
        p = m.get(id_)
        self.assertIsNotNone(p, "get 找不到刚起的进程")
        p.stdin.write("你好后台\n".encode())
        p.stdin.flush()
        deadline = time.monotonic() + 3
        out = ""
        while time.monotonic() < deadline:
            out, _, _ = p.tail_lines(0)
            if "你好后台" in out:
                break
            time.sleep(0.02)
        else:
            self.fail(f"等不到 cat 的回显，缓冲={out!r}")
        m.kill_all()
        try:
            m.done.get(timeout=5)
        except Exception:
            self.fail("kill_all 之后等不到退出通知")

    # kill_all 杀的是整个进程组：sh -c 包装 fork 出来的孙进程（这里的
    # sleep）也要一起死，不能只杀最外层的 sh。
    def test_kill_all_kills_process_group(self):
        m = new_test_bg()
        # && 让 sh 不做单命令 exec 优化，sleep 保持为 sh 的子进程。
        m.start("sleep 3777 && echo 永远到不了", BG_INTERACTIVE)
        time.sleep(0.2)  # 等 sh fork 出 sleep
        m.kill_all()
        try:
            m.done.get(timeout=5)
        except Exception:
            self.fail("kill_all 之后等不到退出通知")
        time.sleep(0.1)
        out = subprocess.run(["pgrep", "-f", "sleep 3777"], capture_output=True, text=True).stdout.strip()
        if out:
            subprocess.run(["pkill", "-f", "sleep 3777"])
            self.fail(f"孙进程活过了 kill_all（pid {out}）——只杀到了 sh 包装层")


if __name__ == "__main__":
    unittest.main()
