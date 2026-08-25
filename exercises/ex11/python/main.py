# Learn Agent the Hard Way — 练习 11：会话持久化
#
# 练习 3 说过："对话是幻觉，幻觉的维护者是你"——history 数组活在进程的内存里，
# 进程一退出，幻觉跟着消失。这一章把它写到磁盘上：一次一条，追加写，
# 进程可以死，对话不用死。
import json
import os
import secrets
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime

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
        path = params.get("path", "")
        content = params.get("content", "")
        try:
            backup = backup_if_exists(path)
        except OSError as e:
            return "错误: 备份旧内容失败，为安全起见拒绝覆盖: " + str(e)
        try:
            with open(path, "w", encoding="utf-8") as f:
                f.write(content)
        except OSError as e:
            return "错误: " + str(e)
        # len(content) 是字符数不是字节数——中文会对不上，按 UTF-8 编码后再数
        size = len(content.encode("utf-8"))
        if backup:
            return f"已把旧内容备份到 {backup}，然后写入 {path}（{size} 字节）"
        return f"已写入 {path}（{size} 字节）"


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


# ---- 权限层：拦下危险命令 ----

# decision 是权限检查的结论，档位从低到高：allow < ask < deny。
DECISION_ALLOW = 0
DECISION_ASK = 1
DECISION_DENY = 2

# BASH_RULES 蒸馏自 octo 的 internal/permission/defaults.yml——声明顺序不重要，
# 重要的是档位：deny 赢 ask，ask 赢 allow。一条规则都没命中时，隐式默认是
# ask——宁可多问一句，不要放过一个没见过的命令。
BASH_RULES = [
    ("rm -rf /", DECISION_DENY),
    ("rm -rf ~", DECISION_DENY),
    ("rm -rf", DECISION_ASK),
    ("sudo ", DECISION_ASK),
    ("git push --force", DECISION_ASK),
    ("curl ", DECISION_ASK),
    ("ls", DECISION_ALLOW),
    ("cat ", DECISION_ALLOW),
    ("pwd", DECISION_ALLOW),
    ("echo ", DECISION_ALLOW),
    ("git status", DECISION_ALLOW),
]


# classify_bash 给一条 shell 命令分档。分三遍独立扫描，而不是一遍碰到就返回，
# 就是为了让"deny 赢 ask 赢 allow"这件事跟规则声明的先后顺序无关。
def classify_bash(cmd):
    for pattern, decide in BASH_RULES:
        if decide == DECISION_DENY and pattern in cmd:
            return DECISION_DENY
    for pattern, decide in BASH_RULES:
        if decide == DECISION_ASK and pattern in cmd:
            return DECISION_ASK
    trimmed = cmd.lstrip(" \t")
    for pattern, decide in BASH_RULES:
        if decide != DECISION_ALLOW or pattern not in cmd:
            continue
        # allow 比 deny/ask 挑剔：命令必须以这个词开头，且整条命令里不能有
        # shell 的链接符号——否则 "ls && rm -rf /" 会被 "ls" 这条规则放行。
        if trimmed.startswith(pattern) and not contains_shell_chain(cmd):
            return DECISION_ALLOW
    return DECISION_ASK


# contains_shell_chain 检查命令里有没有把一条命令接到另一条上的符号。
def contains_shell_chain(cmd):
    return any(ch in cmd for ch in ";|&$()`\n")


# ask_approval 停下来问人，不是问模型——危险命令要过这一关，
# 模型自己怎么想不算数。读不到回答（比如脚本化调用、没有终端）一律按拒绝处理，
# 安全边界宁可保守，不能因为读不到输入就放行。
def ask_approval(cmd):
    print(f"\n⚠️  模型想执行: {cmd}\n允许吗？(y/N) ", end="", file=sys.stderr, flush=True)
    try:
        line = sys.stdin.readline()
    except OSError:
        return False
    if not line:  # 读到 EOF，没有任何输入
        return False
    answer = line.strip().lower()
    return answer in ("y", "yes")


def command_of(args):
    try:
        return (json.loads(args) or {}).get("command", "") or ""
    except json.JSONDecodeError:
        return ""


# ---- 备份层：覆盖前留一份 ----

# TRASH_DIR 是备份落地的地方，就在工作目录底下——足够找、足够简单，
# 不需要 octo 真实实现里那套按项目哈希分桶的复杂结构。
TRASH_DIR = ".trash"


# backup_if_exists 在覆盖一个已存在的文件前，把旧内容原样复制进 TRASH_DIR，
# 文件名前缀时间戳避免撞名。目标文件本来就不存在时什么都不做，返回空字符串
# ——没有"旧版本"可备份。这是覆盖前的最后一步，不是覆盖的替代品：
# write_file 该做的事一件没少，只是多了一份退路。
def backup_if_exists(path):
    if not os.path.exists(path):
        return ""
    os.makedirs(TRASH_DIR, exist_ok=True)
    with open(path, "rb") as f:
        data = f.read()
    ts = time.strftime("%Y%m%d-%H%M%S")
    dest = os.path.join(TRASH_DIR, f"{ts}_{os.path.basename(path)}")
    with open(dest, "wb") as f:
        f.write(data)
    return dest


