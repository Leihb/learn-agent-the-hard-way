// timeserver 是一个最小的 MCP 服务器，给练习 22 的客户端当陪练：
// initialize / tools/list / tools/call 三个方法，两个工具。真实项目里
// 服务器一般用官方 SDK 写，这里手写协议是为了让你看清线上到底流过什么
// ——它和客户端说的是同一种话，一行一个 JSON 对象。
import { createInterface } from "node:readline";

const WEEKDAYS = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}

function replyErr(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
}

function pad(n) {
  return String(n).padStart(2, "0");
}

function runTool(name, args) {
  if (name === "current_time") {
    const now = new Date();
    const ts = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
      `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    return `${ts} ${WEEKDAYS[now.getDay()]}`;
  }
  if (name === "days_between") {
    const start = new Date((args.start ?? "") + "T00:00:00Z");
    const end = new Date((args.end ?? "") + "T00:00:00Z");
    if (Number.isNaN(start.getTime())) throw new Error("start 不是合法日期（要 YYYY-MM-DD）");
    if (Number.isNaN(end.getTime())) throw new Error("end 不是合法日期（要 YYYY-MM-DD）");
    const days = Math.round((end - start) / 86400000);
    return `${days} 天`;
  }
  throw new Error(`没有这个工具: ${name}`);
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (raw) => {
  const line = raw.trim();
  if (!line) return;
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  const { method, id } = m;
  if (method === "initialize") {
    reply(id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "timeserver", version: "0.1" },
    });
  } else if (method === "notifications/initialized") {
    // 通知没有 id，不需要回复
  } else if (method === "tools/list") {
    reply(id, {
      tools: [
        {
          name: "current_time",
          description: "返回服务器本地的当前日期、时间和星期几。",
          inputSchema: { type: "object", properties: {} },
        },
        {
          name: "days_between",
          description: "计算两个日期之间隔多少天（格式 2026-01-02，结束早于开始时为负数）。",
          inputSchema: {
            type: "object",
            properties: {
              start: { type: "string", description: "开始日期，YYYY-MM-DD" },
              end: { type: "string", description: "结束日期，YYYY-MM-DD" },
            },
            required: ["start", "end"],
          },
        },
      ],
    });
  } else if (method === "tools/call") {
    const { name, arguments: a } = m.params ?? {};
    try {
      const text = runTool(name, a ?? {});
      reply(id, { content: [{ type: "text", text }] });
    } catch (err) {
      // 工具收到了调用但干活失败：isError 是结果的一部分，不是协议
      // 错误——客户端那侧对这两种要分开处理。
      reply(id, { content: [{ type: "text", text: err.message }], isError: true });
    }
  } else if (id !== undefined) {
    replyErr(id, -32601, `没有这个方法: ${method}`);
  }
});
