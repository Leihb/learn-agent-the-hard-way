# 冒烟测试：waker 的防漏逻辑不能靠真机等半小时来验，直接摆弄内部状态。
#
# 四条断言对应 ex26.md"发生了什么"里点名的四条规矩：
#   1. 上限到了拒绝续命，并且把时钟清零（人重开一个循环时不会一上来
#      就被判过期）
#   2. 再安排一次是替换（旧的定时器不许再响）
#   3. 取消之后不再响
#   4. 丢拍规则：固定节奏可以丢，一次性绝不能丢
import queue
import sys
import threading
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from main import MAX_LOOP_LIFETIME, Waker  # noqa: E402


class WakerTests(unittest.TestCase):
    def test_expired_rejects_arm_and_resets_clock(self):
        w = Waker()
        # 直接把开始时刻改成"半小时零一分钟前"，不用真等半小时。
        w.start = time.monotonic() - MAX_LOOP_LIFETIME - 60
        with self.assertRaises(RuntimeError):
            w.arm(1, "接着跑", True)
        self.assertFalse(w.armed())
        self.assertEqual(w.start, 0.0, "过期之后时钟没有清零——人重开一个循环会立刻被误判过期")

    def test_rearm_replaces_not_stacks(self):
        w = Waker()
        w.arm(10, "第一次", False)
        first_timer = w.timer
        w.arm(10, "第二次", False)
        self.assertIsNot(w.timer, first_timer, "再安排一次没有替换掉旧定时器——会变成叠加")
        first_timer.join(timeout=1)
        self.assertFalse(first_timer.is_alive())
        w.cancel()

    def test_cancel_stops_future_fires(self):
        w = Waker()
        w.arm(0.05, "hello", False)
        w.cancel()
        time.sleep(0.2)
        self.assertTrue(w.ticks.empty(), "取消之后定时器还是响了")

    def test_repeat_drops_when_full_oneshot_must_deliver(self):
        w = Waker()
        w.ticks.put("占位")  # 让容量为 1 的队列先满
        w.fire("重复模式，应该被丢弃", True)
        self.assertEqual(w.ticks.get_nowait(), "占位", "repeat 模式没有丢弃已满队列里的那一拍")
        self.assertTrue(w.ticks.empty())

        w.ticks.put("占位2")
        result = {}

        def send_oneshot():
            w.fire("一次性，必须送达", False)
            result["sent"] = True

        t = threading.Thread(target=send_oneshot)
        t.start()
        time.sleep(0.1)
        self.assertNotIn("sent", result, "一次性模式的 fire() 在队列满时不该立刻返回——它必须等")
        self.assertEqual(w.ticks.get(), "占位2")  # 腾出空间
        t.join(timeout=1)
        self.assertIn("sent", result, "腾出空间之后一次性模式的 fire() 应该送达")
        self.assertEqual(w.ticks.get_nowait(), "一次性，必须送达")


if __name__ == "__main__":
    unittest.main()
