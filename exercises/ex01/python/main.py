# Learn Harness the Hard Way — 练习 1：一次 API 调用
#
# 你的 agent 的一切，都从这一个 HTTP 请求开始。
import json
import os
import sys
import urllib.error
import urllib.request


def main():
    if len(sys.argv) < 2:
        print('用法: python3 main.py "你的问题"', file=sys.stderr)
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

    # 请求体的最小形状。完整协议还有很多字段（tools、stream、reasoning_effort……），
    # 后面的练习会逐个长出来。messages 里的每条消息带 role："system" / "user" / "assistant"——
    # 到练习 5，assistant 的消息里会多出 tool_calls 字段，那是模型伸手干活的地方。
    body = json.dumps({
        "model": model,
        "max_tokens": 1024,
        "messages": [{"role": "user", "content": sys.argv[1]}],
    }).encode()

    req = urllib.request.Request(
        base + "/chat/completions",
        data=body,
        # 两个头，一个都不能少：
        headers={
            "Content-Type": "application/json",
            "Authorization": "Bearer " + api_key,  # 认证
        },
    )
    try:
        with urllib.request.urlopen(req) as resp:
            raw = resp.read()
    except urllib.error.HTTPError as e:
        # 4xx/5xx 的响应体里装的是 API 的错误 JSON——照样读出来，往下按同一套流程解析
        raw = e.read()
    except OSError as e:
        print("请求失败:", e, file=sys.stderr)
        sys.exit(1)

    # 只取我们需要的字段——JSON 里多余的字段不去碰它，这是协议演进的余地。
    try:
        r = json.loads(raw)
    except json.JSONDecodeError as e:
        print(f"解析失败: {e}\n原始响应: {raw.decode(errors='replace')}", file=sys.stderr)
        sys.exit(1)
    if r.get("error"):  # 出错时 API 返回的是这个形状，成功时没有这个字段
        print(f"API 错误 [{r['error'].get('type')}]: {r['error'].get('message')}", file=sys.stderr)
        sys.exit(1)
    choices = r.get("choices") or []
    if not choices:
        print(f"空响应: {raw.decode(errors='replace')}", file=sys.stderr)
        sys.exit(1)

    print(choices[0]["message"]["content"])
    usage = r.get("usage") or {}
    # finish_reason: "stop" | "length" | "tool_calls" …
    print(f"\n[输入 {usage.get('prompt_tokens', 0)} tokens · 输出 {usage.get('completion_tokens', 0)} tokens"
          f" · finish_reason={choices[0].get('finish_reason')}]", file=sys.stderr)


if __name__ == "__main__":
    main()
