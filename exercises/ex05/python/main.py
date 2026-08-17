# Learn Agent the Hard Way — 练习 5：第一个工具
#
# 前四章的一切都是铺垫。这一章，模型第一次碰到你的世界：
# 声明工具 → 模型请求调用 → 你执行 → 结果回填 → 再问模型。
# 这个循环就是 agent loop——全书的心脏，今天完整闭环。
import json
import os
import sys
import urllib.error
import urllib.request

# TOOLS 声明我们的第一个工具：read_file。
# 这是发给模型的工具声明，parameters 是一份 JSON Schema——
# 模型看到的全部就是这些字段：叫什么、干什么、怎么传参。
TOOLS = [{
    "type": "function",
    "function": {
        "name": "read_file",
        "description": "读取一个本地文件，返回它的文本内容。",
        "parameters": {
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "要读取的文件路径（相对或绝对）",
                },
            },
            "required": ["path"],
        },
    },
}]


# execute 按名字分发工具调用。未知工具返回干净的错误文本而不是崩溃——
# 错误也是回填给模型的合法结果，它看得懂，还会自己想办法。
def execute(name, args):
    if name == "read_file":
        return read_file(args)
    return "错误: 未知工具 " + name


def read_file(args):
    # 注意 args 是 JSON **字符串**，不是对象——
    # 模型逐字生成它，协议原样转交，解析是你的事。
    try:
        params = json.loads(args)
    except json.JSONDecodeError as e:
        return "错误: 参数不是合法 JSON: " + str(e)
    try:
        with open(params.get("path", ""), encoding="utf-8", errors="replace") as f:
            return f.read()
    except OSError as e:
        # 不要抛异常，不要 sys.exit——把失败告诉模型，它会调整。
        return "错误: " + str(e)


def main():
    if len(sys.argv) < 2:
        print('用法: python3 main.py "你的任务"', file=sys.stderr)
        sys.exit(1)
    api_key = os.environ.get("OPENAI_API_KEY", "")
    model = os.environ.get("MODEL", "")
    if not api_key or not model:
        print("需要环境变量 OPENAI_API_KEY 和 MODEL", file=sys.stderr)
        print("例: export OPENAI_API_KEY=sk-xxxx", file=sys.stderr)
        print("    export MODEL=deepseek-v4-flash", file=sys.stderr)
        print("    export OPENAI_BASE_URL=https://api.deepseek.com/v1  # 不设则默认 OpenAI 官方", file=sys.stderr)
        sys.exit(1)
    base = os.environ.get("OPENAI_BASE_URL", "") or "https://api.openai.com/v1"

    history = [{"role": "user", "content": sys.argv[1]}]

    # agent loop。注意它和练习 3 的 REPL 是同一个循环，
    # 只是对话的另一方从"人"换成了"工具"。
    max_rounds = 10  # 保险丝：防模型在工具里打转，烧光你的钱包
    for round_no in range(1, max_rounds + 1):
        try:
            r = send(base, api_key, model, history)
        except Exception as e:
            print(e, file=sys.stderr)
            sys.exit(1)
        choice = r["choices"][0]
        msg = choice["message"]
        # 模型的回复原样塞回历史——包括 tool_calls。
        # 少了它，下一轮模型看不到自己发起过调用，协议直接报错。
        history.append(msg)

        # 练习 1 的纪律在这里派上大用场：循环走哪条路，看 finish_reason。
        if choice.get("finish_reason") != "tool_calls":
            print(msg.get("content") or "", flush=True)
            u = r.get("usage") or {}
            print(f"\n[共 {round_no} 轮 · 最后一轮输入 {u.get('prompt_tokens', 0)} tokens"
                  f" · finish_reason={choice.get('finish_reason')}]", file=sys.stderr)
            return

        # 模型要调工具。逐个执行，每个调用回填一条 role:"tool" 消息。
        for tc in msg.get("tool_calls") or []:
            print(f"[round {round_no}] {tc['function']['name']}({tc['function']['arguments']})",
                  file=sys.stderr)
            result = execute(tc["function"]["name"], tc["function"]["arguments"])
            history.append({
                "role": "tool",
                "tool_call_id": tc["id"],  # 一次调用一张回执，靠这个 ID 对上号
                "content": result,
            })

    print(f"达到 {max_rounds} 轮上限，停止。", file=sys.stderr)
    sys.exit(1)


# send 就是练习 1 的非流式请求，多带一个 tools 字段。
def send(base, api_key, model, history):
    body = json.dumps({
        "model": model,
        "max_tokens": 4096,
        "messages": history,
        "tools": TOOLS,
    }).encode()
    req = urllib.request.Request(
        base + "/chat/completions",
        data=body,
        headers={
            "Content-Type": "application/json",
            "Authorization": "Bearer " + api_key,
        },
    )
    try:
        with urllib.request.urlopen(req) as resp:
            raw = resp.read()
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"HTTP {e.code}: {e.read().decode(errors='replace')}") from None
    except OSError as e:
        raise RuntimeError(f"请求失败: {e}") from None

    try:
        r = json.loads(raw)
    except json.JSONDecodeError as e:
        raise RuntimeError(f"解析失败: {e}\n原始响应: {raw.decode(errors='replace')}") from None
    if r.get("error"):
        raise RuntimeError(f"API 错误 [{r['error'].get('type')}]: {r['error'].get('message')}")
    if not r.get("choices"):
        raise RuntimeError(f"空响应: {raw.decode(errors='replace')}")
    return r


if __name__ == "__main__":
    main()
