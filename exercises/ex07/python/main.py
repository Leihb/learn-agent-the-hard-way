# Learn Agent the Hard Way — 练习 7：bash 是特权工具
#
# 一个 bash 工具顶一万个工具：它什么都能干。所以这一章的代码全是"驯服"——
# 超时不让它挂死循环，截断不让它撑爆上下文，固定 cwd 不让状态漂移，
# 非零退出码当情报回填而不是当异常抛出。
import json
import os
import subprocess
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


# ---- bash：特权工具 ----

# 超时是双层的：不传用默认值，传了也有上限——上限保护的是你，不是模型。
DEFAULT_BASH_TIMEOUT = 30  # 秒
MAX_BASH_TIMEOUT = 120     # 秒
MAX_BASH_OUTPUT = 8 * 1024  # 字节。工具结果会原样进上下文，必须封顶

# WORK_DIR 在启动时定死。每次 bash 调用都是一个全新进程，
# 模型在命令里 cd 到哪里，都随那个进程一起消失——工作目录由 harness 持有。
WORK_DIR = os.getcwd()


class BashTool:
    def definition(self):
        return {
            "name": "bash",
            "description": "在系统 shell 里运行一条命令，返回 stdout 和 stderr。"
                           "命令总是在固定的工作目录执行，cd 不会跨调用生效。"
                           "默认 30 秒超时；预计更久就传 timeout（整数秒，上限 120）。"
                           "能用 read_file / write_file / edit_file 完成的事，优先用那些专用工具。",
            "parameters": {
                "type": "object",
                "properties": {
                    "command": {"type": "string", "description": "要执行的 shell 命令"},
                    "timeout": {"type": "integer", "description": "超时秒数，可选，默认 30，上限 120"},
                },
                "required": ["command"],
            },
        }

    def execute(self, args):
        try:
            params = json.loads(args)
        except json.JSONDecodeError as e:
            return "错误: 参数不是合法 JSON: " + str(e)
        command = params.get("command", "") or ""
        if not command.strip():
            return "错误: command 不能为空"
        d = DEFAULT_BASH_TIMEOUT
        timeout_arg = params.get("timeout") or 0
        if timeout_arg > 0:
            d = timeout_arg
            if d > MAX_BASH_TIMEOUT:
                return (f"错误: timeout 最大 {MAX_BASH_TIMEOUT} 秒。"
                        "要跑更久的命令，把它拆小，或者放弃在一次调用里等它")

        # shell=True 在 POSIX 上就是 /bin/sh -c，和 Go 版一致；
        # stdout=PIPE + stderr=STDOUT 让两路在操作系统层面合成一路，
        # 跟 Go 的 cmd.CombinedOutput() 是同一件事。
        try:
            result = subprocess.run(
                command,
                shell=True,
                cwd=WORK_DIR,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                timeout=d,
            )
        except subprocess.TimeoutExpired as e:
            # 被杀也要把已产生的输出交回去——死前的输出往往就是死因。
            text = tail(e.stdout or b"", MAX_BASH_OUTPUT)
            return f"错误: 命令超过 {d} 秒被终止。被杀前的输出：\n{text}"

        text = tail(result.stdout, MAX_BASH_OUTPUT)
        if result.returncode != 0:
            # 非零退出不是异常，是情报：让模型自己读 exit code 和错误输出。
            return f"{text}\n[exit status {result.returncode}]"
        if text == "":
            return "(命令成功，无输出)"
        return text


# tail 超长时保留结尾——命令的结论和报错几乎总在最后，开头多半是刷屏。
# 在字节层面截断（跟 write_file 的字节计数是同一个讲究），最后才解码成字符串。
def tail(data, max_bytes):
    if len(data) <= max_bytes:
        return data.decode("utf-8", errors="replace")
    cut = data[-max_bytes:]
    i = cut.find(b"\n")
    if i >= 0:
        cut = cut[i + 1:]  # 对齐到整行，别吐半截行
    skipped = len(data) - len(cut)
    return f"[... 前面 {skipped} 字节被截断，只保留结尾 ...]\n" + cut.decode("utf-8", errors="replace")


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
        BashTool(),
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
