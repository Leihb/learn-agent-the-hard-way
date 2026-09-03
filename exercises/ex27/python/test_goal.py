# goal 状态机的冒烟测试，跟 Go 版 goal_test.go 逐条对应，不用真机等
# 一整轮请求来验证。
import sys
import threading
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from main import GOAL_ACTIVE, GOAL_BUDGET_LIMITED, GOAL_COMPLETE, GOAL_PAUSED, GoalBox  # noqa: E402


class GoalBoxTests(unittest.TestCase):
    # 已有 goal 时 create 必须失败——包括已经完成的 goal，防模型静默覆盖。
    def test_create_fails_when_goal_exists(self):
        b = GoalBox()
        b.create("目标一", 0)
        with self.assertRaises(ValueError):
            b.create("目标二", 0)
        b.set_status(GOAL_COMPLETE)
        with self.assertRaises(ValueError):
            b.create("目标三", 0)

    # 交过卷的 goal 不能 resume 回 active。
    def test_complete_cannot_resume(self):
        b = GoalBox()
        b.create("目标", 0)
        b.set_status(GOAL_COMPLETE)
        with self.assertRaises(ValueError):
            b.set_status(GOAL_ACTIVE)

    # 越线只发生一次：跨线那一刻状态变 budget_limited、暂存一条收尾提示；
    # 之后继续记账（在飞的活还在烧钱），但不再有第二条提示。
    def test_budget_crossing_steers_once(self):
        b = GoalBox()
        b.create("目标", 100)
        b.turn_start()  # 作废建 goal 的跳账保护，测试里直接记账
        b.account(150)
        g = b.snapshot()
        self.assertEqual(g["status"], GOAL_BUDGET_LIMITED)
        steer, ok = b.consume_budget_steer()
        self.assertTrue(ok)
        self.assertIn("150", steer)
        b.account(30)
        g = b.snapshot()
        self.assertEqual(g["tokens_used"], 180, "budget_limited 的 goal 仍要记账")
        _, ok = b.consume_budget_steer()
        self.assertFalse(ok, "收尾提示是一次性的，不该有第二条")

    # resume 一个越了线的 goal 只能落在 budget_limited 上，回不了 active。
    def test_resume_over_budget_lands_budget_limited(self):
        b = GoalBox()
        b.create("目标", 100)
        b.turn_start()
        b.account(150)
        b.set_status(GOAL_PAUSED)
        g = b.set_status(GOAL_ACTIVE)
        self.assertEqual(g["status"], GOAL_BUDGET_LIMITED)

    # 零进度刹车：续了一轮 token 没动就停；真实进展或 goal 变更把刹车松开。
    def test_zero_progress_brake(self):
        b = GoalBox()
        b.create("目标", 0)
        b.turn_start()
        b.account(50)
        _, ok = b.continuation()
        self.assertTrue(ok, "活跃 goal 第一次问续 turn 应该放行")
        _, ok = b.continuation()
        self.assertFalse(ok, "零进度的续 turn 应该被刹住")
        _, ok = b.continuation()
        self.assertFalse(ok, "刹车踩下后应保持刹住")
        b.account(10)
        _, ok = b.continuation()
        self.assertTrue(ok, "记了账之后刹车应松开")
        b.continuation()  # 再空转一轮踩下刹车
        b.set_status(GOAL_PAUSED)
        b.set_status(GOAL_ACTIVE)
        _, ok = b.continuation()
        self.assertTrue(ok, "状态变更后刹车应松开")

    # 打断/报错的 suppress 直接踩死刹车，零进度审计接不住这两种。
    def test_suppress_parks_continuation(self):
        b = GoalBox()
        b.create("目标", 0)
        b.turn_start()
        b.account(50)
        b.suppress()
        _, ok = b.continuation()
        self.assertFalse(ok, "suppress 之后不该放行续 turn")
        b.account(10)
        _, ok = b.continuation()
        self.assertTrue(ok, "真实进展应重新放行续 turn")

    # 立 goal 那一轮的下一笔账不记，且这个保护只活到轮次边界。
    def test_skip_next_delta(self):
        b = GoalBox()
        b.create("目标", 0)
        b.account(1000)
        self.assertEqual(b.snapshot()["tokens_used"], 0, "建 goal 后的第一笔账应跳过")
        b.account(80)
        self.assertEqual(b.snapshot()["tokens_used"], 80, "跳账只跳一笔")

        b2 = GoalBox()
        b2.create("目标", 0)
        b2.turn_start()
        b2.account(1000)
        self.assertEqual(b2.snapshot()["tokens_used"], 1000, "轮次边界后第一笔应照常记")

    # 工具在轮次线程里、命令在主循环里并发碰同一个 GoalBox——一把锁兜底。
    # Python 没有 -race，只能靠"账没丢"这个可观察结果验证锁生效。
    def test_concurrent_access(self):
        b = GoalBox()
        b.create("目标", 10000)
        b.turn_start()

        def worker():
            for _ in range(100):
                b.account(1)
                b.snapshot()
                b.continuation()

        threads = [threading.Thread(target=worker) for _ in range(8)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(b.snapshot()["tokens_used"], 800, "并发记账丢账了")


if __name__ == "__main__":
    unittest.main()
