// Learn Agent the Hard Way — 练习 8：base prompt——教模型怎么用工具
//
// 练习 7 结尾，bash 一步绕开了注册表的 read-before-write。工具决定"能做什么"，
// 这一章加的 BASE_PROMPT 决定"该怎么做"——把规矩从代码挪进给模型看的文字里。
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";

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
    const content = params.content ?? "";
    try {
      writeFileSync(params.path ?? "", content);
    } catch (err) {
      return "错误: " + err.message;
    }
    // content.length 是字符数不是字节数——中文会对不上，按 UTF-8 编码后再数
    return `已写入 ${params.path}（${Buffer.byteLength(content, "utf-8")} 字节）`;
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
  execute(name, args) {
    const t = this.tools.get(name);
    if (!t) return "错误: 未知工具 " + name;
    if (name === "write_file" || name === "edit_file") {
      const path = pathOf(args);
      if (path && existsSync(path) && !this.hasRead.has(path)) {
        return "错误: " + path + " 已存在但这个会话里还没读过它。先用 read_file 看一眼，再来修改。";
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
