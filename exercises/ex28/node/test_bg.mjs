// 后台任务层的冒烟测试，跟 Go 版 bg_test.go 逐条对应。main.mjs 是顶层
// 脚本，没法直接拿来单测——这里把 BgProc/BgManager 原样抄一份，跟
// main.mjs 里的版本逐字一致。
// 跑法: node --test test_bg.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execSync } from "node:child_process";

const MAX_BG_OUTPUT_BYTES = 64 * 1024;
const POLL_WINDOW_MS = 30_000;
const MAX_EMPTY_POLLS = 3;
const SHORT_ASYNC_DURATION_MS = 10_000;
const BG_ASYNC = "async";
const BG_INTERACTIVE = "interactive";

class BgProc {
  constructor(id, command, mode, pid, stdin) {
    this.id = id;
    this.command = command;
    this.mode = mode;
    this.pid = pid;
    this.start = Date.now();
    this.stdin = stdin;
    this.buf = Buffer.alloc(0);
    this.produced = 0;
    this.readOff = 0;
    this.done = false;
    this.exitCode = null;
    this.firstEmptyPoll = 0;
    this.emptyPollCount = 0;
  }
  append(chunk) {
    this.produced += chunk.length;
    this.buf = Buffer.concat([this.buf, chunk]);
    if (this.buf.length > MAX_BG_OUTPUT_BYTES) {
      this.buf = this.buf.subarray(this.buf.length - MAX_BG_OUTPUT_BYTES);
    }
  }
  finish(exitCode) {
    this.done = true;
    this.exitCode = exitCode;
  }
  statusText() {
    if (!this.done) return "running";
    if (this.exitCode) return `exited: exit status ${this.exitCode}`;
    return "exited: 0";
  }
  readNew() {
    const bufStart = this.produced - this.buf.length;
    let out = Buffer.alloc(0);
    if (this.readOff < bufStart) {
      out = Buffer.concat([out, Buffer.from("[... 更早的输出已被挤出缓冲 ...]\n")]);
      this.readOff = bufStart;
    }
    out = Buffer.concat([out, this.buf.subarray(this.readOff - bufStart)]);
    this.readOff = this.produced;
    return [out.toString("utf-8"), this.statusText()];
  }
  tailLines(n) {
    let body = this.buf;
    let truncated = this.produced > this.buf.length;
    if (n > 0) {
      const stripped = body.toString("utf-8").replace(/\n+$/, "");
      let lines = stripped ? stripped.split("\n") : [];
      if (lines.length > n) {
        lines = lines.slice(-n);
        truncated = true;
      }
      body = Buffer.from(lines.join("\n"));
    }
    let out = body.toString("utf-8");
    if (truncated && out) out = "[... 更早的输出已截断 ...]\n" + out;
    let blocked = false;
    if (!this.done && out === "") {
      const now = Date.now();
      if (this.emptyPollCount === 0 || now - this.firstEmptyPoll > POLL_WINDOW_MS) {
        this.firstEmptyPoll = now;
        this.emptyPollCount = 1;
      } else {
        this.emptyPollCount++;
        if (this.emptyPollCount >= MAX_EMPTY_POLLS) blocked = true;
      }
    } else {
      this.emptyPollCount = 0;
      this.firstEmptyPoll = 0;
    }
    return [out, this.statusText(), blocked];
  }
  kill() {
    if (this.pid > 0) {
      try { process.kill(-this.pid, "SIGKILL"); } catch { /* 已退出 */ }
    }
  }
}

function formatBgNote(p) {
  const [rawOut, status] = p.readNew();
  const parts = ["<system-reminder>\n[后台任务完成]\n", `后台进程 ${p.id}（\`${p.command}\`）${status}。`];
  const out = rawOut.replace(/\n+$/, "");
  if (out) {
    parts.push("\n之后的新输出：\n", out);
  } else {
    parts.push("\n（没有新输出）");
  }
  if (p.mode === BG_ASYNC) {
    const d = Date.now() - p.start;
    if (d < SHORT_ASYNC_DURATION_MS) {
      parts.push(`\n\n[注意：这个任务 ${(d / 1000).toFixed(1)}s 就跑完了——这么快的命令根本不需要放后台。]`);
    }
  }
  parts.push("\n</system-reminder>");
  return parts.join("");
}

class BgManager {
  constructor() {
    this.procs = new Map();
    this.seq = 0;
    this.notes = []; // 测试用：done 事件在这里排队，代替 EVENTS.push
    this.waiters = [];
  }
  start(command, mode) {
    const child = spawn("/bin/sh", ["-c", `(${command}) 2>&1`], { detached: true, stdio: ["pipe", "pipe", "pipe"] });
    this.seq++;
    const id = `bg_${this.seq}`;
    const p = new BgProc(id, command, mode, child.pid, child.stdin);
    this.procs.set(id, p);
    child.stdout.on("data", (chunk) => p.append(chunk));
    child.stderr.on("data", (chunk) => p.append(chunk));
    child.on("close", (code) => {
      p.finish(code ?? 0);
      const note = formatBgNote(p);
      if (this.waiters.length) this.waiters.shift()(note);
      else this.notes.push(note);
    });
    return id;
  }
  get(id) {
    return this.procs.get(id) ?? null;
  }
  killAll() {
    for (const p of this.procs.values()) p.kill();
  }
  nextNote(timeoutMs) {
    if (this.notes.length) return Promise.resolve(this.notes.shift());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("等完成通知超时")), timeoutMs);
      this.waiters.push((note) => { clearTimeout(timer); resolve(note); });
    });
  }
}