# restore 找 TRASH_DIR 里这个文件名最新的一份备份，写回原路径。恢复动作
# 本身也先给"现在这份"备份一次——误删保护对自己也生效，不会因为你手滑
# 恢复错了版本就白白丢掉当前内容。
def restore(path):
    try:
        entries = os.listdir(TRASH_DIR)
    except OSError as e:
        print(f"错误: 没有找到 {TRASH_DIR} 目录，或读取失败: {e}", file=sys.stderr)
        return 1
    suffix = "_" + os.path.basename(path)
    newest = ""
    for name in entries:
        if name.endswith(suffix) and name > newest:
            newest = name
    if not newest:
        print(f"错误: {TRASH_DIR} 里没有 {os.path.basename(path)} 的备份", file=sys.stderr)
        return 1
    try:
        backup_if_exists(path)
    except OSError as e:
        print(f"错误: 备份当前版本失败，为安全起见拒绝恢复: {e}", file=sys.stderr)
        return 1
    src = os.path.join(TRASH_DIR, newest)
    try:
        with open(src, "rb") as f:
            data = f.read()
        with open(path, "wb") as f:
            f.write(data)
    except OSError as e:
        print(f"错误: {e}", file=sys.stderr)
        return 1
    print(f"已从 {src} 恢复到 {path}")
    return 0


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
    # bash 调用还要多过一关：权限检查。这一关不问模型愿不愿意，
    # deny 直接拒绝、ask 停下来问人——两种情况下面这行 t.execute 都不会被跑到，
    # 真正跑 subprocess.run 的代码，危险命令根本够不着。
    def execute(self, name, args):
        t = self.tools.get(name)
        if t is None:
            return "错误: 未知工具 " + name
        if name in ("write_file", "edit_file"):
            path = path_of(args)
            if path and os.path.exists(path) and path not in self.has_read:
                return "错误: " + path + " 已存在但这个会话里还没读过它。先用 read_file 看一眼，再来修改。"
        if name == "bash":
            cmd = command_of(args)
            decision = classify_bash(cmd)
            if decision == DECISION_DENY:
                return "错误: 权限拒绝——这条命令匹配了硬性禁止规则，不会执行，也不会询问。"
            if decision == DECISION_ASK and not ask_approval(cmd):
                return "错误: 权限拒绝——用户没有批准这条命令。"
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


# ---- base prompt：给模型的说明书 ----

# BASE_PROMPT 蒸馏自 octo 的 internal/prompt/base.md——生产 harness 里
# 模型真实读到的规矩，这里只留下和我们这四个工具相关的几条。
# 它坐进 history 第 0 位的 system 消息，练习 3 你已经知道这个位置；
# 没讲过的是：为什么内容从此定死，一个字都不该在会话中途改。
BASE_PROMPT = """你是一个能操作本地文件和 shell 的助手，通过工具真正执行动作，而不是描述打算做什么。

- 能用 read_file / write_file / edit_file 完成的事，优先用它们；bash 留给专用工具做不到的事（跑测试、跑 git、装依赖、查系统信息）。
- 修改一个已经存在的文件前，必须先用 read_file 读过它一遍——这条规矩不因为你换了工具执行修改就不算数：用 bash 的 echo / sed / tee 等方式直接改文件内容，同样要先读一遍再动手。能用 edit_file 完成的局部修改，优先用 edit_file 而不是 sed -i，这样改动会经过校验，而不是绕开它。
- 只做任务要求的改动，不顺手重构、不改无关代码。"""


# ---- 会话层：把 history 写到磁盘上 ----

# SESSION_DIR 是会话文件存放的地方，跟 .trash 一样就在工作目录底下。
SESSION_DIR = ".sessions"


# Session 是一次对话的全部状态：一个 ID，加上完整的 history。persisted
# 记录 history 里前多少条消息已经写盘——save 只补写 persisted 之后新增的
# 部分，不是每次都把整个文件重写一遍。这是这一章的核心账本：存盘的代价
# 只跟"这一轮新增了多少条"有关，跟"这场对话已经聊了多久"无关。
class Session:
    def __init__(self, id, created_at="", history=None):
        self.id = id
        self.created_at = created_at
        self.history = history if history is not None else []
        self.persisted = 0

    # save 只追加 history[persisted:]。没有新消息时是个空操作——
    # 一轮里模型只回了一句话、没有工具调用，这一次 save 就什么都不写。
    def save(self):
        if len(self.history) == self.persisted:
            return
        with open(session_path(self.id), "a", encoding="utf-8") as f:
            for msg in self.history[self.persisted:]:
                f.write(encode_record({"type": "message", "message": msg}))
        self.persisted = len(self.history)


# encode_record 把一条记录编成 JSONL 里的一行：紧凑、不换行、末尾补一个 \n。
# ensure_ascii=False 让中文原样落盘，而不是变成 \uXXXX——文件是给人也能打开看的。
def encode_record(rec):
    return json.dumps(rec, ensure_ascii=False) + "\n"


