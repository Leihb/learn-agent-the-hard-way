# Learn Agent the Hard Way — 练习 3：多轮对话
#
# API 没有"会话"。所谓对话，是你维护的一个数组 + 一个 for 循环。
# 这一章练习 1 埋的伏笔全部收回。
import json
import os
import sys
import urllib.error
import urllib.request


def main():
    api_key = os.environ.get("OPENAI_API_KEY", "")
    model = os.environ.get("MODEL", "")
    if not api_key or not model:
        print("需要环境变量 OPENAI_API_KEY 和 MODEL", file=sys.stderr)
        print("例: export OPENAI_API_KEY=sk-xxxx", file=sys.stderr)
        print("    export MODEL=deepseek-v4-flash", file=sys.stderr)
        print("    export OPENAI_BASE_URL=https://api.deepseek.com/v1  # 不设则默认 OpenAI 官方", file=sys.stderr)
        sys.exit(1)
    base = os.environ.get("OPENAI_BASE_URL", "") or "https://api.openai.com/v1"

    # 对话的全部状态就是这个数组。system 消息坐第 0 位，开场写一次，
    # 整场不动——它是给模型的"人设"，每一轮都会跟着历史重新发出去。
    history = [
        {"role": "system", "content": "你是一个说话简洁的助手，回答不超过三句话。"},
    ]

    print("输入你的话，回车发送；输入 exit 退出。")
    while True:
        try:
            user_input = input("> ").strip()  # Ctrl+D（EOF）会抛 EOFError
        except EOFError:
            break
        if not user_input:
            continue
        if user_input == "exit":
            break

        # 先把用户的话放进历史，再发送——发出去的快照必须包含它。
        history.append({"role": "user", "content": user_input})

        reply = send(base, api_key, model, history)
        if reply is None:
            # 发送失败：把刚才 append 的那条弹回来。
            # 不弹的话，用户重试一次，历史里就有两条一样的话。
            history.pop()
            continue

        # 回复原样塞回历史——练习 1 说过：它和你发出去的消息是同一个形状。
        # 下一轮模型能"记得"自己说过什么，全靠这一行。
        history.append({"role": "assistant", "content": reply})


# send 把整个 history 发出去，流式打印回复，返回攒好的完整文本；失败返回 None。
# 打印是给人看的，攒是给下一轮用的——同一份字节，两个去处。
def send(base, api_key, model, history):
    body = json.dumps({
        "model": model,
        "max_tokens": 1024,
        "messages": history,
        "stream": True,
        "stream_options": {"include_usage": True},
    }).encode()

    req = urllib.request.Request(
        base + "/chat/completions",
        data=body,
        headers={
            "Content-Type": "application/json",
            "Authorization": "Bearer " + api_key,
            "Accept": "text/event-stream",
        },
    )
    try:
        resp = urllib.request.urlopen(req)
    except urllib.error.HTTPError as e:
        print(f"HTTP {e.code}: {e.read().decode(errors='replace')}", file=sys.stderr)
        return None
    except OSError as e:
        print("请求失败:", e, file=sys.stderr)
        return None

    full = []  # 攒完整回复，退出前拼起来塞回 history
    finish = ""
    in_tok = out_tok = 0
    try:
        with resp:
            for raw in resp:
                line = raw.decode("utf-8").rstrip("\r\n")
                if not line.startswith("data:"):
                    continue
                data = line.removeprefix("data:").removeprefix(" ")
                if not data:
                    continue
                if data == "[DONE]":
                    break

                try:
                    c = json.loads(data)
                except json.JSONDecodeError as e:
                    print(f"\n解析失败: {e}\n原始行: {data}", file=sys.stderr)
                    return None
                if c.get("error"):
                    print(f"\nAPI 错误 [{c['error'].get('type')}]: {c['error'].get('message')}", file=sys.stderr)
                    return None
                if c.get("usage"):
                    in_tok = c["usage"].get("prompt_tokens", 0)
                    out_tok = c["usage"].get("completion_tokens", 0)
                choices = c.get("choices") or []
                if not choices:
                    continue
                d = (choices[0].get("delta") or {}).get("content", "")
                if d:
                    print(d, end="", flush=True)
                    full.append(d)
                if choices[0].get("finish_reason"):
                    finish = choices[0]["finish_reason"]
    except OSError as e:
        print("\n读流失败:", e, file=sys.stderr)
        return None

    print(flush=True)
    print(f"[输入 {in_tok} tokens · 输出 {out_tok} tokens · finish_reason={finish}]", file=sys.stderr)
    return "".join(full)


if __name__ == "__main__":
    main()