// readNew 只给增量，缓冲被挤掉时带截断标记。
test("readNew 只给增量，且未读输出被挤掉时带截断标记", () => {
  const p = new BgProc("bg_x", "echo", BG_ASYNC, 0, null);
  p.append(Buffer.from("第一段\n"));
  let [out] = p.readNew();
  assert.equal(out, "第一段\n");
  [out] = p.readNew();
  assert.equal(out, "", "没有新输出时 readNew 应为空");

  const p2 = new BgProc("bg_y", "echo", BG_ASYNC, 0, null);
  p2.append(Buffer.from("这一段没人读过就会被挤掉\n"));
  p2.append(Buffer.alloc(MAX_BG_OUTPUT_BYTES, "x"));
  [out] = p2.readNew();
  assert.match(out, /挤出缓冲/);
});

// tailLines 是快照：反复调用同一个视图，也不影响 readNew 的游标。
test("tailLines 是快照，不影响 readNew 游标", () => {
  const p = new BgProc("bg_x", "echo", BG_ASYNC, 0, null);
  p.append(Buffer.from("a\nb\nc\n"));
  const [one] = p.tailLines(2);
  const [two] = p.tailLines(2);
  assert.equal(one, two);
  const [out] = p.readNew();
  assert.match(out, /a\nb\nc/);
});

// 防轮询：30 秒窗口内第三次空快照触发硬停；有输出就清零；退出的进程不算。
test("防轮询窗口：第三次空查硬停，有输出清零，已退出不算", () => {
  const p = new BgProc("bg_x", "echo", BG_ASYNC, 0, null);
  for (let i = 1; i <= 2; i++) {
    const [, , blocked] = p.tailLines(10);
    assert.equal(blocked, false, `第 ${i} 次空查还不该硬停`);
  }
  let [, , blocked] = p.tailLines(10);
  assert.equal(blocked, true, "窗口内第三次空查应硬停");

  p.append(Buffer.from("进展\n"));
  [, , blocked] = p.tailLines(10);
  assert.equal(blocked, false, "有输出的快照不算轮询");

  const p2 = new BgProc("bg_y", "echo", BG_ASYNC, 0, null);
  p2.finish(0);
  for (let i = 0; i < 5; i++) {
    [, , blocked] = p2.tailLines(10);
    assert.equal(blocked, false, "退出进程的空快照不应触发硬停");
  }
});

// 真实进程：快退出的命令，完成通知必须带上它的全部输出，async 秒完的
// 还要带"不需要后台"的教育。
test("start(async) 的完成通知带输出、id、退出状态和教育语", async () => {
  const m = new BgManager();
  const id = m.start("echo 干完了", BG_ASYNC);
  const note = await m.nextNote(5000);
  assert.match(note, /干完了/, "完成通知应带上进程输出");
  assert.ok(note.includes(id));
  assert.match(note, /exited: 0/);
  assert.match(note, /不需要放后台/, "秒完的 async 应被教育");
  assert.match(note, /<system-reminder>/);
});

// interactive 全链路：起一个 cat，喂 stdin，tail 看到回显，killAll 收编。
test("interactive 全链路：stdin 写入、tailLines 看到回显、killAll 收编", async () => {
  const m = new BgManager();
  const id = m.start("cat", BG_INTERACTIVE);
  const p = m.get(id);
  assert.ok(p, "get 找不到刚起的进程");
  p.stdin.write("你好后台\n");

  const deadline = Date.now() + 3000;
  let out = "";
  while (Date.now() < deadline) {
    [out] = p.tailLines(0);
    if (out.includes("你好后台")) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.match(out, /你好后台/, `等不到 cat 的回显，缓冲=${out}`);

  m.killAll();
  await m.nextNote(5000); // cat 被杀，收尾触发完成通知
});

// killAll 杀的是整个进程组：sh -c 包装 fork 出来的孙进程（这里的 sleep）
// 也要一起死，不能只杀最外层的 sh。
test("killAll 杀整个进程组，孙进程不能活下来", async () => {
  const m = new BgManager();
  // && 让 sh 不做单命令 exec 优化，sleep 保持为 sh 的子进程。
  m.start("sleep 3777 && echo 永远到不了", BG_INTERACTIVE);
  await new Promise((r) => setTimeout(r, 200)); // 等 sh fork 出 sleep
  m.killAll();
  await m.nextNote(5000);
  await new Promise((r) => setTimeout(r, 100));
  let out = "";
  try {
    out = execSync("pgrep -f 'sleep 3777'").toString().trim();
  } catch {
    out = ""; // pgrep 找不到匹配时非零退出，视为没有孙进程活着
  }
  if (out) {
    try { execSync("pkill -f 'sleep 3777'"); } catch { /* 尽力清理 */ }
    assert.fail(`孙进程活过了 killAll（pid ${out}）——只杀到了 sh 包装层`);
  }
});
