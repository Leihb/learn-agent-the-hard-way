// Learn Agent the Hard Way — 练习 10：误删保护——删除前备份
//
// 练习 9 拦住了模型不该做的事。write_file 覆盖一个已存在的文件是该做的事，
// 闸门不该拦——但覆盖之后，旧内容还有没有第二次机会，这一章补上这个缺口。
import { readFileSync, writeFileSync, existsSync, readSync, mkdirSync, readdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { basename, join } from "node:path";

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
    // 用子 shell 的 `2>&1` 在 shell 层面把两路合成一路，效果等价。
    try {
      const out = execSync(`(${command}) 2>&1`, {
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
    if (n === 0) break; // EOF
    if (buf[0] === 0x0a) break; // '\n'
    chunks.push(buf[0]);
  }
  return Buffer.from(chunks).toString("utf-8");
}

// askApproval 停下来问人，不是问模型——危险命令要过这一关，
// 模型自己怎么想不算数。读不到回答（比如脚本化调用、没有终端）一律按拒绝处理，
// 安全边界宁可保守，不能因为读不到输入就放行。
function askApproval(cmd) {
  process.stderr.write(`\n⚠️  模型想执行: ${cmd}\n允许吗？(y/N) `);
  const line = readLineSync();
  if (line === null) return false;
  const answer = line.trim().toLowerCase();
  return answer === "y" || answer === "yes";
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
  execute(name, args) {
    const t = this.tools.get(name);
    if (!t) return "错误: 未知工具 " + name;
    if (name === "write_file" || name === "edit_file") {
      const path = pathOf(args);
      if (path && existsSync(path) && !this.hasRead.has(path)) {
        return "错误: " + path + " 已存在但这个会话里还没读过它。先用 read_file 看一眼，再来修改。";
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
    const result = t.execute(args);
    // 调用成功就记账：读过的文件可以改；刚写完的文件模型知道最新内容，也算读过。
    const path = pathOf(args);
    if (path && !result.startsWith("错误:")) this.hasRead.add(path);
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

if (process.argv[2] === "-restore" && process.argv.length === 4) {
  process.exit(restore(process.argv[3]));
}

const task = process.argv[2];
if (!task) {
  console.error('用法: node main.mjs "你的任务"');
  process.exit(1);
}
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

// 全部工具在这里注册。加第四个工具 = 在这里加一行，别处一个字不用动。
const reg = new Registry(
  new ReadFileTool(),
  new WriteFileTool(),
  new EditFileTool(),
  new BashTool(),
);

const history = [
  { role: "system", content: BASE_PROMPT },
  { role: "user", content: task },
];

// agent loop 的结构和练习 5 完全一样。变化只有两处：
// 工具声明从注册表拿（reg.definitions），分发交给注册表（reg.execute）。
const maxRounds = 10;
let done = false;
for (let round = 1; round <= maxRounds; round++) {
  let r;
  try {
    r = await send(base, apiKey, model, history, reg.definitions());
  } catch (err) {
    console.error(err.message ?? err);
    process.exit(1);
  }
  const choice = r.choices[0];
  const msg = choice.message;
  history.push(msg);
  const cached = r.usage?.prompt_tokens_details?.cached_tokens ?? 0;

  if (choice.finish_reason !== "tool_calls") {
    console.log(msg.content ?? "");
    console.error(`\n[共 ${round} 轮 · 最后一轮输入 ${r.usage?.prompt_tokens ?? 0} tokens` +
      `（命中缓存 ${cached}）· finish_reason=${choice.finish_reason}]`);
    done = true;
    break;
  }

  console.error(`[round ${round} 输入 ${r.usage?.prompt_tokens ?? 0} tokens，命中缓存 ${cached}]`);
  for (const tc of msg.tool_calls ?? []) {
    console.error(`[round ${round}] ${tc.function.name}(${tc.function.arguments})`);
    const result = reg.execute(tc.function.name, tc.function.arguments);
    history.push({
      role: "tool",
      tool_call_id: tc.id,
      content: result,
    });
  }
}
if (!done) {
  console.error(`达到 ${maxRounds} 轮上限，停止。`);
  process.exit(1);
}

async function send(base, apiKey, model, history, tools) {
  const body = JSON.stringify({
    model,
    max_tokens: 4096,
    messages: history,
    tools,
  });
  let resp;
  try {
    resp = await fetch(base + "/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + apiKey,
      },
      body,
    });
  } catch (err) {
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
