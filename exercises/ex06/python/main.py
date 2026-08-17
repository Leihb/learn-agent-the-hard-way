# Learn Agent the Hard Way — 练习 6：工具注册表
#
# 练习 5 只有一个工具，if 一下就分发完了。第二个工具来的时候，
# 你要改三个地方；第三个来的时候，你就烦了。烦，就是重构的信号。
# 这一章：工具类 + 注册表，从此加工具 = 加一行。
import json
import os
import sys
import urllib.error
import urllib.request

# ---- 工具层 ----
# 每个工具是一个类，两个方法：一份给模型看的声明（definition），
# 一个真正干活的函数（execute）。octo 里同名接口也是这两个方法——
# 这不是巧合，是这件事的最小形状。


# ReadFileTool 就是练习 5 的 read_file，装进类的壳。
class ReadFileTool:
    def definition(self):
        return {
            "name": "read_file",
            "description": "读取一个本地文件，返回它的文本内容。修改文件前必须先用它读一遍。",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "要读取的文件路径"},
                },
                "required": ["path"],
            },
        }

    def execute(self, args):
        try:
            params = json.loads(args)
        except json.JSONDecodeError as e:
            return "错误: 参数不是合法 JSON: " + str(e)
        try:
            with open(params.get("path", ""), encoding="utf-8", errors="replace") as f:
                return f.read()
        except OSError as e:
            return "错误: " + str(e)


# WriteFileTool 整个写入一个文件（不存在则创建，存在则覆盖）。
class WriteFileTool:
    def definition(self):
        return {
            "name": "write_file",
            "description": "把内容完整写入一个文件。文件不存在就创建，存在就整个覆盖。",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "目标文件路径"},
                    "content": {"type": "string", "description": "要写入的完整内容"},
                },
                "required": ["path", "content"],
            },
        }

    def execute(self, args):
        try:
            params = json.loads(args)
        except json.JSONDecodeError as e:
            return "错误: 参数不是合法 JSON: " + str(e)
        content = params.get("content", "")
        try:
            with open(params.get("path", ""), "w", encoding="utf-8") as f:
                f.write(content)
        except OSError as e:
            return "错误: " + str(e)
        # len(content) 是字符数不是字节数——中文会对不上，按 UTF-8 编码后再数
        return f"已写入 {params.get('path')}（{len(content.encode('utf-8'))} 字节）"


# EditFileTool 精确替换文件中的一段文本。octo 的设计原样蒸馏：
# old_string 必须在文件里恰好出现一次——多了说明定位不唯一，少了说明找错了，
# 两种都拒绝执行。这比"按行号改"可靠得多：行号在模型的记忆里会漂，原文不会。
class EditFileTool:
    def definition(self):
        return {
            "name": "edit_file",
            "description": "在已有文件里做一次精确替换。old_string 必须与文件现有内容逐字一致，"
                           "且只出现一次——不唯一时请带上足够的上下文再试。文件必须已存在（创建用 write_file）。",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "目标文件路径"},
                    "old_string": {"type": "string", "description": "要找到的原文，必须唯一"},
                    "new_string": {"type": "string", "description": "替换成的新文本，可以为空（等于删除）"},
                },
                "required": ["path", "old_string", "new_string"],
            },
        }

    def execute(self, args):
        try:
            params = json.loads(args)
        except json.JSONDecodeError as e:
            return "错误: 参数不是合法 JSON: " + str(e)
        path = params.get("path", "")
        old = params.get("old_string", "")
        new = params.get("new_string", "")
        try:
            with open(path, encoding="utf-8") as f:
                text = f.read()
        except OSError as e:
            return "错误: " + str(e)
        if old == "":
            return "错误: old_string 不能为空"
        n = text.count(old)
        if n == 0:
            return "错误: old_string 在文件里找不到——和 read_file 看到的原文逐字对一下"
        if n > 1:
            return f"错误: old_string 出现了 {n} 次，无法确定改哪一处——多带几行上下文让它唯一"
        text = text.replace(old, new, 1)
        try:
            with open(path, "w", encoding="utf-8") as f:
                f.write(text)
        except OSError as e:
            return "错误: " + str(e)
        return "已替换 " + path + " 中的一处文本"


# ---- 注册表层 ----

# Registry 按名字分发工具调用，并在这一层安装横切纪律。
# 纪律装在注册表而不是某个工具里，因为它管的是工具**之间**的关系。
class Registry:
    def __init__(self, *tools):
        # Go 版要单独存一份 order 切片保持声明顺序（map 遍历是乱序的）；
        # Python 的 dict 自带插入序，这个字段直接省了。
        self.tools = {}
        self.has_read = set()  # read-before-write 记录：这个会话里读过哪些文件
        for t in tools:
            self.tools[t.definition()["name"]] = t

    # definitions 生成发给模型的 tools 数组。
    def definitions(self):
        return [{"type": "function", "function": t.definition()}
                for t in self.tools.values()]

    # execute 查表分发。改文件的调用先过 read-before-write 检查：
    # 没读过就想改一个已存在的文件？拒绝——模型会先去读，然后带着事实回来。
    def execute(self, name, args):
        t = self.tools.get(name)
        if t is None:
            return "错误: 未知工具 " + name
        if name in ("write_file", "edit_file"):
            path = path_of(args)
            if path and os.path.exists(path) and path not in self.has_read:
                return "错误: " + path + " 已存在但这个会话里还没读过它。先用 read_file 看一眼，再来修改。"
        result = t.execute(args)
        # 调用成功就记账：读过的文件可以改；刚写完的文件模型知道最新内容，也算读过。
        path = path_of(args)
        if path and not result.startswith("错误:"):
            self.has_read.add(path)
        return result


def path_of(args):
    try:
        return (json.loads(args) or {}).get("path", "") or ""
    except json.JSONDecodeError:
        return ""


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

    # 全部工具在这里注册。加第四个工具 = 在这里加一行，别处一个字不用动。
    reg = Registry(
        ReadFileTool(),
        WriteFileTool(),
        EditFileTool(),
    )

    history = [{"role": "user", "content": sys.argv[1]}]

    # agent loop 的结构和练习 5 完全一样。变化只有两处：
    # 工具声明从注册表拿（reg.definitions），分发交给注册表（reg.execute）。
    max_rounds = 10
    for round_no in range(1, max_rounds + 1):
        try:
            r = send(base, api_key, model, history, reg.definitions())
        except Exception as e:
            print(e, file=sys.stderr)
            sys.exit(1)
        choice = r["choices"][0]
        msg = choice["message"]
        history.append(msg)

        if choice.get("finish_reason") != "tool_calls":
            print(msg.get("content") or "", flush=True)
            u = r.get("usage") or {}
            print(f"\n[共 {round_no} 轮 · 最后一轮输入 {u.get('prompt_tokens', 0)} tokens"
                  f" · finish_reason={choice.get('finish_reason')}]", file=sys.stderr)
            return

        for tc in msg.get("tool_calls") or []:
            print(f"[round {round_no}] {tc['function']['name']}({tc['function']['arguments']})",
                  file=sys.stderr)
            result = reg.execute(tc["function"]["name"], tc["function"]["arguments"])
            history.append({
                "role": "tool",
                "tool_call_id": tc["id"],
                "content": result,
            })

    print(f"达到 {max_rounds} 轮上限，停止。", file=sys.stderr)
    sys.exit(1)


def send(base, api_key, model, history, tools):
    body = json.dumps({
        "model": model,
        "max_tokens": 4096,
        "messages": history,
        "tools": tools,
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
