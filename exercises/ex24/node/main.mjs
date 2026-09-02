// Learn Agent the Hard Way — 练习 24：用户界面——从单次调用到常驻对话
//
// 前二十三章的进程都是一句话一条命：从命令行接一个任务，跑完，退出。
// 这一章把它改成常驻：读一行、跑一轮、回到读一行，中间的会话、注册表、
// 沙箱边界全部原地不动地活着。代价是三件以前不存在的事：谁来读标准输入
// （只能有一个读者），跑到一半怎么喊停，以及喊停之后历史怎么收拾（打断
// 会把对话停在协议不允许的位置）。
//
// 语言差异先说在最前面：Go 版用 context.Context 把取消信号一路传进
// bash 子进程和 HTTP 请求内部。这一版 JavaScript 能做到"真正取消一个
// 还没返回的 fetch()"——AbortController 是 fetch 原生支持的机制，SIGINT
// 一来就 abort()，请求立刻中断，这一点比 Python 的 urllib 更接近 Go。
// 但 bash 这条路完全相反：execFileSync 是同步阻塞调用，会独占 Node
// 唯一的这一个线程——命令没跑完之前，包括 SIGINT 的回调在内，任何 JS
// 代码都没有机会运行，所以一个卡住的 bash 命令在这一版里反而是三种
// 语言里最难打断的。这两处不一致不是疏漏，是分别诚实反映了 fetch 和
// execFileSync 在 Node 里的真实能力边界，"发生了什么"里有真机实测。
import { readFileSync, writeFileSync, appendFileSync, existsSync, readSync, mkdirSync, readdirSync, realpathSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { basename, join } from "node:path";
import { homedir, tmpdir } from "node:os";

// ---- 工具层 ----
// 每个工具是一个类，两个方法：一份给模型看的声明（definition），
// 一个真正干活的函数（execute）。octo 里同名接口也是这两个方法——
// 这不是巧合，是这件事的最小形状。

// ReadFileTool 就是练习 5 的 read_file，装进类的壳。
class ReadFileTool {
  definition() {
    return {
      name: "read_file",
      description: "读取一个本地文件，返回它的文本内容。修改文件前必须先用它读一遍。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "要读取的文件路径" },
        },
        required: ["path"],
      },
    };
  }

  execute(args) {
    let params;
    try {
      params = JSON.parse(args);
    } catch (err) {
      return "错误: 参数不是合法 JSON: " + err.message;
    }
    try {
      return readFileSync(params.path ?? "", "utf-8");
    } catch (err) {
      return "错误: " + err.message;
    }
  }
}

// WriteFileTool 整个写入一个文件（不存在则创建，存在则覆盖）。
class WriteFileTool {
  definition() {
    return {
      name: "write_file",
      description: "把内容完整写入一个文件。文件不存在就创建，存在就整个覆盖。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "目标文件路径" },
          content: { type: "string", description: "要写入的完整内容" },
        },
        required: ["path", "content"],
      },
    };
  }

  execute(args) {
    let params;
    try {
      params = JSON.parse(args);
    } catch (err) {
      return "错误: 参数不是合法 JSON: " + err.message;
    }
    const path = params.path ?? "";
    const content = params.content ?? "";
    let backup;
    try {
      backup = backupIfExists(path);
    } catch (err) {
      return "错误: 备份旧内容失败，为安全起见拒绝覆盖: " + err.message;
    }
    try {
      writeFileSync(path, content);
    } catch (err) {
      return "错误: " + err.message;
    }
    // content.length 是字符数不是字节数——中文会对不上，按 UTF-8 编码后再数
    const size = Buffer.byteLength(content, "utf-8");
    if (backup) return `已把旧内容备份到 ${backup}，然后写入 ${path}（${size} 字节）`;
    return `已写入 ${path}（${size} 字节）`;
  }
}

// EditFileTool 精确替换文件中的一段文本。octo 的设计原样蒸馏：
// old_string 必须在文件里恰好出现一次——多了说明定位不唯一，少了说明找错了，
// 两种都拒绝执行。这比"按行号改"可靠得多：行号在模型的记忆里会漂，原文不会。
class EditFileTool {
  definition() {
    return {
      name: "edit_file",
      description: "在已有文件里做一次精确替换。old_string 必须与文件现有内容逐字一致，" +
        "且只出现一次——不唯一时请带上足够的上下文再试。文件必须已存在（创建用 write_file）。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "目标文件路径" },
          old_string: { type: "string", description: "要找到的原文，必须唯一" },
          new_string: { type: "string", description: "替换成的新文本，可以为空（等于删除）" },
        },
        required: ["path", "old_string", "new_string"],
      },
    };
  }

  execute(args) {
    let params;
    try {
      params = JSON.parse(args);
    } catch (err) {
      return "错误: 参数不是合法 JSON: " + err.message;
    }
    const path = params.path ?? "";
    const oldStr = params.old_string ?? "";
    const newStr = params.new_string ?? "";
    let text;
    try {
      text = readFileSync(path, "utf-8");
    } catch (err) {
      return "错误: " + err.message;
    }
    if (oldStr === "") return "错误: old_string 不能为空";
    const n = text.split(oldStr).length - 1;
    if (n === 0) return "错误: old_string 在文件里找不到——和 read_file 看到的原文逐字对一下";
    if (n > 1) return `错误: old_string 出现了 ${n} 次，无法确定改哪一处——多带几行上下文让它唯一`;
    try {
      writeFileSync(path, text.replace(oldStr, newStr));
    } catch (err) {
      return "错误: " + err.message;
    }
    return "已替换 " + path + " 中的一处文本";
  }
}

// ---- bash：特权工具 ----

// 超时是双层的：不传用默认值，传了也有上限——上限保护的是你，不是模型。
const DEFAULT_BASH_TIMEOUT = 30; // 秒
const MAX_BASH_TIMEOUT = 120;    // 秒
const MAX_BASH_OUTPUT = 8 * 1024; // 字节。工具结果会原样进上下文，必须封顶

// workDir 在启动时定死。每次 bash 调用都是一个全新进程，
// 模型在命令里 cd 到哪里，都随那个进程一起消失——工作目录由 harness 持有。
const workDir = process.cwd();

// ---- 沙箱层：OS 强制的执行边界 ----

// activeSandbox 非 null 时，每一条 bash 命令都在笼子里跑。默认 null——
// 沙箱是显式开启的（-sandbox），不是默认值。原因在"网络"这一刀上：
// 断网是全有全无的开关（见 buildSandboxProfile），默认开沙箱等于默认
// 弄坏一切要联网的命令（npm install、git fetch、pip install），权限
// 系统 + 人工确认才是常开的那道闸。
let activeSandbox = null;

// defaultSandboxPolicy 是标准笼子：可写的只有工作目录和临时目录；可读的
// 加上系统目录（跑普通命令要用的工具链、动态库、配置都在里面）；网络
// 关闭。家目录整体不在可读名单里——~/.ssh、~/.aws、~/.config 这些密钥
// 重灾区因此碰不到，这正是要保护的东西。
function defaultSandboxPolicy() {
  const tmp = tmpdir();
  return {
    readRoots: [workDir, tmp, "/usr", "/bin", "/sbin", "/etc", "/var",
      "/private", "/System", "/Library", "/opt"],
    writeRoots: [workDir, tmp],
    allowNetwork: false,
  };
}

// sandboxAvailable 报告这台机器能不能强制执行沙箱。本章的实现用 macOS
// 自带的 sandbox-exec；Linux 上 octo 用的是内核的 Landlock + seccomp，
// 实现要多一层自我重执行的技巧，本书不展开。
function sandboxAvailable() {
  if (process.platform !== "darwin") return false;
  return existsSync("/usr/bin/sandbox-exec");
}

// buildSandboxProfile 把 policy 翻译成 macOS 沙箱的规则语言（SBPL，一种
// 括号风格的小语言）。底座是 allow default——全默认禁止的配置会让普通
// 程序连动态库都加载不了，根本跑不起来；在放行的底座上，只收紧我们
// 关心的三个口子：写先全禁再放行 writeRoots；读把家目录整体禁掉再放行
// readRoots；网一刀切断，除非 allowNetwork。路径先解析符号链接再写进
// 规则：macOS 的 /tmp 实际是 /private/tmp 的链接，内核检查的是真实
// 路径，规则里写链接路径等于没写。
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

// shellArgv 是全 harness 唯一一处把命令字符串变成 shell 进程参数的地方。
// 沙箱开着就包一层 sandbox-exec，关着就是原来那个 /bin/sh -c。以后任何
// 新的执行路径都必须从这个函数走——笼子只有装在唯一的门上才算数。返回
// [文件, 参数数组] 一对，配合 execFileSync 使用而不是 execSync：参数不
// 经过 shell 再解析一遍，sandbox-exec 后面那几个参数（尤其是 profile
// 里的换行和引号）不会被 shell 误解析。
function shellArgv(command) {
  const wrapped = `(${command}) 2>&1`;
  if (activeSandbox) {
    const profile = buildSandboxProfile(activeSandbox);
    return ["/usr/bin/sandbox-exec", ["-p", profile, "/bin/sh", "-c", wrapped]];
  }
  return ["/bin/sh", ["-c", wrapped]];
}

class BashTool {
  definition() {
    return {
      name: "bash",
      description: "在系统 shell 里运行一条命令，返回 stdout 和 stderr。" +
        "命令总是在固定的工作目录执行，cd 不会跨调用生效。" +
        "默认 30 秒超时；预计更久就传 timeout（整数秒，上限 120）。" +
        "能用 read_file / write_file / edit_file 完成的事，优先用那些专用工具。",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "要执行的 shell 命令" },
          timeout: { type: "integer", description: "超时秒数，可选，默认 30，上限 120" },
        },
        required: ["command"],
      },
    };
  }

  execute(args) {
    let params;
    try {
      params = JSON.parse(args);
    } catch (err) {
      return "错误: 参数不是合法 JSON: " + err.message;
    }
    const command = params.command ?? "";
    if (!command.trim()) return "错误: command 不能为空";
    let d = DEFAULT_BASH_TIMEOUT;
    if (params.timeout > 0) {
      d = params.timeout;
      if (d > MAX_BASH_TIMEOUT) {
        return `错误: timeout 最大 ${MAX_BASH_TIMEOUT} 秒。` +
          "要跑更久的命令，把它拆小，或者放弃在一次调用里等它";
      }
    }

    // execSync 没有 Go CombinedOutput 那种"stdout/stderr 合流"的选项，
    // 用子 shell 的 `2>&1` 在 shell 层面把两路合成一路，效果等价。改用
    // execFileSync（不经过一层 shell 解析整条命令行）是为了配合
    // shellArgv：沙箱开启时 sandbox-exec 后面的 profile 参数原样传给
    // 子进程，不会被 shell 再解析一遍。
    const [file, argv] = shellArgv(command);
    try {
      const out = execFileSync(file, argv, {
        cwd: workDir,
        timeout: d * 1000,
        maxBuffer: 64 * 1024 * 1024,
      });
      const text = tail(out, MAX_BASH_OUTPUT);
      return text === "" ? "(命令成功，无输出)" : text;
    } catch (err) {
      const text = tail(err.stdout ?? Buffer.alloc(0), MAX_BASH_OUTPUT);
      if (err.signal) {
        // 被杀也要把已产生的输出交回去——死前的输出往往就是死因。
        return `错误: 命令超过 ${d} 秒被终止。被杀前的输出：\n${text}`;
      }
      // 非零退出不是异常，是情报：让模型自己读 exit code 和错误输出。
      return `${text}\n[exit status ${err.status}]`;
    }
  }
}

