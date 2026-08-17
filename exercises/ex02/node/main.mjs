// Learn Agent the Hard Way — 练习 2：流式输出
//
// 和练习 1 同一个请求，多一个字段：stream。
// 响应从一份 JSON 变成一条流——你的 harness 从此有了"边生成边看"的感官。

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

// 请求体比练习 1 多了 stream 和 stream_options 两个字段。
// stream_options.include_usage 让服务端在流的最后补一个带 usage 的块。
// 不带这个选项，OpenAI 和多数兼容服务商在流式下不报 token 数——账单直接消失。
const body = JSON.stringify({
  model,
  max_tokens: 1024,
  messages: [{ role: "user", content: question }],
  stream: true,
  stream_options: { include_usage: true },
});

let resp;
try {
  resp = await fetch(base + "/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + apiKey,
      "Accept": "text/event-stream", // 声明：我要的是事件流
    },
    body,
  });
} catch (err) {
  console.error("请求失败:", err.cause ?? err);
  process.exit(1);
}

// 流式请求失败在"开流之前"：非 200 时响应体是普通 JSON，不是流。
if (!resp.ok) {
  console.error(`HTTP ${resp.status}: ${await resp.text()}`);
  process.exit(1);
}

// fetch 的流给的是字节块，不是行——块的边界和行的边界无关，
// 甚至可能把一个多字节汉字劈成两半。所以要自己攒：
// TextDecoder 的 {stream:true} 负责补齐半个字，buf 负责补齐半行。
const decoder = new TextDecoder();
let buf = "";
let finish = "";
let inTok = 0;
let outTok = 0;

try {
  stream: for await (const bytes of resp.body) {
    buf += decoder.decode(bytes, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, "");
      buf = buf.slice(nl + 1);
      // SSE 的全部语法就这一条：以 "data:" 开头的行，后面跟一份 JSON。
      // 冒号后那个空格按规范是可选的——OpenAI 和 DeepSeek 会发，
      // 有的兼容服务商不发，所以两段都要剥。
      if (!line.startsWith("data:")) continue;
      let data = line.slice(5);
      if (data.startsWith(" ")) data = data.slice(1);
      if (!data) continue;
      if (data === "[DONE]") break stream; // 终止哨兵：流到头了

      let c;
      try {
        c = JSON.parse(data);
      } catch (err) {
        console.error(`\n解析失败: ${err}\n原始行: ${data}`);
        process.exit(1);
      }
      if (c.error) { // 200 之后服务端也可能在流里报错——形状和练习 1 相同
        console.error(`\nAPI 错误 [${c.error.type}]: ${c.error.message}`);
        process.exit(1);
      }
      if (c.usage) { // 只在 include_usage 补发的终块上出现
        inTok = c.usage.prompt_tokens ?? 0;
        outTok = c.usage.completion_tokens ?? 0;
      }
      if (!c.choices?.length) continue; // include_usage 的终块没有 choices
      if (c.choices[0].delta?.content) {
        process.stdout.write(c.choices[0].delta.content); // 到手就打，不攒
      }
      if (c.choices[0].finish_reason) { // 只在最后一个内容块上非空
        finish = c.choices[0].finish_reason;
      }
    }
  }
} catch (err) {
  console.error("\n读流失败:", err);
  process.exit(1);
}

console.log();
console.error(`\n[输入 ${inTok} tokens · 输出 ${outTok} tokens · finish_reason=${finish}]`);
