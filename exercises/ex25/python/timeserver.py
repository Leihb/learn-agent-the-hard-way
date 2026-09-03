# timeserver 是一个最小的 MCP 服务器，给练习 22 的客户端当陪练：
# initialize / tools/list / tools/call 三个方法，两个工具。真实项目里
# 服务器一般用官方 SDK 写，这里手写协议是为了让你看清线上到底流过什么
# ——它和客户端说的是同一种话，一行一个 JSON 对象。
import json
import sys
from datetime import date, datetime

WEEKDAYS = ["星期一", "星期二", "星期三", "星期四", "星期五", "星期六", "星期日"]


def reply(id_, result):
    sys.stdout.write(json.dumps({"jsonrpc": "2.0", "id": id_, "result": result}, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def reply_err(id_, code, message):
    sys.stdout.write(json.dumps({"jsonrpc": "2.0", "id": id_, "error": {"code": code, "message": message}},
                                 ensure_ascii=False) + "\n")
    sys.stdout.flush()


def run_tool(name, args):
    if name == "current_time":
        now = datetime.now()
        return f"{now.strftime('%Y-%m-%d %H:%M:%S')} {WEEKDAYS[now.weekday()]}"
    if name == "days_between":
        try:
            start = date.fromisoformat(args["start"])
        except (KeyError, ValueError) as e:
            raise ValueError(f"start 不是合法日期（要 YYYY-MM-DD）: {e}") from None
        try:
            end = date.fromisoformat(args["end"])
        except (KeyError, ValueError) as e:
            raise ValueError(f"end 不是合法日期（要 YYYY-MM-DD）: {e}") from None
        return f"{(end - start).days} 天"
    raise ValueError(f"没有这个工具: {name}")


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            m = json.loads(line)
        except json.JSONDecodeError:
            continue
        method = m.get("method")
        id_ = m.get("id")
        if method == "initialize":
            reply(id_, {
                "protocolVersion": "2024-11-05",
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "timeserver", "version": "0.1"},
            })
        elif method == "notifications/initialized":
            continue  # 通知没有 id，不需要回复
        elif method == "tools/list":
            reply(id_, {"tools": [
                {
                    "name": "current_time",
                    "description": "返回服务器本地的当前日期、时间和星期几。",
                    "inputSchema": {"type": "object", "properties": {}},
                },
                {
                    "name": "days_between",
                    "description": "计算两个日期之间隔多少天（格式 2026-01-02，结束早于开始时为负数）。",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "start": {"type": "string", "description": "开始日期，YYYY-MM-DD"},
                            "end": {"type": "string", "description": "结束日期，YYYY-MM-DD"},
                        },
                        "required": ["start", "end"],
                    },
                },
            ]})
        elif method == "tools/call":
            params = m.get("params") or {}
            try:
                text = run_tool(params.get("name"), params.get("arguments") or {})
            except Exception as e:
                # 工具收到了调用但干活失败：isError 是结果的一部分，
                # 不是协议错误——客户端那侧对这两种要分开处理。
                reply(id_, {"content": [{"type": "text", "text": str(e)}], "isError": True})
                continue
            reply(id_, {"content": [{"type": "text", "text": text}]})
        else:
            if id_ is not None:
                reply_err(id_, -32601, "没有这个方法: " + str(method))


if __name__ == "__main__":
    main()