// tail 超长时保留结尾——命令的结论和报错几乎总在最后，开头多半是刷屏。
// 在字节层面截断（跟 write_file 的字节计数是同一个讲究），最后才解码成字符串。
function tail(buf, maxBytes) {
  if (buf.length <= maxBytes) return buf.toString("utf-8");
  const cut = buf.subarray(buf.length - maxBytes);
  const i = cut.indexOf(0x0a); // "\n"
  const trimmed = i >= 0 ? cut.subarray(i + 1) : cut; // 对齐到整行，别吐半截行
  const skipped = buf.length - trimmed.length;
  return `[... 前面 ${skipped} 字节被截断，只保留结尾 ...]\n${trimmed.toString("utf-8")}`;
}

// ---- 权限层：拦下危险命令 ----

// decision 是权限检查的结论，档位从低到高：allow < ask < deny。
const DECISION_ALLOW = 0;
const DECISION_ASK = 1;
const DECISION_DENY = 2;

// BASH_RULES 蒸馏自 octo 的 internal/permission/defaults.yml——声明顺序不重要，
// 重要的是档位：deny 赢 ask，ask 赢 allow。一条规则都没命中时，隐式默认是
// ask——宁可多问一句，不要放过一个没见过的命令。
const BASH_RULES = [
  ["rm -rf /", DECISION_DENY],
  ["rm -rf ~", DECISION_DENY],
  ["rm -rf", DECISION_ASK],
  ["sudo ", DECISION_ASK],
  ["git push --force", DECISION_ASK],
  ["curl ", DECISION_ASK],
  ["ls", DECISION_ALLOW],
  ["cat ", DECISION_ALLOW],
  ["pwd", DECISION_ALLOW],
  ["echo ", DECISION_ALLOW],
  ["git status", DECISION_ALLOW],
];

// classifyBash 给一条 shell 命令分档。分三遍独立扫描，而不是一遍碰到就返回，
// 就是为了让"deny 赢 ask 赢 allow"这件事跟规则声明的先后顺序无关。
function classifyBash(cmd) {
  for (const [pattern, decide] of BASH_RULES) {
    if (decide === DECISION_DENY && cmd.includes(pattern)) return DECISION_DENY;
  }
  for (const [pattern, decide] of BASH_RULES) {
    if (decide === DECISION_ASK && cmd.includes(pattern)) return DECISION_ASK;
  }
  const trimmed = cmd.replace(/^[ \t]+/, "");
  for (const [pattern, decide] of BASH_RULES) {
    if (decide !== DECISION_ALLOW || !cmd.includes(pattern)) continue;
    // allow 比 deny/ask 挑剔：命令必须以这个词开头，且整条命令里不能有
    // shell 的链接符号——否则 "ls && rm -rf /" 会被 "ls" 这条规则放行。
    if (trimmed.startsWith(pattern) && !containsShellChain(cmd)) return DECISION_ALLOW;
  }
  return DECISION_ASK;
}

