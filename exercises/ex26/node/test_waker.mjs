// waker 的防漏逻辑不能靠真机等半小时来验——直接摆弄内部状态。
// 跑法: node --test test_waker.mjs
//
// main.mjs 是顶层脚本（一 import 就会解析 CLI 参数、发网络请求），没法
// 直接拿来单测——这里把 Waker 类原样抄一份，跟 main.mjs 里的版本逐字
// 一致，如果两边不同步，正文的敲进去步骤会先漏掉。
import { test } from "node:test";
import assert from "node:assert/strict";

const MAX_LOOP_LIFETIME_MS = 30 * 60 * 1000;

class Waker {
  constructor() {
    this.timer = null;
    this.start = 0;
    this.pendingTick = null;
    this.drainWaiters = [];
  }
  loopExpired() {
    return this.start !== 0 && Date.now() - this.start >= MAX_LOOP_LIFETIME_MS;
  }
  arm(delayMs, prompt, repeat) {
    if (this.start === 0) this.start = Date.now();
    if (this.loopExpired()) {
      this._stop();
      throw new Error("这个循环已经跑满上限，停了，不再续");
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (repeat) {
        try { this.arm(delayMs, prompt, repeat); } catch { /* 上限到了，不再续 */ }
      }
      this.fire(prompt, repeat).catch(() => {});
    }, delayMs);
  }
  async fire(prompt, repeat) {
    if (repeat) {
      if (this.pendingTick !== null) return;
      this.pendingTick = prompt;
      this._delivered = prompt;
      return;
    }
    while (this.pendingTick !== null) {
      await new Promise((resolve) => this.drainWaiters.push(resolve));
    }
    this.pendingTick = prompt;
    this._delivered = prompt;
  }
  consumed() {
    this.pendingTick = null;
    const w = this.drainWaiters.shift();
    if (w) w();
  }
  armed() {
    return this.timer !== null;
  }
  cancel() {
    this._stop();
  }
  _stop() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.start = 0;
  }
}

test("过期之后 arm 拒绝续命，并且把时钟清零", () => {
  const w = new Waker();
  w.start = Date.now() - MAX_LOOP_LIFETIME_MS - 60_000;
  assert.throws(() => w.arm(1000, "接着跑", true));
  assert.equal(w.armed(), false);
  assert.equal(w.start, 0, "过期之后时钟没有清零——人重开一个循环会立刻被误判过期");
});

test("再安排一次是替换，不是叠加", () => {
  const w = new Waker();
  w.arm(10_000, "第一次", false);
  const firstTimer = w.timer;
  w.arm(10_000, "第二次", false);
  assert.notEqual(w.timer, firstTimer, "再安排一次没有替换掉旧定时器");
  w.cancel();
});

test("取消之后不再响", async () => {
  const w = new Waker();
  w.pendingTick = null;
  w.arm(50, "hello", false);
  w.cancel();
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(w.pendingTick, null, "取消之后定时器还是响了");
});

test("repeat 模式满了就丢，one-shot 模式必须送达（等 pendingTick 被消费）", async () => {
  const w = new Waker();
  w.pendingTick = "占位"; // 模拟"上一拍还没被处理完"
  await w.fire("重复模式，应该被丢弃", true);
  assert.equal(w.pendingTick, "占位", "repeat 模式覆盖或顶替了满队列里的那一拍");

  let delivered = false;
  const oneshot = w.fire("一次性，必须送达", false).then(() => {
    delivered = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(delivered, false, "一次性模式的 fire() 在 pendingTick 非空时不该立刻 resolve——它必须等");
  w.consumed(); // 腾出空间
  await oneshot;
  assert.equal(delivered, true, "腾出空间之后一次性模式的 fire() 应该送达");
  assert.equal(w.pendingTick, "一次性，必须送达");
});
