// Learn Agent the Hard Way — 练习 3：多轮对话
//
// API 没有"会话"。所谓对话，是你维护的一个数组 + 一个 for 循环。
// 这一章练习 1 埋的伏笔全部收回。
import * as readline from "node:readline";

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

// 对话的全部状态就是这个数组。system 消息坐第 0 位，开场写一次，
// 整场不动——它是给模型的"人设"，每一轮都会跟着历史重新发出去。
const history = [
  { role: "system", content: "你是一个说话简洁的助手，回答不超过三句话。" },
];

console.log("输入你的话，回车发送；输入 exit 退出。");
// 提示符自己写，不用 readline 的 prompt()——发送期间如果输入到头了
// （比如管道喂进来的输入），readline 会先关掉，再调它的方法就是异常。
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
process.stdout.write("> ");
for await (const rawLine of rl) { // Ctrl+D（EOF）会结束这个循环
  const input = rawLine.trim();
  if (!input) {
    process.stdout.write("> ");
    continue;
  }
  if (input === "exit") break;

  // 先把用户的话放进历史，再发送——发出去的快照必须包含它。
  history.push({ role: "user", content: input });

  const reply = await send(base, apiKey, model, history);
  if (reply === null) {
    // 发送失败：把刚才 push 的那条弹回来。
    // 不弹的话，用户重试一次，历史里就有两条一样的话。
    history.pop();
    process.stdout.write("> ");
    continue;
  }

  // 回复原样塞回历史——练习 1 说过：它和你发出去的消息是同一个形状。
  // 下一轮模型能"记得"自己说过什么，全靠这一行。
  history.push({ role: "assistant", content: reply });
  process.stdout.write("> ");
}
rl.close();

// send 把整个 history 发出去，流式打印回复，返回攒好的完整文本；失败返回 null。
// 打印是给人看的，攒是给下一轮用的——同一份字节，两个去处。
async function send(base, apiKey, model, history) {
  const body = JSON.stringify({
    model,
    max_tokens: 1024,
    messages: history,
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
        "Accept": "text/event-stream",
      },
      body,
    });
  } catch (err) {
    console.error("请求失败:", err.cause ?? err);
    return null;
  }

  if (!resp.ok) {
    console.error(`HTTP ${resp.status}: ${await resp.text()}`);
    return null;
  }

  const decoder = new TextDecoder();
  let buf = "";
  let full = ""; // 攒完整回复，退出前塞回 history
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
        if (!line.startsWith("data:")) continue;
        let data = line.slice(5);
        if (data.startsWith(" ")) data = data.slice(1);
        if (!data) continue;
        if (data === "[DONE]") break stream;

        let c;
        try {
          c = JSON.parse(data);
        } catch (err) {
          console.error(`\n解析失败: ${err}\n原始行: ${data}`);
          return null;
        }
        if (c.error) {
          console.error(`\nAPI 错误 [${c.error.type}]: ${c.error.message}`);
          return null;
        }
        if (c.usage) {
          inTok = c.usage.prompt_tokens ?? 0;
          outTok = c.usage.completion_tokens ?? 0;
        }
        if (!c.choices?.length) continue;
        const d = c.choices[0].delta?.content;
        if (d) {
          process.stdout.write(d);
          full += d;
        }
        if (c.choices[0].finish_reason) {
          finish = c.choices[0].finish_reason;
        }
      }
    }
  } catch (err) {
    console.error("\n读流失败:", err);
    return null;
  }

  console.log();
  console.error(`[输入 ${inTok} tokens · 输出 ${outTok} tokens · finish_reason=${finish}]`);
  return full;
}
