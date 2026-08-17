# Learn Agent the Hard Way — 练习 4：provider 抽象
#
# 同一份 REPL，接两种协议。差别全部关进两个适配器里，
# 循环本身一个字不改——这就是抽象层的全部价值。
#
# Go 版在这里声明了本书第一个 interface；Python 不用声明——鸭子类型：
# 两个类各有一个同签名的 send(system, history) 方法，形状对了就能互换。
# 两种协议的全部差异，都消失在这个签名后面。
import json
import os
import sys
import urllib.error
import urllib.request


# ---- OpenAI 协议适配器（练习 1 的代码装进盒子）----

class OpenAIProvider:
    def __init__(self, base, key, model):
        self.base, self.key, self.model = base, key, model

    def send(self, system, history):
        # OpenAI 协议里 system 是 messages 数组的第 0 条——塞回去。
        msgs = [{"role": "system", "content": system}, *history]
        body = json.dumps({
            "model": self.model,
            "max_tokens": 1024,  # 可以不传，各家有默认值
            "messages": msgs,
        }).encode()

        raw = do(self.base + "/chat/completions", body, {
            "Content-Type": "application/json",
            "Authorization": "Bearer " + self.key,  # 认证：标准 Bearer
        })

        try:
            r = json.loads(raw)
        except json.JSONDecodeError as e:
            raise RuntimeError(f"解析失败: {e}") from None
        if not r.get("choices"):
            raise RuntimeError(f"空响应: {raw.decode(errors='replace')}")
        u = r.get("usage") or {}
        print(f"[输入 {u.get('prompt_tokens', 0)} tokens · 输出 {u.get('completion_tokens', 0)} tokens"
              f" · finish_reason={r['choices'][0].get('finish_reason')}]", file=sys.stderr)
        return r["choices"][0]["message"]["content"]


# ---- Anthropic 协议适配器（对照组）----

class AnthropicProvider:
    def __init__(self, base, key, model):
        self.base, self.key, self.model = base, key, model

    def send(self, system, history):
        body = json.dumps({
            "model": self.model,
            "max_tokens": 1024,   # 这家必填（Ollama 不传直接拒绝）
            "system": system,     # system 不进 messages，是顶层字段
            "messages": list(history),
        }).encode()

        raw = do(self.base + "/v1/messages", body, {
            "Content-Type": "application/json",
            "x-api-key": self.key,                 # 认证：自家头，没有 Bearer
            "anthropic-version": "2023-06-01",     # 版本头，官方必带
        })

        try:
            r = json.loads(raw)
        except json.JSONDecodeError as e:
            raise RuntimeError(f"解析失败: {e}") from None
        # 回复不是一个字符串，是一个列表——每一项自带类型标签，
        # 正文只是其中一种（还有思考、工具调用……）。我们只挑正文。
        reply = "".join(b.get("text", "")
                        for b in (r.get("content") or []) if b.get("type") == "text")
        u = r.get("usage") or {}
        print(f"[输入 {u.get('input_tokens', 0)} tokens · 输出 {u.get('output_tokens', 0)} tokens"
              f" · stop_reason={r.get('stop_reason')}]", file=sys.stderr)
        return reply


# do 发出请求，非 200 时把响应体当错误抛出。两个适配器共用。
def do(url, body, headers):
    req = urllib.request.Request(url, data=body, headers=headers)
    try:
        with urllib.request.urlopen(req) as resp:
            return resp.read()
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"HTTP {e.code}: {e.read().decode(errors='replace')}") from None


# ---- 同一个 REPL，练习 3 原样搬来（只是退回非流式）----

def main():
    proto = os.environ.get("PROTOCOL", "")
    if proto in ("", "openai"):
        base = os.environ.get("OPENAI_BASE_URL", "") or "https://api.openai.com/v1"
        p = OpenAIProvider(base, os.environ.get("OPENAI_API_KEY", ""), os.environ.get("MODEL", ""))
    elif proto == "anthropic":
        base = os.environ.get("ANTHROPIC_BASE_URL", "") or "https://api.anthropic.com"
        p = AnthropicProvider(base, os.environ.get("ANTHROPIC_API_KEY", ""), os.environ.get("MODEL", ""))
    else:
        print(f"未知 PROTOCOL {proto!r}（要 openai 或 anthropic）", file=sys.stderr)
        sys.exit(1)

    system = "你是一个说话简洁的助手，回答不超过三句话。"
    history = []

    print("输入你的话，回车发送；输入 exit 退出。")
    while True:
        try:
            user_input = input("> ").strip()
        except EOFError:
            break
        if not user_input:
            continue
        if user_input == "exit":
            break

        history.append({"role": "user", "content": user_input})
        try:
            reply = p.send(system, history)
        except Exception as e:  # 网络错、非 200、解析失败，都从这里出来
            print(e, file=sys.stderr)
            history.pop()  # 失败弹回，练习 3 的纪律
            continue
        print(reply)
        history.append({"role": "assistant", "content": reply})


if __name__ == "__main__":
    main()
