// Learn Agent the Hard Way — 练习 5：第一个工具
//
// 前四章的一切都是铺垫。这一章，模型第一次碰到你的世界：
// 声明工具 → 模型请求调用 → 你执行 → 结果回填 → 再问模型。
// 这个循环就是 agent loop——全书的心脏，今天完整闭环。
import { readFileSync } from "node:fs";

// TOOLS 声明我们的第一个工具：read_file。
// 这是发给模型的工具声明，parameters 是一份 JSON Schema——
// 模型看到的全部就是这些字段：叫什么、干什么、怎么传参。
const TOOLS = [{
  type: "function",
  function: {
    name: "read_file",
    description: "读取一个本地文件，返回它的文本内容。",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "要读取的文件路径（相对或绝对）",
        },
      },
      required: ["path"],
    },
  },
}];

// execute 按名字分发工具调用。未知工具返回干净的错误文本而不是崩溃——
// 错误也是回填给模型的合法结果，它看得懂，还会自己想办法。
function execute(name, args) {
  if (name === "read_file") return readFile(args);
  return "错误: 未知工具 " + name;
}

function readFile(args) {
  // 注意 args 是 JSON **字符串**，不是对象——
  // 模型逐字生成它，协议原样转交，解析是你的事。
  let params;
  try {
    params = JSON.parse(args);
  } catch (err) {
    return "错误: 参数不是合法 JSON: " + err.message;
  }
  try {
    return readFileSync(params.path ?? "", "utf-8");
  } catch (err) {
    // 不要 throw，不要 process.exit——把失败告诉模型，它会调整。
    return "错误: " + err.message;
  }
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

const history = [{ role: "user", content: task }];

// agent loop。注意它和练习 3 的 REPL 是同一个循环，
// 只是对话的另一方从"人"换成了"工具"。
const maxRounds = 10; // 保险丝：防模型在工具里打转，烧光你的钱包
let done = false;
for (let round = 1; round <= maxRounds; round++) {
  let r;
  try {
    r = await send(base, apiKey, model, history);
  } catch (err) {
    console.error(err.message ?? err);
    process.exit(1);
  }
  const choice = r.choices[0];
  const msg = choice.message;
  // 模型的回复原样塞回历史——包括 tool_calls。
  // 少了它，下一轮模型看不到自己发起过调用，协议直接报错。
  history.push(msg);

  // 练习 1 的纪律在这里派上大用场：循环走哪条路，看 finish_reason。
  if (choice.finish_reason !== "tool_calls") {
    console.log(msg.content ?? "");
    console.error(`\n[共 ${round} 轮 · 最后一轮输入 ${r.usage?.prompt_tokens ?? 0} tokens` +
      ` · finish_reason=${choice.finish_reason}]`);
    done = true;
    break;
  }

  // 模型要调工具。逐个执行，每个调用回填一条 role:"tool" 消息。
  for (const tc of msg.tool_calls ?? []) {
    console.error(`[round ${round}] ${tc.function.name}(${tc.function.arguments})`);
    const result = execute(tc.function.name, tc.function.arguments);
    history.push({
      role: "tool",
      tool_call_id: tc.id, // 一次调用一张回执，靠这个 ID 对上号
      content: result,
    });
  }
}
if (!done) {
  console.error(`达到 ${maxRounds} 轮上限，停止。`);
  process.exit(1);
}

// send 就是练习 1 的非流式请求，多带一个 tools 字段。
async function send(base, apiKey, model, history) {
  const body = JSON.stringify({
    model,
    max_tokens: 4096,
    messages: history,
    tools: TOOLS,
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
