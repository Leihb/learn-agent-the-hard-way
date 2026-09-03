// 危险的东西要先用代码确认拦得住，再交给模型——练习 9 就定下的规矩。
// 跑法: node --test test_sandbox.mjs
//
// main.mjs 是顶层脚本（一 import 就会解析 CLI 参数、发网络请求），没法
// 直接拿来单测——这里把沙箱层那几个纯函数原样抄一份。它们不碰任何共享
// 状态（activeSandbox 在这份文件里是局部变量，不是 main.mjs 那个模块级
// 变量），只测"策略 → SBPL 规则 → 操作系统是否真的照办"这条链路，跟
// main.mjs 里的版本逐字一致，如果两边不同步，正文的敲进去步骤会先漏掉。
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync, unlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const workDir = process.cwd();

function defaultSandboxPolicy() {
  const tmp = tmpdir();
  return {
    readRoots: [workDir, tmp, "/usr", "/bin", "/sbin", "/etc", "/var",
      "/private", "/System", "/Library", "/opt"],
    writeRoots: [workDir, tmp],
    allowNetwork: false,
  };
}

function sandboxAvailable() {
  if (process.platform !== "darwin") return false;
  return existsSync("/usr/bin/sandbox-exec");
}

function buildSandboxProfile(p) {
  const resolve = (path) => {
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  };
  const subpaths = (roots) => roots.map((r) => `(subpath "${resolve(r)}")`).join(" ");
  let profile = "(version 1)\n(allow default)\n(deny file-write*)\n";
  profile += `(allow file-write* ${subpaths(p.writeRoots)})\n`;
  profile += '(allow file-write* (literal "/dev/null") (literal "/dev/tty") ' +
    '(literal "/dev/stdout") (literal "/dev/stderr"))\n';
  const home = homedir();
  if (home) {
    profile += `(deny file-read* (subpath "${resolve(home)}"))\n`;
    profile += `(allow file-read* ${subpaths(p.readRoots)})\n`;
  }
  if (!p.allowNetwork) profile += "(deny network*)\n";
  return profile;
}

function shellArgv(command, sandbox) {
  const wrapped = `(${command}) 2>&1`;
  if (sandbox) {
    const profile = buildSandboxProfile(sandbox);
    return ["/usr/bin/sandbox-exec", ["-p", profile, "/bin/sh", "-c", wrapped]];
  }
  return ["/bin/sh", ["-c", wrapped]];
}

function run(command, sandboxed) {
  const [file, argv] = shellArgv(command, sandboxed ? defaultSandboxPolicy() : null);
  try {
    const out = execFileSync(file, argv, { cwd: workDir });
    return [out.toString(), 0];
  } catch (err) {
    return [(err.stdout ?? Buffer.alloc(0)).toString(), err.status ?? 1];
  }
}

const available = sandboxAvailable();

test("sandbox allows cwd write", { skip: !available }, () => {
  const target = join(workDir, "sandbox-smoke.txt");
  try {
    const [out, code] = run("echo ok > sandbox-smoke.txt", true);
    assert.equal(code, 0, out);
  } finally {
    if (existsSync(target)) unlinkSync(target);
  }
});

test("sandbox allows tmp write", { skip: !available }, () => {
  const target = join(tmpdir(), "sandbox-smoke-tmp.txt");
  try {
    const [out, code] = run(`echo ok > ${target}`, true);
    assert.equal(code, 0, out);
  } finally {
    if (existsSync(target)) unlinkSync(target);
  }
});

test("sandbox blocks home write", { skip: !available }, () => {
  const target = join(homedir(), "smoke-should-fail.txt");
  try {
    const [out, code] = run(`echo pwned > ${target}`, true);
    assert.notEqual(code, 0, `家目录写入应当被拦: out=${out}`);
    assert.equal(existsSync(target), false, "文件不应该存在——命令报错但文件写成了？");
  } finally {
    if (existsSync(target)) unlinkSync(target);
  }
});

test("sandbox blocks secret read", { skip: !available }, () => {
  const [out, code] = run(`cat ${homedir()}/.zshrc`, true);
  assert.notEqual(code, 0, out);
});

test("sandbox blocks network", { skip: !available }, () => {
  const [out, code] = run("curl -s --max-time 3 https://example.com", true);
  assert.notEqual(code, 0, out);
});

test("no-sandbox control: home write succeeds", { skip: !available }, () => {
  const target = join(homedir(), "smoke-control.txt");
  try {
    const [out, code] = run(`echo control > ${target}`, false);
    assert.equal(code, 0, `不开沙箱时家目录写入应当成功: out=${out}`);
  } finally {
    if (existsSync(target)) unlinkSync(target);
  }
});
