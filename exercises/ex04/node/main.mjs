// Learn Agent the Hard Way — 练习 4：provider 抽象
//
// 同一份 REPL，接两种协议。差别全部关进两个适配器里，
// 循环本身一个字不改——这就是抽象层的全部价值。
//
// Go 版在这里声明了本书第一个 interface；JavaScript 不用声明——
// 两个类各有一个同签名的 send(system, history) 方法，形状对了就能互换。
// 两种协议的全部差异，都消失在这个签名后面。
import * as readline from "node:readline";

// ---- OpenAI 协议适配器（练习 1 的代码装进盒子）----

class OpenAIProvider {
  constructor(base, key, model) {
    this.base = base;
    this.key = key;
    this.model = model;
  }

  async send(system, history) {
    // OpenAI 协议里 system 是 messages 数组的第 0 条——塞回去。
    const msgs = [{ role: "system", content: system }, ...history];
    const raw = await doPost(this.base + "/chat/completions", {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + this.key, // 认证：标准 Bearer
    }, {
      model: this.model,
      max_tokens: 1024, // 可以不传，各家有默认值
      messages: msgs,
    });

    let r;
    try {
      r = JSON.parse(raw);
    } catch (err) {
      throw new Error(`解析失败: ${err}`);
    }
    if (!r.choices?.length) throw new Error(`空响应: ${raw}`);
    console.error(`[输入 ${r.usage?.prompt_tokens ?? 0} tokens · 输出 ${r.usage?.completion_tokens ?? 0} tokens` +
      ` · finish_reason=${r.choices[0].finish_reason}]`);
    return r.choices[0].message.content;
  }
}

// ---- Anthropic 协议适配器（对照组）----

class AnthropicProvider {
  constructor(base, key, model) {
    this.base = base;
    this.key = key;
    this.model = model;
  }

  async send(system, history) {
    const raw = await doPost(this.base + "/v1/messages", {
      "Content-Type": "application/json",
      "x-api-key": this.key,                 // 认证：自家头，没有 Bearer
      "anthropic-version": "2023-06-01",     // 版本头，官方必带
    }, {
      model: this.model,
      max_tokens: 1024,  // 这家必填（Ollama 不传直接拒绝）
      system,            // system 不进 messages，是顶层字段
      messages: history,
    });

    let r;
    try {
      r = JSON.parse(raw);
    } catch (err) {
      throw new Error(`解析失败: ${err}`);
    }
    // 回复不是一个字符串，是一个列表——每一项自带类型标签，
    // 正文只是其中一种（还有思考、工具调用……）。我们只挑正文。
    const reply = (r.content ?? [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");
    console.error(`[输入 ${r.usage?.input_tokens ?? 0} tokens · 输出 ${r.usage?.output_tokens ?? 0} tokens` +
      ` · stop_reason=${r.stop_reason}]`);
    return reply;
  }
}

// doPost 发出请求，非 200 时把响应体当错误抛出。两个适配器共用。
async function doPost(url, headers, payload) {
  const resp = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
  const raw = await resp.text();
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${raw}`);
  return raw;
}

// ---- 同一个 REPL，练习 3 原样搬来（只是退回非流式）----

let p;
const proto = process.env.PROTOCOL ?? "";
if (proto === "" || proto === "openai") {
  const base = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
  p = new OpenAIProvider(base, process.env.OPENAI_API_KEY ?? "", process.env.MODEL ?? "");
} else if (proto === "anthropic") {
  const base = process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com";
  p = new AnthropicProvider(base, process.env.ANTHROPIC_API_KEY ?? "", process.env.MODEL ?? "");
} else {
  console.error(`未知 PROTOCOL "${proto}"（要 openai 或 anthropic）`);
  process.exit(1);
}

const system = "你是一个说话简洁的助手，回答不超过三句话。";
const history = [];

console.log("输入你的话，回车发送；输入 exit 退出。");
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
process.stdout.write("> ");
for await (const rawLine of rl) {
  const input = rawLine.trim();
  if (!input) {
    process.stdout.write("> ");
    continue;
  }
  if (input === "exit") break;

  history.push({ role: "user", content: input });
  let reply;
  try {
    reply = await p.send(system, history);
  } catch (err) { // 网络错、非 200、解析失败，都从这里出来
    console.error(err.message ?? err);
    history.pop(); // 失败弹回，练习 3 的纪律
    process.stdout.write("> ");
    continue;
  }
  console.log(reply);
  history.push({ role: "assistant", content: reply });
  process.stdout.write("> ");
}
rl.close();