# new_session_id 生成 时间戳-随机后缀 形式的 ID：时间戳让它天然按时间排序、
# 人眼可读；随机后缀避免同一秒内两个会话撞名。
def new_session_id():
    return time.strftime("%Y%m%d-%H%M%S") + "-" + secrets.token_hex(4)


def session_path(id):
    return os.path.join(SESSION_DIR, id + ".jsonl")


# new_session_file 开一个新会话：建目录、写 meta 头，返回可以继续追加的 Session。
def new_session_file(history):
    os.makedirs(SESSION_DIR, exist_ok=True)
    s = Session(new_session_id(), datetime.now().astimezone().isoformat(), history)
    with open(session_path(s.id), "w", encoding="utf-8") as f:
        f.write(encode_record({"type": "meta", "id": s.id, "created_at": s.created_at}))
        for msg in history:
            f.write(encode_record({"type": "message", "message": msg}))
    s.persisted = len(history)
    return s


# load_session 读一份 JSONL，把 meta 和 message 记录重放回 history。
# 最后一行如果不完整（进程写到一半时被杀），就连同它一起丢掉——
# 半条消息比没有消息更危险：模型会把它当成一条完整的历史来读，
# 而它实际上什么都不是。
def load_session(id):
    with open(session_path(id), "rb") as f:
        data = f.read()
    n = data.rfind(b"\n")
    data = data[:n + 1] if n >= 0 else b""

    s = Session(id)
    for line in data.split(b"\n"):
        if not line:
            continue
        try:
            rec = json.loads(line)
        except json.JSONDecodeError as e:
            raise ValueError(f"会话文件损坏: {e}") from None
        if rec.get("type") == "meta":
            s.created_at = rec.get("created_at", "")
        elif rec.get("type") == "message":
            if rec.get("message") is not None:
                s.history.append(rec["message"])
    s.persisted = len(s.history)
    return s


def main():
    if len(sys.argv) == 3 and sys.argv[1] == "-restore":
        sys.exit(restore(sys.argv[2]))

    args = sys.argv[1:]
    resume_id = ""
    if len(args) >= 2 and args[0] == "-c":
        resume_id, args = args[1], args[2:]
    if len(args) < 1:
        print('用法: python3 main.py "你的任务"  或  python3 main.py -c <session-id> "你的任务"',
              file=sys.stderr)
        sys.exit(1)
    task = args[0]
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

    if resume_id:
        try:
            sess = load_session(resume_id)
        except (OSError, ValueError) as e:
            print(f"错误: 恢复会话失败: {e}", file=sys.stderr)
            sys.exit(1)
        print(f"[恢复会话 {sess.id}，已有 {len(sess.history)} 条消息]", file=sys.stderr)
    else:
        try:
            sess = new_session_file([{"role": "system", "content": BASE_PROMPT}])
        except OSError as e:
            print(f"错误: 创建会话文件失败: {e}", file=sys.stderr)
            sys.exit(1)
        print(f"[新建会话 {sess.id}]", file=sys.stderr)
    sess.history.append({"role": "user", "content": task})

    # agent loop 的结构和练习 5 完全一样。变化只有两处：
    # 工具声明从注册表拿（reg.definitions），分发交给注册表（reg.execute）；
    # history 现在是 sess.history，每轮跑完都 save 一次。
    max_rounds = 10
    for round_no in range(1, max_rounds + 1):
        try:
            r = send(base, api_key, model, sess.history, reg.definitions())
        except Exception as e:
            print(e, file=sys.stderr)
            sys.exit(1)
        choice = r["choices"][0]
        msg = choice["message"]
        sess.history.append(msg)
        u = r.get("usage") or {}
        cached = (u.get("prompt_tokens_details") or {}).get("cached_tokens", 0)

        if choice.get("finish_reason") != "tool_calls":
            print(msg.get("content") or "", flush=True)
            print(f"\n[共 {round_no} 轮 · 最后一轮输入 {u.get('prompt_tokens', 0)} tokens"
                  f"（命中缓存 {cached}）· finish_reason={choice.get('finish_reason')}]", file=sys.stderr)
            try:
                sess.save()
            except OSError as e:
                print(f"警告: 会话保存失败: {e}", file=sys.stderr)
            print(f"[会话 ID: {sess.id}，用 -c {sess.id} 继续]", file=sys.stderr)
            return

        print(f"[round {round_no} 输入 {u.get('prompt_tokens', 0)} tokens，命中缓存 {cached}]",
              file=sys.stderr)
        for tc in msg.get("tool_calls") or []:
            print(f"[round {round_no}] {tc['function']['name']}({tc['function']['arguments']})",
                  file=sys.stderr)
            result = reg.execute(tc["function"]["name"], tc["function"]["arguments"])
            sess.history.append({
                "role": "tool",
                "tool_call_id": tc["id"],
                "content": result,
            })
        try:
            sess.save()
        except OSError as e:
            print(f"警告: 会话保存失败: {e}", file=sys.stderr)

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
