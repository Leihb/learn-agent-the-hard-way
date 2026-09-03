// goal 状态机的冒烟测试，跟 Go 版 goal_test.go 逐条对应。main.mjs 是顶层
// 脚本，没法直接拿来单测——这里把 GoalBox/Goal 原样抄一份，跟 main.mjs
// 里的版本逐字一致。
// 跑法: node --test test_goal.mjs
import { test } from "node:test";
import assert from "node:assert/strict";

const GOAL_ACTIVE = "active";
const GOAL_PAUSED = "paused";
const GOAL_BLOCKED = "blocked";
const GOAL_BUDGET_LIMITED = "budget_limited";
const GOAL_COMPLETE = "complete";

class Goal {
  constructor(objective, tokenBudget) {
    this.objective = objective;
    this.status = GOAL_ACTIVE;
    this.tokenBudget = tokenBudget;
    this.tokensUsed = 0;
  }
  remaining() {
    if (this.tokenBudget <= 0) return -1;
    return Math.max(this.tokenBudget - this.tokensUsed, 0);
  }
  snapshot() {
    return { objective: this.objective, status: this.status,
      tokenBudget: this.tokenBudget, tokensUsed: this.tokensUsed };
  }
}

class GoalBox {
  constructor() {
    this.g = null;
    this.contPending = false;
    this.contTokensAt = 0;
    this.contSuppressed = false;
    this.budgetSteer = "";
    this.skipNextDelta = false;
  }
  snapshot() {
    return this.g ? this.g.snapshot() : null;
  }
  create(objective, budget) {
    objective = objective.trim();
    if (!objective) throw new Error("objective 不能为空");
    if (budget < 0) throw new Error("token_budget 给了就得是正数");
    if (this.g !== null) throw new Error("这个会话已经有一个 goal 了");
    this.g = new Goal(objective, budget);
    this._resetRuntime();
    this.skipNextDelta = true;
    return this.g.snapshot();
  }
  setStatus(status) {
    if (this.g === null) throw new Error("现在没有 goal");
    if (status === GOAL_ACTIVE && this.g.status === GOAL_COMPLETE) {
      throw new Error("goal 已经完成了");
    }
    if (status === GOAL_ACTIVE && this.g.remaining() === 0) status = GOAL_BUDGET_LIMITED;
    this.g.status = status;
    this._resetRuntime();
    return this.g.snapshot();
  }
  clear() {
    if (this.g === null) return false;
    this.g = null;
    this._resetRuntime();
    return true;
  }
  _resetRuntime() {
    this.contPending = false;
    this.contSuppressed = false;
    this.budgetSteer = "";
  }
  turnStart() {
    this.skipNextDelta = false;
  }
  account(delta) {
    delta = Math.max(delta, 0);
    if (this.skipNextDelta) {
      this.skipNextDelta = false;
      delta = 0;
    }
    if (delta === 0 || this.g === null ||
        (this.g.status !== GOAL_ACTIVE && this.g.status !== GOAL_BUDGET_LIMITED)) {
      return;
    }
    this.contSuppressed = false;
    this.g.tokensUsed += delta;
    if (this.g.status === GOAL_ACTIVE && this.g.remaining() === 0) {
      this.g.status = GOAL_BUDGET_LIMITED;
      this.budgetSteer = `用量 ${this.g.tokensUsed}/${this.g.tokenBudget}`;
    }
  }
  consumeBudgetSteer() {
    const s = this.budgetSteer;
    this.budgetSteer = "";
    return [s, s !== ""];
  }
  continuation() {
    if (this.g === null || this.g.status !== GOAL_ACTIVE) {
      this.contPending = false;
      return ["", false];
    }
    if (this.contPending) {
      this.contPending = false;
      if (this.g.tokensUsed === this.contTokensAt) this.contSuppressed = true;
    }
    if (this.contSuppressed) return ["", false];
    this.contPending = true;
    this.contTokensAt = this.g.tokensUsed;
    return ["continuation-prompt", true];
  }
  suppress() {
    this.contPending = false;
    this.contSuppressed = true;
  }
}

