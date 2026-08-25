// Learn Agent the Hard Way — 练习 14：规则文件——陈述拗不过肌肉记忆
//
// 练习 8 讲过软约束会被听懂或听不懂；这一章问一个更窄的问题：
// 一条写在项目规则文件里的约定，碰上模型训练时学出来的强烈习惯，谁会赢？
import { readFileSync, writeFileSync, appendFileSync, existsSync, readSync, mkdirSync, readdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
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

// composeSystemPrompt 把 BASE_PROMPT 和项目规则拼成一份 system prompt，
// 蒸馏自 octo Compose 的分层方式：每层之间用同一个分隔符隔开，项目规则
// 没有就只有 BASE_PROMPT 一层。这份拼好的文字，从会话创建那一刻起冻结——
// 练习 8 讲过为什么：中途改一个字，隐式缓存就整条作废。
function composeSystemPrompt() {
  let prompt = BASE_PROMPT;
  const rules = readProjectRules();
  if (rules) prompt += "\n\n---\n\n# 项目约定 (" + PROJECT_RULES_FILE + ")\n\n" + rules;
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
// forceRewrite 是这一章新加的：压缩会把 history 前半段整个换成一条摘要，
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

if (process.argv[2] === "-restore" && process.argv.length === 4) {
  process.exit(restore(process.argv[3]));
}

let args = process.argv.slice(2);
let resumeId = "";
if (args.length >= 2 && args[0] === "-c") {
  [resumeId, args] = [args[1], args.slice(2)];
}
const task = args[0];
if (!task) {
  console.error('用法: node main.mjs "你的任务"  或  node main.mjs -c <session-id> "你的任务"');
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
    sess = newSessionFile([{ role: "system", content: composeSystemPrompt() }]);
  } catch (err) {
    console.error(`错误: 创建会话文件失败: ${err.message}`);
    process.exit(1);
  }
  console.error(`[新建会话 ${sess.id}]`);
}
sess.history.push({ role: "user", content: task });

// 这一刻是估算值唯一有用武之地的时候：还没发出过任何请求，checkBudget
// 依赖的真实数字根本不存在——尤其是 -c 恢复一个老会话时，history 可能已经
// 很大，你想在花钱之前先摸个底，能查的只有这个粗略估算。
const window = effectiveContextWindow(model);
const preEstimate = estimateTokens(sess.history);
console.error(`[窗口: ${model} → ${window} tokens（发出第一个请求前，估算值: ${preEstimate} tokens）]`);
if (preEstimate >= window * BUDGET_FRACTION) {
  console.error("⚠️  恢复的历史估算下来已经接近预算上限，还没发请求就先说一声——真实数字要等第一轮回来才知道");
}

// agent loop 的结构和练习 5 完全一样。变化只有两处：
// 工具声明从注册表拿（reg.definitions），分发交给注册表（reg.execute）；
// history 现在是 sess.history，每轮跑完都 save 一次。
const maxRounds = 10;
let done = false;
for (let round = 1; round <= maxRounds; round++) {
  let r;
  try {
    r = await send(base, apiKey, model, sess.history, reg.definitions());
  } catch (err) {
    console.error(err.message ?? err);
    process.exit(1);
  }
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
    console.error(`\n[共 ${round} 轮 · 最后一轮输入 ${r.usage?.prompt_tokens ?? 0} tokens` +
      `（命中缓存 ${cached}）· finish_reason=${choice.finish_reason}]`);
    try {
      sess.save();
    } catch (err) {
      console.error(`警告: 会话保存失败: ${err.message}`);
    }
    console.error(`[会话 ID: ${sess.id}，用 -c ${sess.id} 继续]`);
    done = true;
    break;
  }

  console.error(`[round ${round} 输入 ${r.usage?.prompt_tokens ?? 0} tokens，命中缓存 ${cached}]`);
  for (const tc of msg.tool_calls ?? []) {
    console.error(`[round ${round}] ${tc.function.name}(${tc.function.arguments})`);
    const result = reg.execute(tc.function.name, tc.function.arguments);
    sess.history.push({
      role: "tool",
      tool_call_id: tc.id,
      content: result,
    });
  }
  try {
    sess.save();
  } catch (err) {
    console.error(`警告: 会话保存失败: ${err.message}`);
  }
}
if (!done) {
  console.error(`达到 ${maxRounds} 轮上限，停止。`);
  process.exit(1);
}

async function send(base, apiKey, model, history, tools) {
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
