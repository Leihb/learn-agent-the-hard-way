# Learn Agent the Hard Way — 练习 2：流式输出
#
# 和练习 1 同一个请求，多一个字段：stream。
# 响应从一份 JSON 变成一条流——你的 harness 从此有了"边生成边看"的感官。
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

    # 请求体比练习 1 多了 stream 和 stream_options 两个字段。
    # stream_options.include_usage 让服务端在流的最后补一个带 usage 的块。
    # 不带这个选项，OpenAI 和多数兼容服务商在流式下不报 token 数——账单直接消失。
    body = json.dumps({
        "model": model,
        "max_tokens": 1024,
        "messages": [{"role": "user", "content": sys.argv[1]}],
        "stream": True,
        "stream_options": {"include_usage": True},
    }).encode()

    req = urllib.request.Request(
        base + "/chat/completions",
        data=body,
        headers={
            "Content-Type": "application/json",
            "Authorization": "Bearer " + api_key,
            "Accept": "text/event-stream",  # 声明：我要的是事件流
        },
    )
    # 流式请求失败在"开流之前"：非 200 时响应体是普通 JSON，不是流——
    # urllib 会把它抛成 HTTPError，正好在这里整个接住。
    try:
        resp = urllib.request.urlopen(req)
    except urllib.error.HTTPError as e:
        print(f"HTTP {e.code}: {e.read().decode(errors='replace')}", file=sys.stderr)
        sys.exit(1)
    except OSError as e:
        print("请求失败:", e, file=sys.stderr)
        sys.exit(1)

    finish = ""
    in_tok = out_tok = 0
    try:
        with resp:
            # resp 是个文件对象，迭代它就是一行一行地读——行是随生成随到的。
            for raw in resp:
                line = raw.decode("utf-8").rstrip("\r\n")
                # SSE 的全部语法就这一条：以 "data:" 开头的行，后面跟一份 JSON。
                # 冒号后那个空格按规范是可选的——OpenAI 和 DeepSeek 会发，
                # 有的兼容服务商不发，所以两段都要剥。
                if not line.startswith("data:"):
                    continue
                data = line.removeprefix("data:").removeprefix(" ")
                if not data:
                    continue
                if data == "[DONE]":  # 终止哨兵：流到头了
                    break

                try:
                    c = json.loads(data)
                except json.JSONDecodeError as e:
                    print(f"\n解析失败: {e}\n原始行: {data}", file=sys.stderr)
                    sys.exit(1)
                if c.get("error"):  # 200 之后服务端也可能在流里报错——形状和练习 1 相同
                    print(f"\nAPI 错误 [{c['error'].get('type')}]: {c['error'].get('message')}", file=sys.stderr)
                    sys.exit(1)
                if c.get("usage"):  # 只在 include_usage 补发的终块上出现
                    in_tok = c["usage"].get("prompt_tokens", 0)
                    out_tok = c["usage"].get("completion_tokens", 0)
                choices = c.get("choices") or []
                if not choices:  # include_usage 的终块没有 choices
                    continue
                delta = choices[0].get("delta") or {}
                if delta.get("content"):
                    # 到手就打，不攒。flush=True 是流式的命根子：
                    # Python 的 stdout 自带缓冲，不冲，流就死在你自己手里。
                    print(delta["content"], end="", flush=True)
                if choices[0].get("finish_reason"):  # 只在最后一个内容块上非空
                    finish = choices[0]["finish_reason"]
    except OSError as e:
        print("\n读流失败:", e, file=sys.stderr)
        sys.exit(1)

    print()
    print(f"\n[输入 {in_tok} tokens · 输出 {out_tok} tokens · finish_reason={finish}]", file=sys.stderr)


if __name__ == "__main__":
    main()