// 已有 goal 时 create 必须失败——包括已经完成的 goal，防模型静默覆盖。
test("create 在已有 goal 时失败（含已完成的 goal）", () => {
  const b = new GoalBox();
  b.create("目标一", 0);
  assert.throws(() => b.create("目标二", 0));
  b.setStatus(GOAL_COMPLETE);
  assert.throws(() => b.create("目标三", 0));
});

// 交过卷的 goal 不能 resume 回 active。
test("complete 的 goal 不能 resume", () => {
  const b = new GoalBox();
  b.create("目标", 0);
  b.setStatus(GOAL_COMPLETE);
  assert.throws(() => b.setStatus(GOAL_ACTIVE));
});

// 越线只发生一次：跨线那一刻状态变 budget_limited、暂存一条收尾提示；
// 之后继续记账，但不再有第二条提示。
test("预算越线只触发一次收尾提示，之后仍照常记账", () => {
  const b = new GoalBox();
  b.create("目标", 100);
  b.turnStart();
  b.account(150);
  assert.equal(b.snapshot().status, GOAL_BUDGET_LIMITED);
  let [steer, ok] = b.consumeBudgetSteer();
  assert.ok(ok);
  assert.match(steer, /150/);
  b.account(30);
  assert.equal(b.snapshot().tokensUsed, 180, "budget_limited 的 goal 仍要记账");
  [, ok] = b.consumeBudgetSteer();
  assert.equal(ok, false, "收尾提示是一次性的");
});

// resume 一个越了线的 goal 只能落在 budget_limited 上。
test("resume 越线 goal 落在 budget_limited", () => {
  const b = new GoalBox();
  b.create("目标", 100);
  b.turnStart();
  b.account(150);
  b.setStatus(GOAL_PAUSED);
  const g = b.setStatus(GOAL_ACTIVE);
  assert.equal(g.status, GOAL_BUDGET_LIMITED);
});

// 零进度刹车：续了一轮 token 没动就停；真实进展或 goal 变更把刹车松开。
test("零进度刹车：无进展就停，真实进展或状态变更松开", () => {
  const b = new GoalBox();
  b.create("目标", 0);
  b.turnStart();
  b.account(50);
  assert.equal(b.continuation()[1], true, "第一次问续 turn 应该放行");
  assert.equal(b.continuation()[1], false, "零进度应被刹住");
  assert.equal(b.continuation()[1], false, "刹车应保持刹住");
  b.account(10);
  assert.equal(b.continuation()[1], true, "记了账之后刹车应松开");
  b.continuation(); // 再空转一轮踩下刹车
  b.setStatus(GOAL_PAUSED);
  b.setStatus(GOAL_ACTIVE);
  assert.equal(b.continuation()[1], true, "状态变更后刹车应松开");
});

// 打断/报错的 suppress 直接踩死刹车。
test("suppress 踩死续 turn，真实进展重新武装", () => {
  const b = new GoalBox();
  b.create("目标", 0);
  b.turnStart();
  b.account(50);
  b.suppress();
  assert.equal(b.continuation()[1], false);
  b.account(10);
  assert.equal(b.continuation()[1], true);
});

// 立 goal 那一轮的下一笔账不记，且这个保护只活到轮次边界。
test("跳账只跳一笔，且只在轮次边界内有效", () => {
  const b = new GoalBox();
  b.create("目标", 0);
  b.account(1000);
  assert.equal(b.snapshot().tokensUsed, 0, "建 goal 后第一笔应跳过");
  b.account(80);
  assert.equal(b.snapshot().tokensUsed, 80);

  const b2 = new GoalBox();
  b2.create("目标", 0);
  b2.turnStart();
  b2.account(1000);
  assert.equal(b2.snapshot().tokensUsed, 1000, "轮次边界后第一笔应照常记");
});

// JavaScript 单线程，没有 Go 版 TestConcurrentAccess 对应的真实并发场景
// ——这里退化成"连续调用 800 次账不丢"，验证的是记账逻辑本身而不是锁。
test("连续记账 800 次不丢账（单线程下无并发场景可测）", () => {
  const b = new GoalBox();
  b.create("目标", 10000);
  b.turnStart();
  for (let i = 0; i < 800; i++) {
    b.account(1);
    b.snapshot();
    b.continuation();
  }
  assert.equal(b.snapshot().tokensUsed, 800);
});
