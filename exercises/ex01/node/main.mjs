// Learn Harness the Hard Way — 练习 1：一次 API 调用
//
// 你的 agent 的一切，都从这一个 HTTP 请求开始。

const question = process.argv[2];
if (!question) {
  console.error('用法: node main.mjs "你的问题"');
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

// 请求体的最小形状。完整协议还有很多字段（tools、stream、reasoning_effort……），
// 后面的练习会逐个长出来。messages 里的每条消息带 role："system" / "user" / "assistant"——
// 到练习 5，assistant 的消息里会多出 tool_calls 字段，那是模型伸手干活的地方。
const body = JSON.stringify({
  model,
  max_tokens: 1024,
  messages: [{ role: "user", content: question }],
});

let resp;
try {
  resp = await fetch(base + "/chat/completions", {
    method: "POST",
    // 两个头，一个都不能少：
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + apiKey, // 认证
    },
    body,
  });
} catch (err) {
  console.error("请求失败:", err.cause ?? err);
  process.exit(1);
}

// fetch 对 4xx/5xx 不抛错——错误响应的 body 里装的是 API 的错误 JSON，照样往下解析。
// 只取我们需要的字段——JSON 里多余的字段不去碰它，这是协议演进的余地。
const raw = await resp.text();
let r;
try {
  r = JSON.parse(raw);
} catch (err) {
  console.error(`解析失败: ${err}\n原始响应: ${raw}`);
  process.exit(1);
}
if (r.error) { // 出错时 API 返回的是这个形状，成功时没有这个字段
  console.error(`API 错误 [${r.error.type}]: ${r.error.message}`);
  process.exit(1);
}
if (!r.choices?.length) {
  console.error(`空响应: ${raw}`);
  process.exit(1);
}

console.log(r.choices[0].message.content);
// finish_reason: "stop" | "length" | "tool_calls" …
console.error(
  `\n[输入 ${r.usage?.prompt_tokens ?? 0} tokens · 输出 ${r.usage?.completion_tokens ?? 0} tokens` +
  ` · finish_reason=${r.choices[0].finish_reason}]`,
);