// containsShellChain 检查命令里有没有把一条命令接到另一条上的符号。
function containsShellChain(cmd) {
  return /[;|&$()`\n]/.test(cmd);
}

// Node 没有内置的"同步读一行"（readline 是异步的），用 fs.readSync 在 fd 0
// 上按字节读到换行符自己攒——效果跟 Go 的 bufio.NewReader(os.Stdin).ReadString('\n')
// 一样。EAGAIN 是终端 stdin 偶发的非阻塞信号，重试即可，不代表读到了内容。
//
// n===0 是真正的流结束（Ctrl+D、管道关闭），跟"用户敲了个空行就回车"
// 长得一样——都是"这一行没有字符"。区分靠时机：如果这次 n===0 发生在
// 一个字符都还没攒到的时候，就是纯粹的 EOF，返回 null；如果是攒了几个
// 字符之后才碰到流结束（最后一行没有换行符），先把这几个字符原样交
// 回去，下一次调用再返回 null——这一区分是这一章才需要：练习 9 的
// confirm() 从不区分"读不到"和"空答案"，两者都按拒绝处理，这一章的
// repl 第一次需要知道"到底是不是该退出了"。
function readLineSync() {
  const buf = Buffer.alloc(1);
  const chunks = [];
  for (;;) {
    let n;
    try {
      n = readSync(0, buf, 0, 1);
    } catch (err) {
      if (err.code === "EAGAIN") continue;
      return null; // 读不到（没有终端、输入已关闭等）
    }
    if (n === 0) return chunks.length === 0 ? null : Buffer.from(chunks).toString("utf-8");
    if (buf[0] === 0x0a) break; // '\n'
    chunks.push(buf[0]);
  }
  return Buffer.from(chunks).toString("utf-8");
}

// confirm 停下来问人，不是问模型——危险命令要过这一关，模型自己怎么想
// 不算数。读不到回答（比如脚本化调用、没有终端）一律按拒绝处理，安全
// 边界宁可保守，不能因为读不到输入就放行。练习 9 只拿它拦 bash；这一章
// 把它从 askApproval 里剥出来单独命名，因为要拦的不只是命令了。
function confirm(prompt) {
  process.stderr.write(`\n⚠️  ${prompt}\n允许吗？(y/N) `);
  const line = readLineSync();
  if (line === null) return false;
  const answer = line.trim().toLowerCase();
  return answer === "y" || answer === "yes";
}

// askApproval 是 confirm 在 bash 场景下的老名字，练习 9 的调用点不用改。
function askApproval(cmd) {
  return confirm(`模型想执行: ${cmd}`);
}

function commandOf(args) {
  try {
    return JSON.parse(args)?.command ?? "";
  } catch {
    return "";
  }
}

// ---- 备份层：覆盖前留一份 ----

// TRASH_DIR 是备份落地的地方，就在工作目录底下——足够找、足够简单，
// 不需要 octo 真实实现里那套按项目哈希分桶的复杂结构。
const TRASH_DIR = ".trash";

// timestamp 拼一个跟 Go 的 time.Now().Format("20060102-150405") 等价的
// 本地时间戳——JavaScript 没有内置的 strftime，手动补零拼字符串。
function timestamp() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

// backupIfExists 在覆盖一个已存在的文件前，把旧内容原样复制进 TRASH_DIR，
// 文件名前缀时间戳避免撞名。目标文件本来就不存在时什么都不做，返回空字符串
// ——没有"旧版本"可备份。这是覆盖前的最后一步，不是覆盖的替代品：
// write_file 该做的事一件没少，只是多了一份退路。
function backupIfExists(path) {
  if (!existsSync(path)) return "";
  mkdirSync(TRASH_DIR, { recursive: true });
  const data = readFileSync(path); // 不传 encoding，读出 Buffer，原样复制不经过文本解码
  const dest = join(TRASH_DIR, `${timestamp()}_${basename(path)}`);
  writeFileSync(dest, data);
  return dest;
}

// restore 找 TRASH_DIR 里这个文件名最新的一份备份，写回原路径。恢复动作
// 本身也先给"现在这份"备份一次——误删保护对自己也生效，不会因为你手滑
// 恢复错了版本就白白丢掉当前内容。
function restore(path) {
  let entries;
  try {
    entries = readdirSync(TRASH_DIR);
  } catch (err) {
    console.error(`错误: 没有找到 ${TRASH_DIR} 目录，或读取失败: ${err.message}`);
    return 1;
  }
  const suffix = "_" + basename(path);
  let newest = "";
  for (const name of entries) {
    if (name.endsWith(suffix) && name > newest) newest = name;
  }
  if (!newest) {
    console.error(`错误: ${TRASH_DIR} 里没有 ${basename(path)} 的备份`);
    return 1;
  }
  try {
    backupIfExists(path);
  } catch (err) {
    console.error(`错误: 备份当前版本失败，为安全起见拒绝恢复: ${err.message}`);
    return 1;
  }
  const src = join(TRASH_DIR, newest);
  try {
    writeFileSync(path, readFileSync(src));
  } catch (err) {
    console.error(`错误: ${err.message}`);
    return 1;
  }
  console.log(`已从 ${src} 恢复到 ${path}`);
  return 0;
}

// ---- 注册表层 ----

// Registry 按名字分发工具调用，并在这一层安装横切纪律。
// 纪律装在注册表而不是某个工具里，因为它管的是工具**之间**的关系。
class Registry {
  constructor(...tools) {
    // Go 版要单独存一份 order 切片保持声明顺序（map 遍历是乱序的）；
    // JavaScript 的 Map 自带插入序，这个字段直接省了。
    this.tools = new Map();
    this.hasRead = new Set(); // read-before-write 记录：这个会话里读过哪些文件
    for (const t of tools) this.tools.set(t.definition().name, t);
  }

  // definitions 生成发给模型的 tools 数组。
  definitions() {
    return [...this.tools.values()].map((t) => ({
      type: "function",
      function: t.definition(),
    }));
  }

  // execute 查表分发。改文件的调用先过 read-before-write 检查：
  // 没读过就想改一个已存在的文件？拒绝——模型会先去读，然后带着事实回来。
  // bash 调用还要多过一关：权限检查。这一关不问模型愿不愿意，
  // deny 直接拒绝、ask 停下来问人——两种情况下面这行 t.execute 都不会被跑到，
  // 真正跑 execSync 的代码，危险命令根本够不着。
  // sub_agent 的 execute 是异步的（内部要发网络请求），所以这层查表分发
  // 也跟着是 async——其余工具的 execute 都是同步返回一个字符串，await
  // 一个非 Promise 值本来就是安全的，不用为它们单独分叉一条同步路径。
  async execute(name, args) {
    const t = this.tools.get(name);
    if (!t) return "错误: 未知工具 " + name;
    if (name === "write_file" || name === "edit_file") {
      const path = pathOf(args);
      if (path && existsSync(path) && !this.hasRead.has(path)) {
        return "错误: " + path + " 已存在但这个会话里还没读过它。先用 read_file 看一眼，再来修改。";
      }
      if (path.startsWith(SKILLS_ROOT + "/")) {
        // 生效目录，见 SKILL_AUTHORING_GUIDANCE 那段规矩：写进这里的
        // 东西下一轮就会算进清单的 token 账，这不是模型一个人能拍板
        // 的事——跟练习 9 的 bash ask 档同一个道理，同一个函数。
        if (!confirm("模型想把一份 skill 写进生效目录：" + path)) {
          return "错误: 权限拒绝——写入生效的 skill 目录需要用户批准，这次没有批准。";
        }
      }
    }
    if (name === "bash") {
      const cmd = commandOf(args);
      const decision = classifyBash(cmd);
      if (decision === DECISION_DENY) {
        return "错误: 权限拒绝——这条命令匹配了硬性禁止规则，不会执行，也不会询问。";
      }
      if (decision === DECISION_ASK && !askApproval(cmd)) {
        return "错误: 权限拒绝——用户没有批准这条命令。";
      }
    }
    const result = await t.execute(args);
    // 调用成功就记账：读过的文件可以改；刚写完的文件模型知道最新内容，也算读过。
    const path = pathOf(args);
    if (path && !result.startsWith("错误:")) this.hasRead.add(path);
    // skill 正文加载这一刻才真的花钱：清单那笔账每轮都付，这笔账只在
    // 被点名的这一轮付一次——两笔账分开打印，账本上的数字自己会说话。
    if (name === "skill" && !result.startsWith("错误:")) {
      console.error(`[skill 正文进入对话：约 ${estimateText(result)} tokens，只这一轮付这笔账]`);
    }
    return result;
  }
}

function pathOf(args) {
  try {
    return JSON.parse(args)?.path ?? "";
  } catch {
    return "";
  }
}

// ---- base prompt：给模型的说明书 ----

// BASE_PROMPT 蒸馏自 octo 的 internal/prompt/base.md——生产 harness 里
// 模型真实读到的规矩，这里只留下和我们这四个工具相关的几条。
// 它坐进 history 第 0 位的 system 消息，练习 3 你已经知道这个位置；
// 没讲过的是：为什么内容从此定死，一个字都不该在会话中途改。
const BASE_PROMPT = `你是一个能操作本地文件和 shell 的助手，通过工具真正执行动作，而不是描述打算做什么。

- 能用 read_file / write_file / edit_file 完成的事，优先用它们；bash 留给专用工具做不到的事（跑测试、跑 git、装依赖、查系统信息）。
- 修改一个已经存在的文件前，必须先用 read_file 读过它一遍——这条规矩不因为你换了工具执行修改就不算数：用 bash 的 echo / sed / tee 等方式直接改文件内容，同样要先读一遍再动手。能用 edit_file 完成的局部修改，优先用 edit_file 而不是 sed -i，这样改动会经过校验，而不是绕开它。
- 只做任务要求的改动，不顺手重构、不改无关代码。`;

// ---- 规则文件层：项目自己的约定 ----

// PROJECT_RULES_FILE 蒸馏自 octo 的 ProjectContextFile（.octorules）——
// 每个项目自己的行为约定，跟 BASE_PROMPT 那种"放之四海皆准"的规矩不同，
// 这份文件只对当前项目生效，随项目一起进版本库。
const PROJECT_RULES_FILE = ".harnessrules";

// readProjectRules 读工作目录下的 .harnessrules，文件不存在或读不出来
// 就返回空字符串——没有这份文件是完全正常的状态，不是错误。
function readProjectRules() {
  try {
    return readFileSync(PROJECT_RULES_FILE, "utf-8").trim();
  } catch {
    return "";
  }
}

// ---- 记忆层：模型自己维护的跨会话笔记 ----

// MEMORY_FILE 蒸馏自 octo 的 MEMORY.md——但只留最小的那一部分：一个项目
// 一份文件，本章不做 octo 真实实现里的按仓库分目录、跨项目继承、200 行/25KB
// 截断预算，够用就好，把"跨会话"这一件事立住是这一章的唯一目的。
const MEMORY_FILE = "MEMORY.md";

// readMemory 读工作目录下的 MEMORY.md，文件不存在就返回空字符串——
// 全新项目还没写过这份文件，这是正常状态，不是错误。
function readMemory() {
  try {
    return readFileSync(MEMORY_FILE, "utf-8").trim();
  } catch {
    return "";
  }
}

// MEMORY_GUIDANCE 是这一层唯一新增的"规矩"，蒸馏自 octo 真实的 memory 注入
// 说明：MEMORY.md 是什么、什么值得写、用什么工具写。这段话不因文件是否
// 存在而变化——第一次跑到这个项目，模型也要知道有这么个地方能写。
// 全书唯一一处故意不新增专用工具的地方：记东西用 write_file，改错一条、
// 删掉一条用 edit_file——和练习 6 已经有的工具是同一套，没有专门的
// remember/forget。
const MEMORY_GUIDANCE = `# 跨会话记忆 (${MEMORY_FILE})

${MEMORY_FILE} 是你自己维护的记忆文件，不是这次任务的草稿。这次任务
结束后，下一次全新会话——不是用 -c 续接这一次，是完全重新开始的下一次
——会在系统提示里重新读到你现在写下的内容。

- 值得写：用户明确要求记住的偏好、和默认做法不一样的项目约定、你自己
  验证过、以后大概率还用得上的结论。不值得写：这次任务本身的中间状态、
  代码改动的具体内容——那些内容已经在文件和 git 历史里，不需要在这里
  重复一份。
- 没有专门的"记住"或"忘记"工具。${MEMORY_FILE} 就是一个普通文件：
  想写新的用 write_file，想改一条用 edit_file，想删掉一条也是 edit_file
  ——记错一件事和改错一行代码，是同一种操作，用同一套工具。
- 引用这份文件里的内容之前，先确认它现在还成立——项目会变，你之前记下
  的事，不保证放到现在还是真的。`;

// ---- skill 层：写在磁盘上、按需读的说明书 ----

// SKILLS_ROOT 蒸馏自 octo 的三层发现（default/user/project），本章只留
// 最简单的一层——一个项目一个目录，够用就好：这一章要立住的是"发现 +
// 注入"这一件事，不是完整的优先级覆盖体系。
const SKILLS_ROOT = ".harness-skills";

// Skill 是一份发现到的说明书。body 是正文——只有模型真的调用 skill 工具
// 要来的时候才会离开磁盘、进入对话。
class Skill {
  constructor(name, description, body, dir) {
    this.name = name;
    this.description = description;
    this.body = body;
    this.dir = dir;
  }
}

// discoverSkills 扫 SKILLS_ROOT 下的每个子目录，读它的 SKILL.md。跟 octo
// 真实实现一样宽容：目录里没有 SKILL.md、frontmatter 缺 description，
// 就跳过这一个，不中断整个发现过程——一份写坏的说明书不该拖垮整个会话。
// 目录名是权威的 skill 名，frontmatter 里写的 name 只是给人看的，不参与
// 查找——这是 Claude Code 的行为，兼容它意味着别人写好的 skill 目录，
// 挪过来就能用。{ withFileTypes: true } 让每个条目自带 isDirectory()，
// 不用再对每个名字单独 statSync 一次——跟 Go os.ReadDir 返回的 DirEntry
// 是同一个讲究。
function discoverSkills() {
  const out = new Map();
  let entries;
  try {
    entries = readdirSync(SKILLS_ROOT, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(SKILLS_ROOT, entry.name);
    let data;
    try {
      data = readFileSync(join(dir, "SKILL.md"), "utf-8");
    } catch {
      continue;
    }
    const { description, body, ok } = parseSkillFile(data);
    if (!ok || !description) continue;
    out.set(entry.name, new Skill(entry.name, description, body, dir));
  }
  return out;
}

// parseSkillFile 切开一份 SKILL.md：开头一对 "---" 之间是 frontmatter，
// 之后是正文。frontmatter 只认一行一个 "key: value"，够用就好——真正的
// Claude Code 格式用 yaml 库解析、能处理嵌套 metadata 块，这里手写的
// 是一个只够识别 description 的子集，其余字段（allowed-tools、license
// 之类）原样跳过，不报错也不生效。
function parseSkillFile(text) {
  const lines = text.split("\n");
  if (lines.length === 0 || lines[0].trim() !== "---") {
    return { description: "", body: "", ok: false };
  }
  let description = "";
  let i = 1;
  for (; i < lines.length; i++) {
    if (lines[i].trim() === "---") break;
    const idx = lines[i].indexOf(":");
    if (idx >= 0 && lines[i].slice(0, idx).trim() === "description") {
      description = lines[i].slice(idx + 1).trim();
    }
  }
  if (i >= lines.length) return { description: "", body: "", ok: false }; // 没找到闭合的 "---"，frontmatter 不完整
  const body = lines.slice(i + 1).join("\n").trim();
  return { description, body, ok: true };
}

// skillManifest 渲染 L1 清单：每个 skill 只留名字和 description，这是
// 模型判断"要不要用这个 skill"的唯一依据。正文不放这里——清单要塞进
// 冻结的 system prompt，多数任务用不上大多数 skill，正文太贵，全塞进去
// 不划算，留给 skill 工具按需加载才是这一层存在的意义。
function skillManifest(skills) {
  if (skills.size === 0) return "";
  const lines = ["# 可用的 skill", "",
    "任务匹配某条 description 时，先调用 skill 工具（参数 name）加载完整指令再动手" +
    "——不要只凭这一句描述去猜正文写了什么。", ""];
  // 顺序必须稳定，否则清单文本每次不同，缓存前缀跟着作废
  for (const name of [...skills.keys()].sort()) {
    lines.push(`- ${name}: ${skills.get(name).description}`);
  }
  return lines.join("\n").trim();
}

// SkillTool 是 L2：清单只给名字和一句话，正文才是真正的指令，只有模型
// 点名要用了才发。它需要访问这次进程发现到的 skills，不能像 ReadFileTool
// 那样是无状态的，所以带一个字段。
class SkillTool {
  constructor(skills) {
    this.skills = skills;
  }

  definition() {
    return {
      name: "skill",
      description: "加载一个 skill 的完整指令。先看系统提示里“可用的 skill”清单，" +
        "任务匹配某条 description 时，用这个工具把对应 skill 的正文加载进来再动手。",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "要加载的 skill 名字，清单里“-”后面那个词" },
        },
        required: ["name"],
      },
    };
  }

  execute(args) {
    let params;
    try {
      params = JSON.parse(args);
    } catch (err) {
      return "错误: 参数不是合法 JSON: " + err.message;
    }
    const name = params.name ?? "";
    const sk = this.skills.get(name);
    if (!sk) return "错误: 没有叫 " + name + " 的 skill——从系统提示的清单里选一个";
    return `[skill "${sk.name}"，所在目录：${sk.dir}]\n\n${sk.body}`;
  }
}

// SKILLS_PROPOSED_ROOT 是自动写 skill 的落地位置，刻意不是 SKILLS_ROOT。
// discoverSkills 只扫 SKILLS_ROOT，这个目录里的东西不会进清单、不会占
// 任何一轮的 token，直到人用 bash mv 把它挪进 SKILLS_ROOT 才生效——
// "写"和"生效"从代码层面就是两个不同的目录，不是靠模型自觉。
const SKILLS_PROPOSED_ROOT = ".harness-skills-proposed";

// SKILL_AUTHORING_GUIDANCE 把练习 15 那条教训换到 skill 头上：生成不难，
// 回收才是问题。这段规矩不因任何条件变化——即使这个项目现在一个 skill
// 都没有，模型也要知道"写草稿"和"生效"是两个目录、两件事，不是写一次
// write_file 就完事的同一步。
const SKILL_AUTHORING_GUIDANCE = `# 想沉淀新 skill 时

如果你判断一类任务以后会反复出现，值得写成一份新 skill 供下次复用——
可以写，但不要直接写进 "${SKILLS_ROOT}/<name>/SKILL.md"：那个目录
里的每一份 SKILL.md，只要存在，description 就会被打进清单，从下一轮起
每一轮对话都要为它多付一点 token，不管这一轮用不用得上。

草稿写到 "${SKILLS_PROPOSED_ROOT}/<name>/SKILL.md"，格式跟正式 skill
完全一样。这个目录不会被扫描、不会出现在清单里，写多少份草稿都不花一分
钱。写完之后告诉用户你觉得这份草稿值得转正，一句话说清楚它是什么、什么
时候该用——要不要挪进 "${SKILLS_ROOT}/" 生效，由用户决定，不是你。`;

// composeSystemPrompt 把 BASE_PROMPT、项目规则、skill 清单、记忆拼成一份
// system prompt，蒸馏自 octo Compose 的分层方式：每层之间用同一个分隔符
// 隔开，某一层没有内容就跳过那一层。这份拼好的文字，从会话创建那一刻起
// 冻结——练习 8 讲过为什么：中途改一个字，隐式缓存就整条作废。
function composeSystemPrompt(skills) {
  let prompt = BASE_PROMPT;
  const rules = readProjectRules();
  if (rules) prompt += "\n\n---\n\n# 项目约定 (" + PROJECT_RULES_FILE + ")\n\n" + rules;
  const manifest = skillManifest(skills);
  if (manifest) prompt += "\n\n---\n\n" + manifest;
  prompt += "\n\n---\n\n" + SKILL_AUTHORING_GUIDANCE;
  prompt += "\n\n---\n\n" + MEMORY_GUIDANCE;
  const mem = readMemory();
  if (mem) {
    prompt += "\n\n## 你目前记下的内容\n\n" + mem;
  } else {
    prompt += "\n\n## 你目前记下的内容\n\n（还是空的——这是这个项目第一次有你可读的记忆）";
  }
  return prompt;
}

// ---- 预算层：知道自己还有多少余地 ----

// contextWindow 返回一个模型的上下文窗口大小（token 数），蒸馏自 octo 里
// 一张更大的模型-窗口对照表——按名字子串匹配，匹配不到就退回保守的默认值。
// 宁可低估：低估最多让你提前一点行动，高估会让你真的撑爆上下文。
function contextWindow(model) {
  const m = model.toLowerCase();
  if (m.includes("deepseek")) return 1_000_000;
  if (m.includes("gpt-4")) return 128_000;
  if (m.includes("claude")) return 200_000;
  return 128_000; // 不认识的模型，包括本机跑的大多数开源小模型
}

// effectiveContextWindow 让你在这一章的实验里用 CONTEXT_WINDOW 人为调小窗口。
// 真实模型的窗口大到几十上百万 token，正常聊天几十轮都撞不上；这一章想让你
// 在几轮之内亲眼看到预算告急，所以留了这个后门——不设就用 contextWindow 的
// 真实值，这不是在否定真实模型的窗口有多大，只是为了让实验能在你的终端里
// 几秒钟内跑完。
function effectiveContextWindow(model) {
  const v = process.env.CONTEXT_WINDOW;
  if (v) {
    const n = Number.parseInt(v, 10);
    if (Number.isInteger(n) && n > 0) return n;
  }
  return contextWindow(model);
}

// BUDGET_FRACTION 是触发警告的门槛——占窗口的 75%，蒸馏自 octo 的
// compactThresholdFraction：剩下的 25% 留给最近的对话尾巴和这一轮的输出。
const BUDGET_FRACTION = 0.75;

// checkBudget 拿这一轮 API 真实回报的 token 数（不是估算值——练习 11 你
// 已经知道 API 会把这个数字如实报回来）去跟窗口比，报告一句话，并且告诉
// 调用方要不要开始压缩。练习 12 这个函数只喊话；这一章多了返回值，
// 喊话之后，真的动手。
function checkBudget(usedTokens, window) {
  const pct = (usedTokens / window) * 100;
  console.error(`[预算：${usedTokens}/${window} tokens，${pct.toFixed(1)}%]`);
  const over = usedTokens >= window * BUDGET_FRACTION;
  if (over) {
    console.error(`⚠️  已用掉窗口的 ${pct.toFixed(0)}%，接近上限——开始压缩`);
  }
  return over;
}

// estimateTokens 是没有真实 token 数时的快速估算：ASCII 大约 4 个字符一个
// token，中文这类多字节字符大约 1.5 个字符一个 token——不是真正的分词器，
// 只是个够用的粗略数，在还没发出第一个请求、拿不到 API 真实回报之前，
// 先给自己一个数量级。
function estimateTokens(msgs) {
  let total = 0;
  for (const m of msgs) {
    total += estimateText(m.content ?? "");
    for (const tc of m.tool_calls ?? []) {
      total += estimateText(tc.function.name) + estimateText(tc.function.arguments);
    }
  }
  return total;
}

// for...of 按码点（code point）遍历字符串，跟 Go 按 rune 遍历是一回事——
// 不能用 s.length 或下标，那是按 UTF-16 单元数的，emoji 会被数成两个。
function estimateText(s) {
  let ascii = 0;
  let multi = 0;
  for (const ch of s) {
    if (ch.codePointAt(0) < 128) ascii++;
    else multi += Buffer.byteLength(ch, "utf-8");
  }
  return Math.floor(ascii / 4) + Math.floor(multi / 1.5 + 0.5);
}

// ---- 会话层：把 history 写到磁盘上 ----

// SESSION_DIR 是会话文件存放的地方，跟 .trash 一样就在工作目录底下。
const SESSION_DIR = ".sessions";

// Session 是一次对话的全部状态：一个 ID，加上完整的 history。persisted
// 记录 history 里前多少条消息已经写盘——save 只补写 persisted 之后新增的
// 部分，不是每次都把整个文件重写一遍。这是练习 11 的核心账本：存盘的代价
// 只跟"这一轮新增了多少条"有关，跟"这场对话已经聊了多久"无关。
// forceRewrite 是压缩加的：压缩会把 history 前半段整个换成一条摘要，
// 磁盘上原来那些行不再对应现在的内容，下次 save 不能只追加，得整个重写。
class Session {
  constructor(id, createdAt = "", history = []) {
    this.id = id;
    this.createdAt = createdAt;
    this.history = history;
    this.persisted = 0;
    this.forceRewrite = false;
  }

  // save 平时只追加 history[persisted:]；forceRewrite 被压缩置位之后，
  // 磁盘上的旧行不再可信，改成整个截断重写。没有新消息、也没被标记
  // forceRewrite 时是个空操作——一轮里模型只回了一句话，这次 save 什么都不写。
  save() {
    if (this.forceRewrite) return this.rewriteAll();
    if (this.history.length === this.persisted) return;
    return this.appendDelta();
  }

  // appendDelta 是练习 11 原来的 save：只补写 persisted 之后新增的部分。
  appendDelta() {
    const lines = this.history
      .slice(this.persisted)
      .map((msg) => encodeRecord({ type: "message", message: msg }))
      .join("");
    appendFileSync(sessionPath(this.id), lines);
    this.persisted = this.history.length;
  }

  // rewriteAll 截断文件，把 meta 和当前完整的 history 重新写一遍——压缩
  // 之后唯一正确的存盘方式：history 前半段的内容已经变了，追加只会把
  // 新旧两份摘要和原文混在一起。
  rewriteAll() {
    let lines = encodeRecord({ type: "meta", id: this.id, created_at: this.createdAt });
    for (const msg of this.history) lines += encodeRecord({ type: "message", message: msg });
    writeFileSync(sessionPath(this.id), lines);
    this.persisted = this.history.length;
    this.forceRewrite = false;
  }
}

// encodeRecord 把一条记录编成 JSONL 里的一行：紧凑、不换行、末尾补一个 \n。
function encodeRecord(rec) {
  return JSON.stringify(rec) + "\n";
}

// newSessionId 生成 时间戳-随机后缀 形式的 ID：时间戳让它天然按时间排序、
// 人眼可读；随机后缀避免同一秒内两个会话撞名。timestamp() 是练习 10 给
// .trash 备份写的那个，这里直接复用。
function newSessionId() {
  return timestamp() + "-" + randomBytes(4).toString("hex");
}

function sessionPath(id) {
  return join(SESSION_DIR, id + ".jsonl");
}

// newSessionFile 开一个新会话：建目录、写 meta 头，返回可以继续追加的 Session。
function newSessionFile(history) {
  mkdirSync(SESSION_DIR, { recursive: true });
  const s = new Session(newSessionId(), new Date().toISOString(), history);
  let lines = encodeRecord({ type: "meta", id: s.id, created_at: s.createdAt });
  for (const msg of history) lines += encodeRecord({ type: "message", message: msg });
  writeFileSync(sessionPath(s.id), lines);
  s.persisted = history.length;
  return s;
}

// loadSession 读一份 JSONL，把 meta 和 message 记录重放回 history。
// 最后一行如果不完整（进程写到一半时被杀），就连同它一起丢掉——
// 半条消息比没有消息更危险：模型会把它当成一条完整的历史来读，
// 而它实际上什么都不是。
function loadSession(id) {
  let data = readFileSync(sessionPath(id)); // 不传 encoding，先在字节层面找换行符
  const n = data.lastIndexOf(0x0a); // "\n"
  data = n >= 0 ? data.subarray(0, n + 1) : Buffer.alloc(0);

  const s = new Session(id);
  for (const line of data.toString("utf-8").split("\n")) {
    if (line === "") continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch (err) {
      throw new Error(`会话文件损坏: ${err.message}`);
    }
    if (rec.type === "meta") {
      s.createdAt = rec.created_at ?? "";
    } else if (rec.type === "message") {
      if (rec.message != null) s.history.push(rec.message);
    }
  }
  s.persisted = s.history.length;
  return s;
}

// ---- 压缩层：不丢消息，是让模型总结它自己 ----

// COMPACT_KEEP_FRACTION 压缩后留多少"最近尾巴"原样保留，蒸馏自 octo 的
// defaultCompactKeepFraction：占窗口的 30%，但封顶不超过触发阈值的一半——
// 保证一次压缩确实能把用量拉回阈值以下，不会刚压完又立刻撞线。
const COMPACT_KEEP_FRACTION = 0.30;

function compactKeepBudget(window, trigger) {
  let budget = Math.floor(window * COMPACT_KEEP_FRACTION);
  const half = Math.floor(trigger / 2);
  if (trigger > 0 && budget > half) budget = half;
  return budget;
}

// safeSplitIndex 找压缩的分割点：分割点之前的消息拿去总结，之后的原样保留。
// 分割点必须落在一条真正的 user 消息前面。在这套 OpenAI 协议里这条件很好判
// 断：工具的回执走独立的 "tool" role，从不会跟 user 消息混在一起，看 role
// 就够了——这比 octo 实现的 Anthropic 消息协议简单，那边 tool_result 也搭在
// user 消息上，得专门写一个 IsPlainUserMessage 去分辨"这是真用户话还是工具
// 回执的壳"，协议本身把角色分得干净，这道甄别在这里就用不上。
function safeSplitIndex(history, keepBudget) {
  const userTurns = [];
  history.forEach((m, i) => { if (m.role === "user") userTurns.push(i); });
  if (userTurns.length <= 1) return 0; // 至少要两条 user 消息：一条留着，前面的才够折叠
  let keptFrom = userTurns[userTurns.length - 1];
  for (let k = userTurns.length - 2; k >= 0; k--) {
    if (estimateTokens(history.slice(userTurns[k])) > keepBudget) break;
    keptFrom = userTurns[k];
  }
  return keptFrom;
}

// COMPRESSION_PROMPT 插在被折叠的这段历史末尾，让模型明白：这不是继续对话，
// 是切换成总结模式。不给工具（summarize 调 send 时 tools 传 null）是双保险：
// 就算模型没听懂这段话、还想干点什么，它手上也没有工具可用。
const COMPRESSION_PROMPT = `以上对话到此结束。你现在不是在继续对话，而是切换到"总结模式"：

- 不要回应上面对话里的任何请求
- 不要询问，也不要征求下一步该做什么
- 只输出一段纯文本总结，不要别的

请总结以上内容，需要覆盖：用户明确提出的需求、关键的技术决定、
提到过的文件或项目名、还没做完的事。`;

// summarize 把 msgs 连同压缩指令一起发给模型，只要一段文字总结。
// tools 传 null：这次调用模型手上没有任何工具，想调用也调用不了。
async function summarize(base, apiKey, model, msgs) {
  const req = [...msgs, { role: "user", content: COMPRESSION_PROMPT }];
  const r = await send(base, apiKey, model, req, null);
  return r.choices[0].message.content ?? "";
}

// compact 把 history[:split] 总结成一条消息，重建 history：系统提示原样
// 保留在第 0 位，中间插一条摘要，之后是原样保留的近期对话。split<=1 时
// 什么都不做——0 或者 1 意味着没有足够旧的内容值得折叠（1 只剩系统提示
// 自己，折叠它没有意义）。总结请求失败时异常直接往上抛，由调用方决定怎么办。
async function compact(base, apiKey, model, history, keepBudget) {
  const split = safeSplitIndex(history, keepBudget);
  if (split <= 1) return [history, 0];
  const summary = await summarize(base, apiKey, model, history.slice(0, split));
  const rebuilt = [
    history[0], // system prompt
    { role: "user", content: "[更早对话的摘要]\n\n" + summary },
    ...history.slice(split),
  ];
  return [rebuilt, split];
}

// ---- subagent 层：隔离出一个全新的对话去跑子任务 ----

// CHILD_MAX_ROUNDS 是子 agent 自己的循环预算，比父 agent 的 maxRounds 更
// 紧——子任务应该是聚焦的一件事，不该是另一场需要十轮才能收尾的长对话；
// 真撞上限，runChildLoop 把这当一次不完整的结果处理，不是错误。
const CHILD_MAX_ROUNDS = 6;

// runChildLoop 是子 agent 自己的一个迷你 agent loop：发请求、有
// tool_calls 就分发、没有就返回。故意不跟顶层那个大循环共用——
// 子 agent 不需要会话存盘（纯内存，这次调用完就没了）、不需要压缩
// （任务足够聚焦，轮数上限本身就比触发压缩的量级小得多）、也不需要
// resume。这些是"一场会话"才有的复杂度，子 agent 只是"发几轮请求，
// 拿到一个结论"，蒸馏自 octo 的说法：子 agent 的保活范围纯 in-memory，
// 生命周期只有一次调用，不写盘、不进 session、不跨进程。
async function runChildLoop(base, apiKey, model, reg, history) {
  let totalTokens = 0;
  for (let round = 1; round <= CHILD_MAX_ROUNDS; round++) {
    const r = await send(base, apiKey, model, history, reg.definitions());
    totalTokens += (r.usage?.prompt_tokens ?? 0) + (r.usage?.completion_tokens ?? 0);
    const choice = r.choices[0];
    const msg = choice.message;
    history.push(msg);
    if (choice.finish_reason !== "tool_calls") {
      return [msg.content ?? "", totalTokens, true];
    }
    for (const tc of msg.tool_calls ?? []) {
      const result = await reg.execute(tc.function.name, tc.function.arguments);
      history.push({ role: "tool", tool_call_id: tc.id, content: result });
    }
  }
  // 跑满轮数没个结论，不是异常——蒸馏自 octo 的 max-turns 处理：把最后
  // 一条内容当部分结果带回去，标记不完整，让父 agent 自己判断怎么办，
  // 而不是把半成品当成正常答案，也不是直接报错扔掉已经做的工作。
  const last = history[history.length - 1];
  return [last.content ?? "", totalTokens, false];
}

// SubAgentTool 是父 agent 唯一能看到的分身入口。tools 是子 agent 能用
// 的工具集——调用方负责传一份"父的工具集去掉 SubAgentTool 自己"的列表，
// 这就是防递归：子 agent 的注册表里根本没有 sub_agent 这个名字，不是
// 靠它自己克制。
class SubAgentTool {
  constructor(base, apiKey, model, tools, skills) {
    this.base = base;
    this.apiKey = apiKey;
    this.model = model;
    this.tools = tools;
    this.skills = skills;
  }

  definition() {
    return {
      name: "sub_agent",
      description:
        "派生一个隔离的子 agent 去完成一个独立子任务。子 agent 看不到这次对话到" +
        "目前为止的任何内容——prompt 必须自包含，把它需要知道的一切都写进去。你只会拿到" +
        "子 agent 最后的结论，它中途调用了哪些工具、读了哪些文件，都不会进入你的上下文。",
      parameters: {
        type: "object",
        properties: {
          description: { type: "string", description: "这个子任务的一句话标签，仅用于日志" },
          prompt: { type: "string", description: "子任务的完整描述，自包含——子 agent 看不到别的上下文" },
        },
        required: ["description", "prompt"],
      },
    };
  }

  async execute(args) {
    let inArgs;
    try {
      inArgs = JSON.parse(args) ?? {};
    } catch (err) {
      return "错误: 参数不是合法 JSON: " + err.message;
    }
    const description = inArgs.description ?? "";
    const prompt = inArgs.prompt ?? "";
    if (!prompt.trim()) {
      return "错误: prompt 不能为空——子 agent 看不到别的上下文，全靠这一份";
    }
    return this.run(description, prompt);
  }

  // run 是子 agent 真正干活的入口：一份自包含的 prompt 进，一条最终回复出。
  // execute（模型点名调 sub_agent）和这一章的 WorkflowTool（代码按计划调）
  // 都走这同一个入口——换的是谁来编排，没换执行机制。
  async run(description, prompt) {
    const childReg = new Registry(...this.tools);
    const childHistory = [
      { role: "system", content: composeSystemPrompt(this.skills) },
      { role: "user", content: prompt },
    ];
    console.error(`[子 agent "${description}" 开始，独立的一份 history，父对话它一个字都看不到]`);
    let reply, tokens, complete;
    try {
      [reply, tokens, complete] = await runChildLoop(this.base, this.apiKey, this.model, childReg, childHistory);
    } catch (err) {
      return "错误: 子 agent 执行失败: " + (err.message ?? err);
    }
    const tag = complete ? "" : "[未完成：达到轮数上限，以下是部分结果]\n\n";
    console.error(`[子 agent "${description}" 结束：内部消耗约 ${tokens} tokens，` +
      `父对话只收到下面这条回复，约 ${estimateText(reply)} tokens]`);
    return tag + reply;
  }
}

// MAX_PARALLEL_SUB_AGENTS 限制一轮里最多同时跑几个 sub_agent。每一个都会
// 起自己的一整套 provider 连接和多轮对话，扇出多大都不设上限，就是在
// 拿本地资源和 provider 的并发限额去赌。这个数字没有理论最优解，纯粹是
// 部署环境的取舍——本书的玩具 harness 是单机跑，4 只是"够看出并发效果，
// 又不至于把本机或 provider 打满"的一个保守选择。
const MAX_PARALLEL_SUB_AGENTS = 4;

// canFanOut 判断这一轮工具调用能不能并发跑。判据故意收得很紧：调用数
// 大于一个，且全部是 sub_agent——不是"只读工具都能并发"这种更通用的
// 规则。原因是这本书至今没有给任何工具标注过"只读"，bash/write_file/
// edit_file 都会改共享状态（cwd、trash、registry 的 hasRead 记账），
// 混在一起并发执行没人能担保顺序和结果；sub_agent 不一样——它起的是
// 一整个独立的子 agent，自己的 history、自己的 childReg，跟父 agent
// 的注册表没有任何写共享。这份安全保证只覆盖 history/registry 这层
// 状态——子 agent 内部如果自己调用了需要人工确认的 bash 命令，confirm()
// 读的是同一个共享 stdin，见这一章"常见问题"里的实测记录，这份判据
// 没有、也不打算解决这个问题。
function canFanOut(calls) {
  if (calls.length < 2) return false;
  return calls.every((tc) => tc.function.name === "sub_agent");
}

// Semaphore 是一个最小的异步信号量：容量之内 acquire() 立刻 resolve，
// 容量耗尽时排进队列，release() 时唤醒队首等待者。JavaScript 没有
// goroutine，也没有真正的多核并行——但 Node 的事件循环本身就是"单线程
// + 非阻塞 I/O"：每个 sub_agent 调用大部分时间都花在 await fetch() 等
// 网络响应上，这段等待期间事件循环可以去处理别的任务，效果上等价于
// Go 的 goroutine + channel 限流，只是并发单位从"系统线程"换成了
// "还没 resolve 的 Promise"。
class Semaphore {
  constructor(n) {
    this.available = n;
    this.queue = [];
  }
  acquire() {
    return new Promise((resolve) => {
      if (this.available > 0) {
        this.available--;
        resolve();
      } else {
        this.queue.push(resolve); // 坑位不够，排队等 release() 唤醒
      }
    });
  }
  release() {
    const next = this.queue.shift();
    if (next) next(); // 直接把坑位转交给排队的下一个，不经过 available 计数
    else this.available++;
  }
}

// dispatchToolCalls 跑完一轮里的全部工具调用，按原始顺序整理成待追加
// 的 tool 消息。canFanOut 为真时用一个容量 MAX_PARALLEL_SUB_AGENTS 的
// Semaphore 当限流阀：每次派发前先 await acquire()——坑位不够就在这里
// 排队，跟 Go 版"sem <- struct{}{} 这一行阻塞"是同一个位置。结果按下标
// 写回一个和 calls 等长的数组，不依赖 Map 遍历顺序，保证 tool 消息和
// 原始 tool_calls 一一对应。不能并发的这一轮（只有一个调用，或混了
// bash/write 这类工具）走原来那条串行路径，行为跟练习 19 完全一样。
async function dispatchToolCalls(reg, round, calls) {
  const results = new Array(calls.length);
  if (canFanOut(calls)) {
    const sem = new Semaphore(MAX_PARALLEL_SUB_AGENTS);
    const tasks = [];
    for (let i = 0; i < calls.length; i++) {
      const tc = calls[i];
      await sem.acquire(); // 占坑位；坑位不够就在这里排队
      tasks.push(
        (async () => {
          try {
            console.error(`[round ${round}] ${tc.function.name}(${tc.function.arguments})`);
            results[i] = await reg.execute(tc.function.name, tc.function.arguments);
          } finally {
            sem.release(); // 让出坑位给下一个排队的调用
          }
        })()
      );
    }
    await Promise.all(tasks);
  } else {
    for (let i = 0; i < calls.length; i++) {
      const tc = calls[i];
      console.error(`[round ${round}] ${tc.function.name}(${tc.function.arguments})`);
      results[i] = await reg.execute(tc.function.name, tc.function.arguments);
    }
  }
  return calls.map((tc, i) => ({ role: "tool", tool_call_id: tc.id, content: results[i] }));
}

// ---- workflow 层：把编排从模型手里拿回代码里 ----

// PLAN_SHAPE_HINT 附在每条参数错误的后面。报错也是发给模型的 prompt：
// 只说"不合法"，模型会瞎变形重试；把期望的形状递到它眼前，下一次就写对。
const PLAN_SHAPE_HINT = '计划的形状：{"stages": [["阶段1的子任务prompt", "..."], ["阶段2的子任务prompt，可写 {{results}}"]]}';

// RESULTS_PLACEHOLDER 是阶段之间唯一的数据通道：下一阶段的 prompt 里写
// 这个占位符的位置，会被替换成上一阶段全部子任务的结果。除此之外阶段
// 之间什么都不共享——和 sub_agent 的隔离规矩一脉相承。
const RESULTS_PLACEHOLDER = "{{results}}";

// formatResults 把一个阶段的全部结果拼成一段编号的文本——它就是占位符
// 替换进去的内容，也是整个 workflow 最后交回给模型的东西。
function formatResults(results) {
  return results.map((r, i) => `【子任务 ${i + 1} 的结果】\n${r}\n`).join("\n").trim();
}

// WorkflowTool 复用 SubAgentTool 的 run 入口跑每一条 prompt：执行机制
// 和 sub_agent 完全同一套，这个工具新增的只有编排——octo 的 workflow
// 也是同一个做法，agent() 直接复用支撑 sub_agent 的那套派生机制，
// 没有另起炉灶。计划的形状刻意扁平：一个阶段就是一组 prompt 字符串，
// 没有包一层对象——这份 JSON 的作者是模型，schema 每多一层嵌套，它写
// 错的机会就多一分。
class WorkflowTool {
  constructor(runner) {
    this.runner = runner;
  }

  definition() {
    return {
      name: "workflow",
      description:
        "按一份固定的计划执行一批子任务。计划是阶段的列表，每个阶段是一组子任务 " +
        "prompt：阶段之间严格按顺序执行，同一阶段内的 prompt 全部并发执行；下一阶段的 " +
        "prompt 里写 {{results}} 的位置，会被替换成上一阶段全部子任务的结果；整个 " +
        "workflow 交回给你的，只有最后一个阶段的结果。整份计划由代码保证执行，中途" +
        "不再经过你。例——\"分头调查 A、B、C，再汇总\"写成两个阶段：" +
        '{"stages": [["调查A……", "调查B……", "调查C……"], ["汇总以下调查结果……\n{{results}}"]]}' +
        "。不要把要并发的子任务拆到不同阶段，阶段是串行的。适合结构事先想得清楚的任务；" +
        "边做边定下一步的探索式任务，继续用 sub_agent。每条 prompt 都交给一个隔离的" +
        "子 agent，规矩和 sub_agent 相同：必须自包含，子 agent 看不到本次对话的任何内容。",
      parameters: {
        type: "object",
        properties: {
          stages: {
            type: "array",
            description:
              "按顺序执行的阶段列表。每个阶段是一个字符串数组：这一阶段要" +
              "并发派出的子任务 prompt，每条都必须自包含。需要上一阶段结果的地方写 " +
              "{{results}}（第一阶段没有上一阶段，不要写）。",
            items: { type: "array", items: { type: "string" } },
          },
        },
        required: ["stages"],
      },
    };
  }

  // execute 逐阶段执行计划。阶段内的并发和上面的 dispatchToolCalls 是同一个
  // 模式：容量 MAX_PARALLEL_SUB_AGENTS 的 Semaphore 当限流阀，结果按下标
  // 写回。区别只在谁决定"这一批一起跑"——上一章靠 canFanOut 事后检查模型
  // 有没有把调用发在同一轮，这里阶段本身就是并发声明，不存在检查不过的情况。
  async execute(args) {
    let plan;
    try {
      plan = JSON.parse(args);
    } catch (err) {
      return "错误: 参数不是合法 JSON: " + err.message + "。" + PLAN_SHAPE_HINT;
    }
    const stages = plan?.stages;
    if (!Array.isArray(stages) || stages.length === 0) {
      return "错误: 计划里一个阶段都没有。" + PLAN_SHAPE_HINT;
    }
    let prev = [];
    for (let si = 0; si < stages.length; si++) {
      const prompts = stages[si];
      if (!Array.isArray(prompts) || prompts.length === 0 || !prompts.every((p) => typeof p === "string")) {
        return `错误: 阶段 ${si + 1} 不是字符串数组，或一个子任务都没有。${PLAN_SHAPE_HINT}`;
      }
      console.error(`[workflow 阶段 ${si + 1}/${stages.length}：${prompts.length} 个子任务，` +
        `并发上限 ${MAX_PARALLEL_SUB_AGENTS}]`);
      const results = new Array(prompts.length);
      const sem = new Semaphore(MAX_PARALLEL_SUB_AGENTS);
      const tasks = [];
      for (let i = 0; i < prompts.length; i++) {
        let p = prompts[i];
        if (prev.length > 0) p = p.replaceAll(RESULTS_PLACEHOLDER, formatResults(prev));
        await sem.acquire();
        const stageNo = si + 1;
        const taskNo = i + 1;
        tasks.push(
          (async () => {
            try {
              results[i] = await this.runner.run(`阶段${stageNo}-子任务${taskNo}`, p);
            } finally {
              sem.release();
            }
          })()
        );
      }
      await Promise.all(tasks);
      prev = results;
    }
    if (prev.length === 1) return prev[0];
    return formatResults(prev);
  }
}

// ---- MCP 层：接入别人的工具 ----

// MCP_CONFIG_FILE 是工作目录下的服务器清单，格式跟 Claude Code 的
// mcp.json 完全一致——和练习 16 认 Claude Code 的 SKILL.md 是同一个
// 理由：兼容通行格式，别人写好的配置抄过来就能用。
const MCP_CONFIG_FILE = "mcp.json";

// loadMCPConfig 读工作目录下的 mcp.json。文件不存在是正常状态——没配
// 外部服务器的项目跟上一章的行为完全一样，不是错误。
function loadMCPConfig() {
  let raw;
  try {
    raw = readFileSync(MCP_CONFIG_FILE, "utf-8");
  } catch {
    return {};
  }
  try {
    return JSON.parse(raw)?.mcpServers ?? {};
  } catch (err) {
    console.error(`警告: ${MCP_CONFIG_FILE} 不是合法 JSON，忽略: ${err.message}`);
    return {};
  }
}

// MCPClient 管着一个外部服务器子进程：往它的标准输入写请求，从它的标准
// 输出读响应。用一个容量 1 的 Semaphore 当互斥锁——跟 Go 版 sync.Mutex
// 是同一个道理，保证同一时刻只有一个在途请求，只是换成了异步排队，不是
// 操作系统级的锁。标准输出是流式到达的，自己按 "\n" 切帧，攒不满一行
// 就先放进 buffer 里等下一块数据。
class MCPClient {
  constructor(name, proc) {
    this.name = name;
    this.proc = proc;
    this.nextId = 0;
    this.mutex = new Semaphore(1);
    this.buffer = "";
    this.pendingLines = [];
    this.lineWaiters = [];
    this.closed = false;
    this.proc.stdout.on("data", (chunk) => this._onData(chunk));
    this.proc.stdout.on("close", () => this._onClose());
  }

  _onData(chunk) {
    this.buffer += chunk.toString("utf-8");
    let idx;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      const waiter = this.lineWaiters.shift();
      if (waiter) waiter(line);
      else this.pendingLines.push(line);
    }
  }

  _onClose() {
    this.closed = true;
    while (this.lineWaiters.length > 0) this.lineWaiters.shift()(null);
  }

  _readLine() {
    if (this.pendingLines.length > 0) return Promise.resolve(this.pendingLines.shift());
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => this.lineWaiters.push(resolve));
  }

  // call 发一个请求，等它的响应。一次只有一个在途请求，所以"等"就是
  // 顺着流往下读：读到的帧如果带 method，那是服务器发来的通知，这本书
  // 不处理，跳过；直到读到 id 对得上的响应为止。
  async call(method, params) {
    await this.mutex.acquire();
    try {
      this.nextId++;
      const id = this.nextId;
      const msg = { jsonrpc: "2.0", id, method };
      if (params !== undefined) msg.params = params;
      this.proc.stdin.write(JSON.stringify(msg) + "\n");
      for (;;) {
        const line = await this._readLine();
        if (line === null) throw new Error(`读取 MCP 服务 "${this.name}" 失败: 进程已退出`);
        if (!line.trim()) continue;
        let m;
        try {
          m = JSON.parse(line);
        } catch (err) {
          throw new Error(`读取 MCP 服务 "${this.name}" 失败: ${err.message}`);
        }
        if (m.method || m.id !== id) continue; // 通知，或不属于这次请求的帧——跳过，接着读
        if (m.error) throw new Error(`MCP 错误 ${m.error.code}: ${m.error.message}`);
        return m.result;
      }
    } finally {
      this.mutex.release();
    }
  }

  // notify 发一个通知——没有 id 的请求，服务器不会回复，发完就走。
  notify(method) {
    this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n");
  }

  // initialize 是 MCP 的三步握手：客户端报上版本和身份，服务器答复它
  // 的；然后客户端发一条 initialized 通知表示"我这边好了"。版本我们报
  // 2024-11-05——这本书只说 stdio 这一种传输方式，报更新的版本反而名
  // 不副实；服务器答复的版本如果不一样，记下来继续用，不较真。
  async initialize() {
    const params = {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "learnharness", version: "0.1" },
    };
    const res = (await this.call("initialize", params)) ?? {};
    this.notify("notifications/initialized");
    const info = res.serverInfo ?? {};
    console.error(`[MCP 服务 "${this.name}" 握手完成：${info.name} v${info.version}，` +
      `协议 ${res.protocolVersion}]`);
  }

  async listTools() {
    const res = (await this.call("tools/list", {})) ?? {};
    return res.tools ?? [];
  }
}

// startMCPServer 启动配置里的一条命令，接管它的标准输入输出。子进程的
// 标准错误直通我们的终端（stdio 的第三项 "inherit"）——那是服务器的
// 日志通道，不是协议通道，MCP 的协议规定 stdout 只许出现 JSON-RPC 帧，
// 日志必须走 stderr。
function startMCPServer(name, cfg) {
  const proc = spawn(cfg.command, cfg.args ?? [], {
    env: { ...process.env, ...(cfg.env ?? {}) },
    stdio: ["pipe", "pipe", "inherit"],
  });
  return new MCPClient(name, proc);
}

// MCPTool 把一个远端工具包进这本书的 tool 接口。注册表分不出它和
// ReadFileTool 有什么区别——这正是这一章的全部要点：接入别人的工具，
// 改动的只有"多一种来源"，没有第二套分发机制。
class MCPTool {
  constructor(client, remote) {
    this.client = client;
    this.remote = remote;
  }

  // definition 的两个细节：名字带上 mcp__<服务名>__ 前缀，既避免和内置
  // 工具撞名，也让日志里一眼看出这个调用出了进程；parameters 直接透传
  // 服务器声明的 schema——参数长什么样是工具作者说了算，我们不翻译。
  definition() {
    return {
      name: `mcp__${this.client.name}__${this.remote.name}`,
      description: `[来自 MCP 服务 ${this.client.name}] ${this.remote.description ?? ""}`,
      parameters: this.remote.inputSchema ?? { type: "object", properties: {} },
    };
  }

  async execute(args) {
    let toolArgs;
    try {
      toolArgs = JSON.parse(args);
    } catch (err) {
      return "错误: 参数不是合法 JSON: " + err.message;
    }
    let res;
    try {
      res = (await this.client.call("tools/call", { name: this.remote.name, arguments: toolArgs })) ?? {};
    } catch (err) {
      // 这一层的错误是"调用没送到工具手上"——进程死了、协议错了。
      return "错误: " + (err.message ?? err);
    }
    const text = (res.content ?? [])
      .map((c) => (c.type === "text" ? c.text : `[未处理的内容类型 "${c.type}"]`))
      .join("\n");
    if (res.isError) {
      // 这一层的错误是"工具收到了调用，干活失败了"——和上面那种要分开：
      // isError 是结果的一部分，进程还活着，下一次调用照常。
      return "错误: 工具执行失败: " + text;
    }
    return text;
  }
}

// connectMCPServers 把 mcp.json 里每个服务器的工具接进 toolList。一个
// 服务器连不上只警告、跳过——外部依赖挂了不该拖垮整个 harness，这和
// 练习 16"一份写坏的 SKILL.md 不中断发现"是同一条纪律。服务名排序遍历，
// 保证工具列表的顺序每次启动都一样。
async function connectMCPServers(toolList) {
  const servers = loadMCPConfig();
  for (const name of Object.keys(servers).sort()) {
    const cfg = servers[name];
    let client;
    try {
      client = startMCPServer(name, cfg);
    } catch (err) {
      console.error(`警告: MCP 服务 "${name}" 启动失败，跳过: ${err.message}`);
      continue;
    }
    try {
      await client.initialize();
    } catch (err) {
      console.error(`警告: MCP 服务 "${name}" 握手失败，跳过: ${err.message}`);
      continue;
    }
    let remotes;
    try {
      remotes = await client.listTools();
    } catch (err) {
      console.error(`警告: MCP 服务 "${name}" 列工具失败，跳过: ${err.message}`);
      continue;
    }
    let schemaCost = 0;
    for (const rt of remotes) {
      toolList.push(new MCPTool(client, rt));
      schemaCost += estimateText((rt.name ?? "") + (rt.description ?? "") + JSON.stringify(rt.inputSchema ?? {}));
    }
    // 又一笔要当场算清的账（练习 17 的老规矩）：这些声明进的是 tools
    // 数组，跟 system prompt 一样每一轮都要重发一遍。
    console.error(`[MCP 服务 "${name}"：接入 ${remotes.length} 个工具，声明约 ${schemaCost} tokens，` +
      "随 tools 数组每轮都算钱]");
  }
  return toolList;
}

if (process.argv[2] === "-restore" && process.argv.length === 4) {
  process.exit(restore(process.argv[3]));
}

let args = process.argv.slice(2);
if (args.length >= 1 && args[0] === "-sandbox") {
  args = args.slice(1);
  if (!sandboxAvailable()) {
    // 要了沙箱又给不了，就明确拒绝启动——降级成"假装有沙箱"
    // 比没有沙箱更危险：你以为有边界，其实没有。
    console.error("错误: 这台机器提供不了 OS 级沙箱（本章实现只支持带 sandbox-exec 的 macOS），" +
      "拒绝在没有边界的情况下假装有边界地运行");
    process.exit(1);
  }
  activeSandbox = defaultSandboxPolicy();
  console.error(`[沙箱开启：可写 [${activeSandbox.writeRoots.join(", ")}]，` +
    "家目录不可读（工作目录和临时目录除外），网络关闭——OS 强制，批准了也越不出去]");
}
let resumeId = "";
if (args.length >= 2 && args[0] === "-c") {
  [resumeId, args] = [args[1], args.slice(2)];
}
// 任务从必填变成选填：不给就直接进提示符，给了就当第一句话，说完
// 照样留在提示符上。这是这一章唯一改变的用法。
const firstTask = args[0] ?? "";
const apiKey = process.env.OPENAI_API_KEY;
const model = process.env.MODEL;
if (!apiKey || !model) {
  console.error("需要环境变量 OPENAI_API_KEY 和 MODEL");
  console.error("例: export OPENAI_API_KEY=sk-xxxx");
  console.error("    export MODEL=deepseek-v4-flash");
  console.error("    export OPENAI_BASE_URL=https://api.deepseek.com/v1  # 不设则默认 OpenAI 官方");
  process.exit(1);
}
const base = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";

// 全部工具在这里注册。加第五个工具 = 在这里加一行，别处一个字不用动。
const skills = discoverSkills();
const toolList = [new ReadFileTool(), new WriteFileTool(), new EditFileTool(), new BashTool()];
if (skills.size > 0) {
  // 一个 skill 都没发现就不挂 skill 工具——模型不该看见一个永远
  // 调不出东西的空壳工具，蒸馏自 octo DefaultTools() 同一条判断。
  toolList.push(new SkillTool(skills));
  // 清单这一层的账，现在就能算：它冻结进 system prompt，往后
  // 每一轮都要重新算一遍钱，不管这一轮用不用得上任何一个 skill。
  // estimateText 是练习 12 就有的粗略估算，够拿来对比数量级。
  const manifest = skillManifest(skills);
  console.error(`[skill 清单：${skills.size} 个 skill，约 ${estimateText(manifest)} tokens，` +
    "随 system prompt 每轮都算钱]");
}
// MCP 工具在这里接入——排在 subAgent 之前，所以子 agent 的工具集里
// 也有它们：外部工具没有防递归的顾虑，分身也用得上"别人的工具"。
// connectMCPServers 往传入的数组里 push、原地返回同一个引用，不用重新赋值。
await connectMCPServers(toolList);
// SubAgentTool 拿到的是此刻的 toolList——不含它自己，因为这一行还
// 没把它加进去。子 agent 的注册表由这份数组构造，天生没有 sub_agent
// 这个名字，递归在结构上就不成立，不是靠模型自觉不去调用它。
const subAgent = new SubAgentTool(base, apiKey, model, [...toolList], skills);
toolList.push(subAgent);
// workflow 也排在 subAgent 之后才加——子 agent 的工具集里同样没有
// workflow 这个名字，一份计划里的子任务不能自己再展开一份计划。
toolList.push(new WorkflowTool(subAgent));
const reg = new Registry(...toolList);

let sess;
if (resumeId) {
  try {
    sess = loadSession(resumeId);
  } catch (err) {
    console.error(`错误: 恢复会话失败: ${err.message}`);
    process.exit(1);
  }
  console.error(`[恢复会话 ${sess.id}，已有 ${sess.history.length} 条消息]`);
} else {
  try {
    sess = newSessionFile([{ role: "system", content: composeSystemPrompt(skills) }]);
  } catch (err) {
    console.error(`错误: 创建会话文件失败: ${err.message}`);
    process.exit(1);
  }
  console.error(`[新建会话 ${sess.id}]`);
}

// 这一刻是估算值唯一有用武之地的时候：还没发出过任何请求，checkBudget
// 依赖的真实数字根本不存在——尤其是 -c 恢复一个老会话时，history 可能已经
// 很大，你想在花钱之前先摸个底，能查的只有这个粗略估算。
const window = effectiveContextWindow(model);
const preEstimate = estimateTokens(sess.history);
console.error(`[窗口: ${model} → ${window} tokens（发出第一个请求前，估算值: ${preEstimate} tokens）]`);
if (preEstimate >= window * BUDGET_FRACTION) {
  console.error("⚠️  恢复的历史估算下来已经接近预算上限，还没发请求就先说一声——真实数字要等第一轮回来才知道");
}

// ---- 常驻层：一个不退出的循环 ----

// const 声明不会被提升到能用的状态（暂时性死区），下面这几个函数虽然
// 是声明式的、可以在这一行之前调用，但它们内部引用的 MAX_ROUNDS 必须
// 在真正执行到这里之前先跑过这行赋值——所以常量放在调用之前，函数定义
// 留在后面也没关系。
const MAX_ROUNDS = 10;

process.exit(await repl(base, apiKey, model, reg, sess, window, firstTask));

// healTurn 把一轮没正常收尾的历史补回合法状态。
//
// 半途而废不是免费的：它会把 history 停在一个协议不允许的位置。一条带
// tool_calls 的 assistant 消息，后面必须跟着每个 id 对应的 tool 消息，
// 打断正好落在这两者之间，下一句话发出去就是 400——不是模型不高兴，是
// 请求本身不合法。补上"没有执行"的结果，再留一条模型看得见的说明：它得
// 知道刚才那件事是断在半路的，不是自己干完了。
//
// 请求失败走的是同一条路：那时候历史停在一条没人回应的 user 消息上，
// 下一句话再进来就是连着两条 user，同样要在这里收干净。
function healTurn(history, note) {
  if (history.length === 0) return history;
  const last = history[history.length - 1];
  if (last.role === "assistant" && !(last.tool_calls?.length)) {
    return history; // 模型把话说完了才出的事，历史本来就是合法的
  }
  if (last.role === "assistant" && last.tool_calls?.length) {
    for (const tc of last.tool_calls) {
      history.push({ role: "tool", tool_call_id: tc.id, content: "错误: 这一轮中断了，这个工具没有执行。" });
    }
  }
  history.push({ role: "assistant", content: note });
  return history;
}

// heal 收拾一轮没能正常收尾的历史，然后存盘。
function heal(sessArg, note) {
  sessArg.history = healTurn(sessArg.history, note);
  try {
    sessArg.save();
  } catch (err) {
    console.error(`警告: 会话保存失败: ${err.message}`);
  }
}

// runTurn 把一句话跑到底：发请求、有 tool_calls 就分发、没有就收工。
// 循环结构和练习 5 一模一样，这一章多两件事——最外层这一次 send() 挂了
// AbortSignal（真正能中断一个还没返回的请求），以及工具批量执行完之后
// 补一个检查点。跟 Python 版对齐的取舍：sub_agent/workflow 内部的
// send() 调用不传 signal，取消不往那么深处传。
async function runTurn(base, apiKey, model, reg, sess, window, input, signal) {
  sess.history.push({ role: "user", content: input });
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const r = await send(base, apiKey, model, sess.history, reg.definitions(), signal);
    const choice = r.choices[0];
    const msg = choice.message;
    sess.history.push(msg);
    const cached = r.usage?.prompt_tokens_details?.cached_tokens ?? 0;
    if (checkBudget(r.usage?.prompt_tokens ?? 0, window)) {
      const trigger = Math.floor(window * BUDGET_FRACTION);
      const keepBudget = compactKeepBudget(window, trigger);
      try {
        const [rebuilt, folded] = await compact(base, apiKey, model, sess.history, keepBudget);
        if (folded > 0) {
          console.error(`[压缩：把前 ${folded} 条消息折叠成一条摘要，${sess.history.length} 条 → ${rebuilt.length} 条]`);
          sess.history = rebuilt;
          sess.forceRewrite = true;
        } else {
          console.error("[压缩：还没有两条完整的用户消息可折叠，跳过这一轮]");
        }
      } catch (err) {
        console.error(`警告: 压缩失败，继续用未压缩的历史: ${err.message ?? err}`);
      }
    }

    if (choice.finish_reason !== "tool_calls") {
      console.log(msg.content ?? "");
      console.error(`\n[本轮 ${round} 次请求 · 最后一次输入 ${r.usage?.prompt_tokens ?? 0} tokens` +
        `（命中缓存 ${cached}）· finish_reason=${choice.finish_reason}]`);
      sess.save();
      return;
    }

    console.error(`[round ${round} 输入 ${r.usage?.prompt_tokens ?? 0} tokens，命中缓存 ${cached}]`);
    const toolCalls = msg.tool_calls ?? [];
    if (canFanOut(toolCalls)) {
      console.error(`[round ${round} 并发扇出：${toolCalls.length} 个 sub_agent，` +
        `上限 ${MAX_PARALLEL_SUB_AGENTS} 个坑位]`);
    }
    sess.history.push(...(await dispatchToolCalls(reg, round, toolCalls)));
    sess.save();
  }
  throw new Error(`这一句话跑满 ${MAX_ROUNDS} 次请求还没收敛，停在这里`);
}

// runInterruptible 跑一轮，同时盯着 Ctrl+C。
//
// 信号只在轮次跑着的时候接管，跑完立刻还给操作系统：停在提示符上按
// Ctrl+C，就该跟任何一个命令行程序一样直接把进程干掉，那是用户的肌肉
// 记忆，别去改它。要改的只有"模型正在干活"这一小段时间里的含义——那时候
// Ctrl+C 是"这件事别做了"，不是"这个程序不要了"。
//
// AbortController 是这里真正做事的角色：SIGINT 一来就 abort()，如果
// 这一刻正好卡在 send() 的 fetch() 里，请求立刻中断、抛出 AbortError。
// 但如果这一刻卡在 dispatchToolCalls 里跑一个同步的 execFileSync
// （比如一条卡住的 bash 命令），SIGINT 的回调函数要等 execFileSync
// 返回才有机会运行——单线程的代价，"发生了什么"里有真机实测。
async function runInterruptible(base, apiKey, model, reg, sess, window, input) {
  const controller = new AbortController();
  const onSigint = () => controller.abort();
  process.on("SIGINT", onSigint);
  try {
    await runTurn(base, apiKey, model, reg, sess, window, input, controller.signal);
  } catch (err) {
    if (err.name === "AbortError") {
      heal(sess, "[这一轮被用户打断]");
      console.error("\n[已打断这一轮。对话还在，接着说]");
    } else {
      // 一次请求失败不该带走整个进程——这是常驻和一次性最实际的
      // 区别：报错、收拾干净、回到提示符，对话还在。
      console.error("错误:", err.message ?? err);
      heal(sess, `[这一轮没跑完：${err.message ?? err}]`);
    }
  } finally {
    process.off("SIGINT", onSigint);
  }
}

// repl 是这一章加的全部东西：读一行、跑一轮、回到读一行。前面二十三章
// 的进程活到脚本跑完最后一行就结束了，一句话一条命；从这里开始它不走
// 了，一直等着你说下一句。
//
// 这不是一个工具，是运行环境的形态变了。往后几章要加的能力——插话、定时
// 唤醒、后台任务跑完了来报信——全都得先有一个"还醒着的进程"才谈得上。
// 读输入复用 confirm() 那个 readLineSync()，不用 node:readline 另起一
// 套——两套机制同时抢一个标准输入，会互相偷字节，这正是练习原文"标准
// 输入只能有一个读者"那条规矩，这一版从一开始就只有一个读者，不用像
// Go 版那样后来去统一。
async function repl(base, apiKey, model, reg, sess, window, firstTask) {
  console.error("[常驻模式：一行一句话。空行忽略，/exit 或 Ctrl+D 退出；轮次跑起来之后 Ctrl+C 打断这一轮，不退出进程]");
  for (;;) {
    let line = firstTask;
    firstTask = "";
    if (!line) {
      process.stderr.write("\n> ");
      const text = readLineSync();
      if (text === null) {
        console.error(""); // Ctrl+D：补个换行，别让提示符黏在下一行
        break;
      }
      line = text.trim();
    }
    if (!line) continue;
    if (line === "/exit" || line === "/quit") break;
    await runInterruptible(base, apiKey, model, reg, sess, window, line);
  }
  try {
    sess.save();
  } catch (err) {
    console.error(`警告: 会话保存失败: ${err.message}`);
  }
  console.error(`[会话 ID: ${sess.id}，用 -c ${sess.id} 继续]`);
  return 0;
}

// send 多接受一个可选的 AbortSignal：只有最外层 runTurn 发起的这一轮
// 请求会传它，sub_agent/workflow 内部各自的请求不传（signal 是
// undefined，fetch 就当没这回事）——跟 Python 版一样，这一版的取消只做
// 最外层，不往子 agent、workflow 内部深处传，详见"发生了什么"。
async function send(base, apiKey, model, history, tools, signal) {
  const payload = {
    model,
    max_tokens: 4096,
    messages: history,
  };
  // tools 为 null 时整个键都不发——Go 版靠 omitempty 自动做到这一点，
  // JSON.stringify 会把 null 老实写成 null，服务端不一定认，得手动省掉。
  if (tools?.length) payload.tools = tools;
  const body = JSON.stringify(payload);
  let resp;
  try {
    resp = await fetch(base + "/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + apiKey,
      },
      body,
      signal,
    });
  } catch (err) {
    if (err.name === "AbortError") throw err; // 原样往上抛，调用方按取消处理，不是普通请求失败
    throw new Error(`请求失败: ${err.cause ?? err}`);
  }
  const raw = await resp.text();
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${raw}`);

  let r;
  try {
    r = JSON.parse(raw);
  } catch (err) {
    throw new Error(`解析失败: ${err}\n原始响应: ${raw}`);
  }
  if (r.error) throw new Error(`API 错误 [${r.error.type}]: ${r.error.message}`);
  if (!r.choices?.length) throw new Error(`空响应: ${raw}`);
  return r;
}
