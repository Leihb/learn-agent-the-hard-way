# Learn Agent the Hard Way — 练习 24：用户界面——从单次调用到常驻对话
#
# 前二十三章的进程都是一句话一条命：从命令行接一个任务，跑完，退出。
# 这一章把它改成常驻：读一行、跑一轮、回到读一行，中间的会话、注册表、
# 沙箱边界全部原地不动地活着。代价是三件以前不存在的事：谁来读标准输入
# （只能有一个读者），跑到一半怎么喊停，以及喊停之后历史怎么收拾（打断
# 会把对话停在协议不允许的位置）。
#
# 语言差异先说在最前面：Go 版用 context.Context 把取消信号一路传进
# bash 子进程和 HTTP 请求内部，能在两者执行到一半时真正掐断。这一版
# Python 的取消是协作式的、只在轮次的检查点生效（发下一个请求之前、
# 工具批量执行完之后）——urllib 的阻塞调用和 subprocess.run() 都没有
# 内建的"从另一个线程喊停"机制，要做到 Go 那种深度穿透需要把取消令牌
# 一路传进每一层调用，这本书这一版选择只做最外层，差在哪里、为什么，
# "发生了什么"和"常见问题"里如实交代，也留了一道加分练习给想做全的读者。
import json
import os
import platform
import secrets
import signal
import subprocess
import sys
import tempfile
import threading
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


# ---- 沙箱层：OS 强制的执行边界 ----

# ACTIVE_SANDBOX 非 None 时，每一条 bash 命令都在笼子里跑。默认 None——
# 沙箱是显式开启的（-sandbox），不是默认值。原因在"网络"这一刀上：
# 断网是全有全无的开关（见 build_sandbox_profile），默认开沙箱等于默认
# 弄坏一切要联网的命令（pip install、git fetch、npm install），权限
# 系统 + 人工确认才是常开的那道闸。
ACTIVE_SANDBOX = None


# default_sandbox_policy 是标准笼子：可写的只有工作目录和临时目录；可读的
# 加上系统目录（跑普通命令要用的工具链、动态库、配置都在里面）；网络
# 关闭。家目录整体不在可读名单里——~/.ssh、~/.aws、~/.config 这些密钥
# 重灾区因此碰不到，这正是要保护的东西。
def default_sandbox_policy():
    tmp = tempfile.gettempdir()
    return {
        "read_roots": [WORK_DIR, tmp, "/usr", "/bin", "/sbin", "/etc", "/var",
                       "/private", "/System", "/Library", "/opt"],
        "write_roots": [WORK_DIR, tmp],
        "allow_network": False,
    }


# sandbox_available 报告这台机器能不能强制执行沙箱。本章的实现用 macOS
# 自带的 sandbox-exec；Linux 上 octo 用的是内核的 Landlock + seccomp，
# 实现要多一层自我重执行的技巧，本书不展开。
def sandbox_available():
    if platform.system() != "Darwin":
        return False
    return os.path.exists("/usr/bin/sandbox-exec")


# build_sandbox_profile 把 policy 翻译成 macOS 沙箱的规则语言（SBPL，一种
# 括号风格的小语言）。底座是 allow default——全默认禁止的配置会让普通
# 程序连动态库都加载不了，根本跑不起来；在放行的底座上，只收紧我们
# 关心的三个口子：
#
#   - 写：先全部禁止，再放行 write_roots（后写的、更具体的规则赢），
#     外加几个命令普遍要碰的设备文件（/dev/null 这类）
#   - 读：把整个家目录禁掉，再放行 read_roots——系统路径本来就在
#     allow default 里，这一刀专门保护家目录下的密钥
#   - 网：一刀切断，除非 allow_network
#
# 路径先解析符号链接再写进规则：macOS 的 /tmp 实际是 /private/tmp 的
# 链接，内核检查的是真实路径，规则里写链接路径等于没写。
def build_sandbox_profile(p):
    def resolve(path):
        try:
            return os.path.realpath(path)
        except OSError:
            return path

    def subpaths(roots):
        return " ".join(f'(subpath "{resolve(r)}")' for r in roots)

    lines = ["(version 1)", "(allow default)", "(deny file-write*)",
              f"(allow file-write* {subpaths(p['write_roots'])})",
              '(allow file-write* (literal "/dev/null") (literal "/dev/tty") '
              '(literal "/dev/stdout") (literal "/dev/stderr"))']
    home = os.path.expanduser("~")
    if home:
        lines.append(f'(deny file-read* (subpath "{resolve(home)}"))')
        lines.append(f"(allow file-read* {subpaths(p['read_roots'])})")
    if not p["allow_network"]:
        lines.append("(deny network*)")
    return "\n".join(lines) + "\n"


# shell_command 是全 harness 唯一一处把命令字符串变成 shell 进程参数的
# 地方。沙箱开着就包一层 sandbox-exec，关着就是原来那个 ["sh", "-c",
# command]。以后任何新的执行路径（后台任务、别的要跑命令的工具）都必须
# 从这个函数走——笼子只有装在唯一的门上才算数，多一个绕开它的调用点，
# 边界就不成立了。返回一份 argv 列表而不是拼好的字符串，跟 subprocess
# 不传 shell=True 配套——参数不经过 shell 再解析一遍，sandbox-exec 后面
# 那几个参数（尤其是 profile 里的换行和引号）不会被 shell 误解析。
def shell_command(command):
    if ACTIVE_SANDBOX is not None:
        profile = build_sandbox_profile(ACTIVE_SANDBOX)
        return ["/usr/bin/sandbox-exec", "-p", profile, "/bin/sh", "-c", command]
    return ["sh", "-c", command]


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

        # shell_command 决定要不要包一层 sandbox-exec；不传 shell=True，
        # 直接传 argv 列表——效果跟原来的 /bin/sh -c 一致，但沙箱开启时
        # 参数不会被再套一层 shell 解析。stdout=PIPE + stderr=STDOUT
        # 让两路在操作系统层面合成一路，跟 Go 的 cmd.CombinedOutput()
        # 是同一件事。
        try:
            result = subprocess.run(
                shell_command(command),
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


# confirm 停下来问人，不是问模型——危险命令要过这一关，模型自己怎么想
# 不算数。读不到回答（比如脚本化调用、没有终端）一律按拒绝处理，安全
# 边界宁可保守，不能因为读不到输入就放行。练习 9 只拿它拦 bash；这一章
# 把它从 ask_approval 里剥出来单独命名，因为要拦的不只是命令了。
def confirm(prompt):
    print(f"\n⚠️  {prompt}\n允许吗？(y/N) ", end="", file=sys.stderr, flush=True)
    try:
        line = sys.stdin.readline()
    except OSError:
        return False
    if not line:  # 读到 EOF，没有任何输入
        return False
    answer = line.strip().lower()
    return answer in ("y", "yes")


# ask_approval 是 confirm 在 bash 场景下的老名字，练习 9 的调用点不用改。
def ask_approval(cmd):
    return confirm(f"模型想执行: {cmd}")


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
            if path.startswith(SKILLS_ROOT + "/"):
                # 生效目录，见 SKILL_AUTHORING_GUIDANCE 那段规矩：写进这里的
                # 东西下一轮就会算进清单的 token 账，这不是模型一个人能拍板
                # 的事——跟练习 9 的 bash ask 档同一个道理，同一个函数。
                if not confirm("模型想把一份 skill 写进生效目录：" + path):
                    return "错误: 权限拒绝——写入生效的 skill 目录需要用户批准，这次没有批准。"
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
        # skill 正文加载这一刻才真的花钱：清单那笔账每轮都付，这笔账只在
        # 被点名的这一轮付一次——两笔账分开打印，账本上的数字自己会说话。
        if name == "skill" and not result.startswith("错误:"):
            print(f"[skill 正文进入对话：约 {estimate_text(result)} tokens，只这一轮付这笔账]",
                  file=sys.stderr)
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


# ---- 规则文件层：项目自己的约定 ----

# PROJECT_RULES_FILE 蒸馏自 octo 的 ProjectContextFile（.octorules）——
# 每个项目自己的行为约定，跟 BASE_PROMPT 那种"放之四海皆准"的规矩不同，
# 这份文件只对当前项目生效，随项目一起进版本库。
PROJECT_RULES_FILE = ".harnessrules"


# read_project_rules 读工作目录下的 .harnessrules，文件不存在或读不出来
# 就返回空字符串——没有这份文件是完全正常的状态，不是错误。
def read_project_rules():
    try:
        with open(PROJECT_RULES_FILE, encoding="utf-8") as f:
            return f.read().strip()
    except OSError:
        return ""


# ---- 记忆层：模型自己维护的跨会话笔记 ----

# MEMORY_FILE 蒸馏自 octo 的 MEMORY.md——但只留最小的那一部分：一个项目
# 一份文件，本章不做 octo 真实实现里的按仓库分目录、跨项目继承、200 行/25KB
# 截断预算，够用就好，把"跨会话"这一件事立住是这一章的唯一目的。
MEMORY_FILE = "MEMORY.md"


# read_memory 读工作目录下的 MEMORY.md，文件不存在就返回空字符串——
# 全新项目还没写过这份文件，这是正常状态，不是错误。
def read_memory():
    try:
        with open(MEMORY_FILE, encoding="utf-8") as f:
            return f.read().strip()
    except OSError:
        return ""


# MEMORY_GUIDANCE 是这一层唯一新增的"规矩"，蒸馏自 octo 真实的 memory 注入
# 说明：MEMORY.md 是什么、什么值得写、用什么工具写。这段话不因文件是否
# 存在而变化——第一次跑到这个项目，模型也要知道有这么个地方能写。
# 全书唯一一处故意不新增专用工具的地方：记东西用 write_file，改错一条、
# 删掉一条用 edit_file——和练习 6 已经有的工具是同一套，没有专门的
# remember/forget。
MEMORY_GUIDANCE = f"""# 跨会话记忆 ({MEMORY_FILE})

{MEMORY_FILE} 是你自己维护的记忆文件，不是这次任务的草稿。这次任务
结束后，下一次全新会话——不是用 -c 续接这一次，是完全重新开始的下一次
——会在系统提示里重新读到你现在写下的内容。

- 值得写：用户明确要求记住的偏好、和默认做法不一样的项目约定、你自己
  验证过、以后大概率还用得上的结论。不值得写：这次任务本身的中间状态、
  代码改动的具体内容——那些内容已经在文件和 git 历史里，不需要在这里
  重复一份。
- 没有专门的"记住"或"忘记"工具。{MEMORY_FILE} 就是一个普通文件：
  想写新的用 write_file，想改一条用 edit_file，想删掉一条也是 edit_file
  ——记错一件事和改错一行代码，是同一种操作，用同一套工具。
- 引用这份文件里的内容之前，先确认它现在还成立——项目会变，你之前记下
  的事，不保证放到现在还是真的。"""


# ---- skill 层：写在磁盘上、按需读的说明书 ----

# SKILLS_ROOT 蒸馏自 octo 的三层发现（default/user/project），本章只留
# 最简单的一层——一个项目一个目录，够用就好：这一章要立住的是"发现 +
# 注入"这一件事，不是完整的优先级覆盖体系。
SKILLS_ROOT = ".harness-skills"


# Skill 是一份发现到的说明书。body 是正文——只有模型真的调用 skill 工具
# 要来的时候才会离开磁盘、进入对话。
class Skill:
    def __init__(self, name, description, body, dir):
        self.name = name
        self.description = description
        self.body = body
        self.dir = dir


# discover_skills 扫 SKILLS_ROOT 下的每个子目录，读它的 SKILL.md。跟 octo
# 真实实现一样宽容：目录里没有 SKILL.md、frontmatter 缺 description，
# 就跳过这一个，不中断整个发现过程——一份写坏的说明书不该拖垮整个会话。
# 目录名是权威的 skill 名，frontmatter 里写的 name 只是给人看的，不参与
# 查找——这是 Claude Code 的行为，兼容它意味着别人写好的 skill 目录，
# 挪过来就能用。os.scandir 比 os.listdir 多带一个 is_dir()，不用像先前
# 那样再单独 os.path.isdir 补一次系统调用——跟 Go os.ReadDir 返回的
# DirEntry 是同一个讲究。
def discover_skills():
    out = {}
    try:
        entries = os.scandir(SKILLS_ROOT)
    except OSError:
        return out
    with entries:
        for entry in entries:
            if not entry.is_dir():
                continue
            try:
                with open(os.path.join(entry.path, "SKILL.md"), encoding="utf-8") as f:
                    data = f.read()
            except OSError:
                continue
            desc, body, ok = parse_skill_file(data)
            if not ok or not desc:
                continue
            out[entry.name] = Skill(entry.name, desc, body, entry.path)
    return out


# parse_skill_file 切开一份 SKILL.md：开头一对 "---" 之间是 frontmatter，
# 之后是正文。frontmatter 只认一行一个 "key: value"，够用就好——真正的
# Claude Code 格式用 yaml 库解析、能处理嵌套 metadata 块，这里手写的
# 是一个只够识别 description 的子集，其余字段（allowed-tools、license
# 之类）原样跳过，不报错也不生效。
def parse_skill_file(text):
    lines = text.split("\n")
    if not lines or lines[0].strip() != "---":
        return "", "", False
    description = ""
    i = 1
    while i < len(lines):
        if lines[i].strip() == "---":
            break
        if ":" in lines[i]:
            key, _, val = lines[i].partition(":")
            if key.strip() == "description":
                description = val.strip()
        i += 1
    if i >= len(lines):
        return "", "", False  # 没找到闭合的 "---"，frontmatter 不完整
    body = "\n".join(lines[i + 1:]).strip()
    return description, body, True


# skill_manifest 渲染 L1 清单：每个 skill 只留名字和 description，这是
# 模型判断"要不要用这个 skill"的唯一依据。正文不放这里——清单要塞进
# 冻结的 system prompt，多数任务用不上大多数 skill，正文太贵，全塞进去
# 不划算，留给 skill 工具按需加载才是这一层存在的意义。
def skill_manifest(skills):
    if not skills:
        return ""
    lines = ["# 可用的 skill", "",
             "任务匹配某条 description 时，先调用 skill 工具（参数 name）加载完整指令再动手"
             "——不要只凭这一句描述去猜正文写了什么。", ""]
    # 顺序必须稳定，否则清单文本每次不同，缓存前缀跟着作废
    for name in sorted(skills):
        lines.append(f"- {name}: {skills[name].description}")
    return "\n".join(lines).strip()


# SkillTool 是 L2：清单只给名字和一句话，正文才是真正的指令，只有模型
# 点名要用了才发。它需要访问这次进程发现到的 skills，不能像 ReadFileTool
# 那样是无状态的，所以带一个字段。
class SkillTool:
    def __init__(self, skills):
        self.skills = skills

    def definition(self):
        return {
            "name": "skill",
            "description": "加载一个 skill 的完整指令。先看系统提示里“可用的 skill”清单，"
                           "任务匹配某条 description 时，用这个工具把对应 skill 的正文加载进来再动手。",
            "parameters": {
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "要加载的 skill 名字，清单里“-”后面那个词"},
                },
                "required": ["name"],
            },
        }

    def execute(self, args):
        try:
            params = json.loads(args)
        except json.JSONDecodeError as e:
            return "错误: 参数不是合法 JSON: " + str(e)
        name = params.get("name", "")
        sk = self.skills.get(name)
        if sk is None:
            return "错误: 没有叫 " + name + " 的 skill——从系统提示的清单里选一个"
        return f'[skill "{sk.name}"，所在目录：{sk.dir}]\n\n{sk.body}'


# SKILLS_PROPOSED_ROOT 是自动写 skill 的落地位置，刻意不是 SKILLS_ROOT。
# discover_skills 只扫 SKILLS_ROOT，这个目录里的东西不会进清单、不会占
# 任何一轮的 token，直到人用 bash mv 把它挪进 SKILLS_ROOT 才生效——
# "写"和"生效"从代码层面就是两个不同的目录，不是靠模型自觉。
SKILLS_PROPOSED_ROOT = ".harness-skills-proposed"

# SKILL_AUTHORING_GUIDANCE 把练习 15 那条教训换到 skill 头上：生成不难，
# 回收才是问题。这段规矩不因任何条件变化——即使这个项目现在一个 skill
# 都没有，模型也要知道"写草稿"和"生效"是两个目录、两件事，不是写一次
# write_file 就完事的同一步。
SKILL_AUTHORING_GUIDANCE = f"""# 想沉淀新 skill 时

如果你判断一类任务以后会反复出现，值得写成一份新 skill 供下次复用——
可以写，但不要直接写进 "{SKILLS_ROOT}/<name>/SKILL.md"：那个目录
里的每一份 SKILL.md，只要存在，description 就会被打进清单，从下一轮起
每一轮对话都要为它多付一点 token，不管这一轮用不用得上。

草稿写到 "{SKILLS_PROPOSED_ROOT}/<name>/SKILL.md"，格式跟正式 skill
完全一样。这个目录不会被扫描、不会出现在清单里，写多少份草稿都不花一分
钱。写完之后告诉用户你觉得这份草稿值得转正，一句话说清楚它是什么、什么
时候该用——要不要挪进 "{SKILLS_ROOT}/" 生效，由用户决定，不是你。"""


# compose_system_prompt 把 BASE_PROMPT、项目规则、skill 清单、记忆拼成一份
# system prompt，蒸馏自 octo Compose 的分层方式：每层之间用同一个分隔符
# 隔开，某一层没有内容就跳过那一层。这份拼好的文字，从会话创建那一刻起
# 冻结——练习 8 讲过为什么：中途改一个字，隐式缓存就整条作废。
def compose_system_prompt(skills):
    prompt = BASE_PROMPT
    rules = read_project_rules()
    if rules:
        prompt += "\n\n---\n\n# 项目约定 (" + PROJECT_RULES_FILE + ")\n\n" + rules
    manifest = skill_manifest(skills)
    if manifest:
        prompt += "\n\n---\n\n" + manifest
    prompt += "\n\n---\n\n" + SKILL_AUTHORING_GUIDANCE
    prompt += "\n\n---\n\n" + MEMORY_GUIDANCE
    mem = read_memory()
    if mem:
        prompt += "\n\n## 你目前记下的内容\n\n" + mem
    else:
        prompt += "\n\n## 你目前记下的内容\n\n（还是空的——这是这个项目第一次有你可读的记忆）"
    return prompt


# ---- 预算层：知道自己还有多少余地 ----


# context_window 返回一个模型的上下文窗口大小（token 数），蒸馏自 octo 里
# 一张更大的模型-窗口对照表——按名字子串匹配，匹配不到就退回保守的默认值。
# 宁可低估：低估最多让你提前一点行动，高估会让你真的撑爆上下文。
def context_window(model):
    m = model.lower()
    if "deepseek" in m:
        return 1_000_000
    if "gpt-4" in m:
        return 128_000
    if "claude" in m:
        return 200_000
    return 128_000  # 不认识的模型，包括本机跑的大多数开源小模型


# effective_context_window 让你在这一章的实验里用 CONTEXT_WINDOW 人为调小窗口。
# 真实模型的窗口大到几十上百万 token，正常聊天几十轮都撞不上；这一章想让你
# 在几轮之内亲眼看到预算告急，所以留了这个后门——不设就用 context_window 的
# 真实值，这不是在否定真实模型的窗口有多大，只是为了让实验能在你的终端里
# 几秒钟内跑完。
def effective_context_window(model):
    v = os.environ.get("CONTEXT_WINDOW", "")
    if v:
        try:
            n = int(v)
        except ValueError:
            n = 0
        if n > 0:
            return n
    return context_window(model)


# BUDGET_FRACTION 是触发警告的门槛——占窗口的 75%，蒸馏自 octo 的
# compactThresholdFraction：剩下的 25% 留给最近的对话尾巴和这一轮的输出。
BUDGET_FRACTION = 0.75


# check_budget 拿这一轮 API 真实回报的 token 数（不是估算值——练习 11 你
# 已经知道 API 会把这个数字如实报回来）去跟窗口比，报告一句话，并且告诉
# 调用方要不要开始压缩。练习 12 这个函数只喊话；这一章多了返回值，
# 喊话之后，真的动手。
def check_budget(used_tokens, window):
    pct = used_tokens / window * 100
    print(f"[预算：{used_tokens}/{window} tokens，{pct:.1f}%]", file=sys.stderr)
    over = used_tokens >= window * BUDGET_FRACTION
    if over:
        print(f"⚠️  已用掉窗口的 {pct:.0f}%，接近上限——开始压缩", file=sys.stderr)
    return over


# estimate_tokens 是没有真实 token 数时的快速估算：ASCII 大约 4 个字符一个
# token，中文这类多字节字符大约 1.5 个字符一个 token——不是真正的分词器，
# 只是个够用的粗略数，在还没发出第一个请求、拿不到 API 真实回报之前，
# 先给自己一个数量级。
def estimate_tokens(msgs):
    total = 0
    for m in msgs:
        total += estimate_text(m.get("content") or "")
        for tc in m.get("tool_calls") or []:
            total += estimate_text(tc["function"]["name"]) + estimate_text(tc["function"]["arguments"])
    return total


def estimate_text(s):
    ascii_count, multi = 0, 0
    for ch in s:
        if ord(ch) < 128:
            ascii_count += 1
        else:
            multi += len(ch.encode("utf-8"))
    return ascii_count // 4 + int(multi / 1.5 + 0.5)


# ---- 会话层：把 history 写到磁盘上 ----

# SESSION_DIR 是会话文件存放的地方，跟 .trash 一样就在工作目录底下。
SESSION_DIR = ".sessions"


# Session 是一次对话的全部状态：一个 ID，加上完整的 history。persisted
# 记录 history 里前多少条消息已经写盘——save 只补写 persisted 之后新增的
# 部分，不是每次都把整个文件重写一遍。这是练习 11 的核心账本：存盘的代价
# 只跟"这一轮新增了多少条"有关，跟"这场对话已经聊了多久"无关。
# force_rewrite 是压缩加的：压缩会把 history 前半段整个换成一条摘要，
# 磁盘上原来那些行不再对应现在的内容，下次 save 不能只追加，得整个重写。
class Session:
    def __init__(self, id, created_at="", history=None):
        self.id = id
        self.created_at = created_at
        self.history = history if history is not None else []
        self.persisted = 0
        self.force_rewrite = False

    # save 平时只追加 history[persisted:]；force_rewrite 被压缩置位之后，
    # 磁盘上的旧行不再可信，改成整个截断重写。没有新消息、也没被标记
    # force_rewrite 时是个空操作——一轮里模型只回了一句话，这次 save 什么都不写。
    def save(self):
        if self.force_rewrite:
            return self.rewrite_all()
        if len(self.history) == self.persisted:
            return
        return self.append_delta()

    # append_delta 是练习 11 原来的 save：只补写 persisted 之后新增的部分。
    def append_delta(self):
        with open(session_path(self.id), "a", encoding="utf-8") as f:
            for msg in self.history[self.persisted:]:
                f.write(encode_record({"type": "message", "message": msg}))
        self.persisted = len(self.history)

    # rewrite_all 截断文件，把 meta 和当前完整的 history 重新写一遍——压缩
    # 之后唯一正确的存盘方式：history 前半段的内容已经变了，追加只会把
    # 新旧两份摘要和原文混在一起。
    def rewrite_all(self):
        with open(session_path(self.id), "w", encoding="utf-8") as f:
            f.write(encode_record({"type": "meta", "id": self.id, "created_at": self.created_at}))
            for msg in self.history:
                f.write(encode_record({"type": "message", "message": msg}))
        self.persisted = len(self.history)
        self.force_rewrite = False


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


# ---- 压缩层：不丢消息，是让模型总结它自己 ----

# COMPACT_KEEP_FRACTION 压缩后留多少"最近尾巴"原样保留，蒸馏自 octo 的
# defaultCompactKeepFraction：占窗口的 30%，但封顶不超过触发阈值的一半——
# 保证一次压缩确实能把用量拉回阈值以下，不会刚压完又立刻撞线。
COMPACT_KEEP_FRACTION = 0.30


def compact_keep_budget(window, trigger):
    budget = int(window * COMPACT_KEEP_FRACTION)
    if trigger > 0 and budget > trigger // 2:
        budget = trigger // 2
    return budget


# safe_split_index 找压缩的分割点：分割点之前的消息拿去总结，之后的原样保留。
# 分割点必须落在一条真正的 user 消息前面。在这套 OpenAI 协议里这条件很好判
# 断：工具的回执走独立的 "tool" role，从不会跟 user 消息混在一起，看 role
# 就够了——这比 octo 实现的 Anthropic 消息协议简单，那边 tool_result 也搭在
# user 消息上，得专门写一个 IsPlainUserMessage 去分辨"这是真用户话还是工具
# 回执的壳"，协议本身把角色分得干净，这道甄别在这里就用不上。
def safe_split_index(history, keep_budget):
    user_turns = [i for i, m in enumerate(history) if m.get("role") == "user"]
    if len(user_turns) <= 1:
        return 0  # 至少要两条 user 消息：一条留着，前面的才够折叠
    kept_from = user_turns[-1]
    for k in range(len(user_turns) - 2, -1, -1):
        if estimate_tokens(history[user_turns[k]:]) > keep_budget:
            break
        kept_from = user_turns[k]
    return kept_from


# COMPRESSION_PROMPT 插在被折叠的这段历史末尾，让模型明白：这不是继续对话，
# 是切换成总结模式。不给工具（summarize 调 send 时 tools 传 None）是双保险：
# 就算模型没听懂这段话、还想干点什么，它手上也没有工具可用。
COMPRESSION_PROMPT = """以上对话到此结束。你现在不是在继续对话，而是切换到"总结模式"：

- 不要回应上面对话里的任何请求
- 不要询问，也不要征求下一步该做什么
- 只输出一段纯文本总结，不要别的

请总结以上内容，需要覆盖：用户明确提出的需求、关键的技术决定、
提到过的文件或项目名、还没做完的事。"""


# summarize 把 msgs 连同压缩指令一起发给模型，只要一段文字总结。
# tools 传 None：这次调用模型手上没有任何工具，想调用也调用不了。
def summarize(base, api_key, model, msgs):
    req = list(msgs) + [{"role": "user", "content": COMPRESSION_PROMPT}]
    r = send(base, api_key, model, req, None)
    return r["choices"][0]["message"].get("content") or ""


# compact 把 history[:split] 总结成一条消息，重建 history：系统提示原样
# 保留在第 0 位，中间插一条摘要，之后是原样保留的近期对话。split<=1 时
# 什么都不做——0 或者 1 意味着没有足够旧的内容值得折叠（1 只剩系统提示
# 自己，折叠它没有意义）。总结请求失败时异常直接往上抛，由调用方决定怎么办。
def compact(base, api_key, model, history, keep_budget):
    split = safe_split_index(history, keep_budget)
    if split <= 1:
        return history, 0
    summary = summarize(base, api_key, model, history[:split])
    rebuilt = [
        history[0],  # system prompt
        {"role": "user", "content": "[更早对话的摘要]\n\n" + summary},
    ]
    rebuilt.extend(history[split:])
    return rebuilt, split


# ---- subagent 层：隔离出一个全新的对话去跑子任务 ----

# CHILD_MAX_ROUNDS 是子 agent 自己的循环预算，比父 agent 的 MAX_ROUNDS 更
# 紧——子任务应该是聚焦的一件事，不该是另一场需要十轮才能收尾的长对话；
# 真撞上限，run_child_loop 把这当一次不完整的结果处理，不是错误。
CHILD_MAX_ROUNDS = 6


# run_child_loop 是子 agent 自己的一个迷你 agent loop：发请求、有
# tool_calls 就分发、没有就返回。故意不跟 main() 里那个大循环共用——
# 子 agent 不需要会话存盘（纯内存，这次调用完就没了）、不需要压缩
# （任务足够聚焦，轮数上限本身就比触发压缩的量级小得多）、也不需要
# resume。这些是"一场会话"才有的复杂度，子 agent 只是"发几轮请求，
# 拿到一个结论"，蒸馏自 octo 的说法：子 agent 的保活范围纯 in-memory，
# 生命周期只有一次调用，不写盘、不进 session、不跨进程。
def run_child_loop(base, api_key, model, reg, history):
    total_tokens = 0
    for _ in range(CHILD_MAX_ROUNDS):
        r = send(base, api_key, model, history, reg.definitions())
        u = r.get("usage") or {}
        total_tokens += u.get("prompt_tokens", 0) + u.get("completion_tokens", 0)
        choice = r["choices"][0]
        msg = choice["message"]
        history.append(msg)
        if choice.get("finish_reason") != "tool_calls":
            return msg.get("content") or "", total_tokens, True
        for tc in msg.get("tool_calls") or []:
            result = reg.execute(tc["function"]["name"], tc["function"]["arguments"])
            history.append({"role": "tool", "tool_call_id": tc["id"], "content": result})
    # 跑满轮数没个结论，不是异常——蒸馏自 octo 的 max-turns 处理：把最后
    # 一条内容当部分结果带回去，标记不完整，让父 agent 自己判断怎么办，
    # 而不是把半成品当成正常答案，也不是直接报错扔掉已经做的工作。
    last = history[-1]
    return last.get("content") or "", total_tokens, False


# subAgentTool 是父 agent 唯一能看到的分身入口。tools 是子 agent 能用
# 的工具集——调用方负责传一份"父的工具集去掉 SubAgentTool 自己"的列表，
# 这就是防递归：子 agent 的注册表里根本没有 sub_agent 这个名字，不是
# 靠它自己克制。
class SubAgentTool:
    def __init__(self, base, api_key, model, tools, skills):
        self.base = base
        self.api_key = api_key
        self.model = model
        self.tools = tools
        self.skills = skills

    def definition(self):
        return {
            "name": "sub_agent",
            "description": (
                "派生一个隔离的子 agent 去完成一个独立子任务。子 agent 看不到这次对话到"
                "目前为止的任何内容——prompt 必须自包含，把它需要知道的一切都写进去。你只会拿到"
                "子 agent 最后的结论，它中途调用了哪些工具、读了哪些文件，都不会进入你的上下文。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "description": {"type": "string", "description": "这个子任务的一句话标签，仅用于日志"},
                    "prompt": {"type": "string", "description": "子任务的完整描述，自包含——子 agent 看不到别的上下文"},
                },
                "required": ["description", "prompt"],
            },
        }

    def execute(self, args):
        try:
            in_ = json.loads(args) or {}
        except json.JSONDecodeError as e:
            return "错误: 参数不是合法 JSON: " + str(e)
        description = in_.get("description", "")
        prompt = in_.get("prompt", "")
        if not prompt.strip():
            return "错误: prompt 不能为空——子 agent 看不到别的上下文，全靠这一份"
        return self.run(description, prompt)

    # run 是子 agent 真正干活的入口：一份自包含的 prompt 进，一条最终回复出。
    # execute（模型点名调 sub_agent）和这一章的 WorkflowTool（代码按计划调）
    # 都走这同一个入口——换的是谁来编排，没换执行机制。
    def run(self, description, prompt):
        child_reg = Registry(*self.tools)
        child_history = [
            {"role": "system", "content": compose_system_prompt(self.skills)},
            {"role": "user", "content": prompt},
        ]
        print(f"[子 agent {description!r} 开始，独立的一份 history，父对话它一个字都看不到]",
              file=sys.stderr)
        try:
            reply, tokens, complete = run_child_loop(self.base, self.api_key, self.model, child_reg, child_history)
        except Exception as e:
            return "错误: 子 agent 执行失败: " + str(e)
        tag = "" if complete else "[未完成：达到轮数上限，以下是部分结果]\n\n"
        print(f"[子 agent {description!r} 结束：内部消耗约 {tokens} tokens，"
              f"父对话只收到下面这条回复，约 {estimate_text(reply)} tokens]", file=sys.stderr)
        return tag + reply


# MAX_PARALLEL_SUB_AGENTS 限制一轮里最多同时跑几个 sub_agent。每一个都会
# 起自己的一整套 provider 连接和多轮对话，扇出多大都不设上限，就是在
# 拿本地资源和 provider 的并发限额去赌。这个数字没有理论最优解，纯粹是
# 部署环境的取舍——本书的玩具 harness 是单机跑，4 只是"够看出并发效果，
# 又不至于把本机或 provider 打满"的一个保守选择。
MAX_PARALLEL_SUB_AGENTS = 4


# can_fan_out 判断这一轮工具调用能不能并发跑。判据故意收得很紧：调用数
# 大于一个，且全部是 sub_agent——不是"只读工具都能并发"这种更通用的
# 规则。原因是这本书至今没有给任何工具标注过"只读"，bash/write_file/
# edit_file 都会改共享状态（cwd、trash、registry 的 has_read 记账），
# 混在一起并发执行没人能担保顺序和结果；sub_agent 不一样——它起的是
# 一整个独立的子 agent，自己的 history、自己的 child_reg，跟父 agent
# 的注册表没有任何写共享（sub_agent 的参数里没有 path 字段，注册表的
# has_read 记账不会被它触碰）。这份安全保证只覆盖 history/registry 这层
# 状态——子 agent 内部如果自己调用了需要人工确认的 bash 命令，confirm()
# 读的是同一个共享 stdin，多个线程同时问会互相冲撞，见这一章"常见问题"
# 里的实测记录，这份判据没有、也不打算解决这个问题。
def can_fan_out(calls):
    if len(calls) < 2:
        return False
    return all(tc["function"]["name"] == "sub_agent" for tc in calls)


# dispatch_tool_calls 跑完一轮里的全部工具调用，按原始顺序整理成待追加
# 的 tool 消息。can_fan_out 为真时用一个容量 MAX_PARALLEL_SUB_AGENTS 的
# threading.Semaphore 当限流阀：每个线程先占一个坑位再执行，执行完释放，
# 坑位不够的调用在 sem.acquire() 这一行排队——Python 没有 goroutine，但
# 这里的每一次 sub_agent 调用本质上是"发 HTTP 请求、等回包"，等待期间
# 会释放 GIL，多个线程真的能并发地在等待网络——用 threading 而不是
# asyncio，是因为 send() built 在阻塞的 urllib 之上，不用把整个工具层
# 重写成协程也能拿到同样的效果。结果按下标写回一个和 calls 等长的列表，
# 不依赖字典遍历顺序，保证 tool 消息和原始 tool_calls 一一对应。不能
# 并发的这一轮（只有一个调用，或混了 bash/write 这类工具）走原来那条
# 串行路径，行为跟练习 19 完全一样。
def dispatch_tool_calls(reg, round_no, calls):
    results = [None] * len(calls)
    if can_fan_out(calls):
        sem = threading.Semaphore(MAX_PARALLEL_SUB_AGENTS)
        log_lock = threading.Lock()
        threads = []
        for i, tc in enumerate(calls):
            sem.acquire()  # 占坑位；坑位不够就阻塞在这一行排队

            def worker(i=i, tc=tc):
                try:
                    with log_lock:
                        print(f"[round {round_no}] {tc['function']['name']}({tc['function']['arguments']})",
                              file=sys.stderr)
                    results[i] = reg.execute(tc["function"]["name"], tc["function"]["arguments"])
                finally:
                    sem.release()  # 让出坑位给下一个排队的调用

            t = threading.Thread(target=worker)
            threads.append(t)
            t.start()
        for t in threads:
            t.join()
    else:
        for i, tc in enumerate(calls):
            print(f"[round {round_no}] {tc['function']['name']}({tc['function']['arguments']})", file=sys.stderr)
            results[i] = reg.execute(tc["function"]["name"], tc["function"]["arguments"])
    return [{"role": "tool", "tool_call_id": tc["id"], "content": results[i]} for i, tc in enumerate(calls)]


# ---- workflow 层：把编排从模型手里拿回代码里 ----

# PLAN_SHAPE_HINT 附在每条参数错误的后面。报错也是发给模型的 prompt：
# 只说"不合法"，模型会瞎变形重试；把期望的形状递到它眼前，下一次就写对。
PLAN_SHAPE_HINT = '计划的形状：{"stages": [["阶段1的子任务prompt", "..."], ["阶段2的子任务prompt，可写 {{results}}"]]}'

# RESULTS_PLACEHOLDER 是阶段之间唯一的数据通道：下一阶段的 prompt 里写
# 这个占位符的位置，会被替换成上一阶段全部子任务的结果。除此之外阶段
# 之间什么都不共享——和 sub_agent 的隔离规矩一脉相承。
RESULTS_PLACEHOLDER = "{{results}}"


# format_results 把一个阶段的全部结果拼成一段编号的文本——它就是占位符
# 替换进去的内容，也是整个 workflow 最后交回给模型的东西。
def format_results(results):
    parts = [f"【子任务 {i + 1} 的结果】\n{r}\n" for i, r in enumerate(results)]
    return "\n".join(parts).strip()


# WorkflowTool 复用 SubAgentTool 的 run 入口跑每一条 prompt：执行机制
# 和 sub_agent 完全同一套，这个工具新增的只有编排——octo 的 workflow
# 也是同一个做法，agent() 直接复用支撑 sub_agent 的那套派生机制，
# 没有另起炉灶。计划的形状刻意扁平：一个阶段就是一组 prompt 字符串，
# 没有包一层对象——这份 JSON 的作者是模型，schema 每多一层嵌套，它写
# 错的机会就多一分。
class WorkflowTool:
    def __init__(self, runner):
        self.runner = runner

    def definition(self):
        return {
            "name": "workflow",
            "description": (
                "按一份固定的计划执行一批子任务。计划是阶段的列表，每个阶段是一组子任务 "
                "prompt：阶段之间严格按顺序执行，同一阶段内的 prompt 全部并发执行；下一阶段的 "
                "prompt 里写 {{results}} 的位置，会被替换成上一阶段全部子任务的结果；整个 "
                "workflow 交回给你的，只有最后一个阶段的结果。整份计划由代码保证执行，中途"
                "不再经过你。例——\"分头调查 A、B、C，再汇总\"写成两个阶段："
                '{"stages": [["调查A……", "调查B……", "调查C……"], ["汇总以下调查结果……\\n{{results}}"]]}'
                "。不要把要并发的子任务拆到不同阶段，阶段是串行的。适合结构事先想得清楚的任务；"
                "边做边定下一步的探索式任务，继续用 sub_agent。每条 prompt 都交给一个隔离的"
                "子 agent，规矩和 sub_agent 相同：必须自包含，子 agent 看不到本次对话的任何内容。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "stages": {
                        "type": "array",
                        "description": (
                            "按顺序执行的阶段列表。每个阶段是一个字符串数组：这一阶段要"
                            "并发派出的子任务 prompt，每条都必须自包含。需要上一阶段结果的地方写 "
                            "{{results}}（第一阶段没有上一阶段，不要写）。"
                        ),
                        "items": {"type": "array", "items": {"type": "string"}},
                    },
                },
                "required": ["stages"],
            },
        }

    # execute 逐阶段执行计划。阶段内的并发和上面的 dispatch_tool_calls 是同一个
    # 模式：容量 MAX_PARALLEL_SUB_AGENTS 的信号量当限流阀，结果按下标写回。
    # 区别只在谁决定"这一批一起跑"——上一章靠 can_fan_out 事后检查模型有没有
    # 把调用发在同一轮，这里阶段本身就是并发声明，不存在检查不过的情况。
    def execute(self, args):
        try:
            plan = json.loads(args)
        except json.JSONDecodeError as e:
            return "错误: 参数不是合法 JSON: " + str(e) + "。" + PLAN_SHAPE_HINT
        stages = plan.get("stages") if isinstance(plan, dict) else None
        if not stages:
            return "错误: 计划里一个阶段都没有。" + PLAN_SHAPE_HINT
        prev = []
        for si, prompts in enumerate(stages):
            if not isinstance(prompts, list) or not prompts or not all(isinstance(p, str) for p in prompts):
                return f"错误: 阶段 {si + 1} 不是字符串数组，或一个子任务都没有。{PLAN_SHAPE_HINT}"
            print(f"[workflow 阶段 {si + 1}/{len(stages)}：{len(prompts)} 个子任务，"
                  f"并发上限 {MAX_PARALLEL_SUB_AGENTS}]", file=sys.stderr)
            results = [None] * len(prompts)
            sem = threading.Semaphore(MAX_PARALLEL_SUB_AGENTS)
            threads = []
            for i, p in enumerate(prompts):
                if prev:
                    p = p.replace(RESULTS_PLACEHOLDER, format_results(prev))
                sem.acquire()

                def worker(i=i, p=p):
                    try:
                        results[i] = self.runner.run(f"阶段{si + 1}-子任务{i + 1}", p)
                    finally:
                        sem.release()

                t = threading.Thread(target=worker)
                threads.append(t)
                t.start()
            for t in threads:
                t.join()
            prev = results
        if len(prev) == 1:
            return prev[0]
        return format_results(prev)


# ---- MCP 层：接入别人的工具 ----

# MCP_CONFIG_FILE 是工作目录下的服务器清单，格式跟 Claude Code 的
# mcp.json 完全一致——和练习 16 认 Claude Code 的 SKILL.md 是同一个
# 理由：兼容通行格式，别人写好的配置抄过来就能用。
MCP_CONFIG_FILE = "mcp.json"


# load_mcp_config 读工作目录下的 mcp.json。文件不存在是正常状态——没配
# 外部服务器的项目跟上一章的行为完全一样，不是错误。
def load_mcp_config():
    try:
        with open(MCP_CONFIG_FILE, encoding="utf-8") as f:
            data = json.load(f)
    except OSError:
        return {}
    except json.JSONDecodeError as e:
        print(f"警告: {MCP_CONFIG_FILE} 不是合法 JSON，忽略: {e}", file=sys.stderr)
        return {}
    return data.get("mcpServers") or {}


# MCPClient 管着一个外部服务器子进程：往它的标准输入写请求，从它的标准
# 输出读响应。lock 保证同一时刻只有一个在途请求——练习 20 教过的规矩：
# 并发安全由持有共享状态的这一层自己负责，不指望调用方（比如几个并发的
# 子 agent 同时用同一个外部工具）替它小心。
class MCPClient:
    def __init__(self, name, proc):
        self.name = name
        self.proc = proc
        self.lock = threading.Lock()
        self.next_id = 0

    # call 发一个请求，等它的响应。一次只有一个在途请求，所以"等"就是
    # 顺着流往下读：读到的帧如果带 method，那是服务器发来的通知，这本书
    # 不处理，跳过；直到读到 id 对得上的响应为止。MCP 一行一帧，直接用
    # readline() 按行读，不用像 Go 版那样自己管一个 json.Decoder。
    def call(self, method, params=None):
        with self.lock:
            self.next_id += 1
            id_ = self.next_id
            msg = {"jsonrpc": "2.0", "id": id_, "method": method}
            if params is not None:
                msg["params"] = params
            try:
                self.proc.stdin.write((json.dumps(msg) + "\n").encode())
                self.proc.stdin.flush()
            except OSError as e:
                raise RuntimeError(f"写入 MCP 服务 {self.name!r} 失败（进程退出了？）: {e}") from None
            while True:
                line = self.proc.stdout.readline()
                if not line:
                    raise RuntimeError(f"读取 MCP 服务 {self.name!r} 失败: 进程已退出")
                try:
                    m = json.loads(line)
                except json.JSONDecodeError as e:
                    raise RuntimeError(f"读取 MCP 服务 {self.name!r} 失败: {e}") from None
                if m.get("method") or m.get("id") != id_:
                    continue  # 通知，或不属于这次请求的帧——跳过，接着读
                if m.get("error"):
                    err = m["error"]
                    raise RuntimeError(f"MCP 错误 {err.get('code')}: {err.get('message')}")
                return m.get("result")

    # notify 发一个通知——没有 id 的请求，服务器不会回复，发完就走。
    def notify(self, method):
        msg = {"jsonrpc": "2.0", "method": method}
        self.proc.stdin.write((json.dumps(msg) + "\n").encode())
        self.proc.stdin.flush()

    # initialize 是 MCP 的三步握手：客户端报上版本和身份，服务器答复它
    # 的；然后客户端发一条 initialized 通知表示"我这边好了"。版本我们报
    # 2024-11-05——这本书只说 stdio 这一种传输方式，报更新的版本反而名
    # 不副实；服务器答复的版本如果不一样，记下来继续用，不较真。
    def initialize(self):
        params = {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "learnharness", "version": "0.1"},
        }
        res = self.call("initialize", params) or {}
        self.notify("notifications/initialized")
        info = res.get("serverInfo") or {}
        print(f"[MCP 服务 {self.name!r} 握手完成：{info.get('name')} v{info.get('version')}，"
              f"协议 {res.get('protocolVersion')}]", file=sys.stderr)

    def list_tools(self):
        res = self.call("tools/list", {}) or {}
        return res.get("tools") or []


# start_mcp_server 启动配置里的一条命令，接管它的标准输入输出。子进程的
# 标准错误直通我们的终端——那是服务器的日志通道，不是协议通道，MCP 的
# 协议规定 stdout 只许出现 JSON-RPC 帧，日志必须走 stderr。
def start_mcp_server(name, cfg):
    env = os.environ.copy()
    env.update(cfg.get("env") or {})
    proc = subprocess.Popen(
        [cfg["command"], *(cfg.get("args") or [])],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=None, env=env,
    )
    return MCPClient(name, proc)


# MCPTool 把一个远端工具包进这本书的 tool 接口。注册表分不出它和
# ReadFileTool 有什么区别——这正是这一章的全部要点：接入别人的工具，
# 改动的只有"多一种来源"，没有第二套分发机制。
class MCPTool:
    def __init__(self, client, remote):
        self.client = client
        self.remote = remote

    # definition 的两个细节：名字带上 mcp__<服务名>__ 前缀，既避免和内置
    # 工具撞名，也让日志里一眼看出这个调用出了进程；parameters 直接透传
    # 服务器声明的 schema——参数长什么样是工具作者说了算，我们不翻译。
    def definition(self):
        return {
            "name": f"mcp__{self.client.name}__{self.remote.get('name')}",
            "description": f"[来自 MCP 服务 {self.client.name}] {self.remote.get('description', '')}",
            "parameters": self.remote.get("inputSchema") or {"type": "object", "properties": {}},
        }

    def execute(self, args):
        try:
            arguments = json.loads(args)
        except json.JSONDecodeError as e:
            return "错误: 参数不是合法 JSON: " + str(e)
        try:
            res = self.client.call("tools/call", {"name": self.remote.get("name"), "arguments": arguments}) or {}
        except Exception as e:
            # 这一层的错误是"调用没送到工具手上"——进程死了、协议错了。
            return "错误: " + str(e)
        parts = []
        for c in res.get("content") or []:
            if c.get("type") == "text":
                parts.append(c.get("text", ""))
            else:
                parts.append(f"[未处理的内容类型 {c.get('type')!r}]")
        text = "\n".join(parts)
        if res.get("isError"):
            # 这一层的错误是"工具收到了调用，干活失败了"——和上面那种要
            # 分开：isError 是结果的一部分，进程还活着，下一次调用照常。
            return "错误: 工具执行失败: " + text
        return text


# connect_mcp_servers 把 mcp.json 里每个服务器的工具接进 tools。一个
# 服务器连不上只警告、跳过——外部依赖挂了不该拖垮整个 harness，这和
# 练习 16"一份写坏的 SKILL.md 不中断发现"是同一条纪律。服务名排序遍历，
# 保证工具列表的顺序每次启动都一样。
def connect_mcp_servers(tools):
    servers = load_mcp_config()
    for name in sorted(servers):
        cfg = servers[name]
        try:
            client = start_mcp_server(name, cfg)
        except OSError as e:
            print(f"警告: MCP 服务 {name!r} 启动失败，跳过: {e}", file=sys.stderr)
            continue
        try:
            client.initialize()
        except Exception as e:
            print(f"警告: MCP 服务 {name!r} 握手失败，跳过: {e}", file=sys.stderr)
            continue
        try:
            remotes = client.list_tools()
        except Exception as e:
            print(f"警告: MCP 服务 {name!r} 列工具失败，跳过: {e}", file=sys.stderr)
            continue
        schema_cost = 0
        for rt in remotes:
            tools.append(MCPTool(client, rt))
            raw = json.dumps(rt.get("inputSchema") or {})
            schema_cost += estimate_text(rt.get("name", "") + rt.get("description", "") + raw)
        # 又一笔要当场算清的账（练习 17 的老规矩）：这些声明进的是 tools
        # 数组，跟 system prompt 一样每一轮都要重发一遍。
        print(f"[MCP 服务 {name!r}：接入 {len(remotes)} 个工具，声明约 {schema_cost} tokens，"
              "随 tools 数组每轮都算钱]", file=sys.stderr)
    return tools


def main():
    global ACTIVE_SANDBOX
    if len(sys.argv) == 3 and sys.argv[1] == "-restore":
        sys.exit(restore(sys.argv[2]))

    args = sys.argv[1:]
    if len(args) >= 1 and args[0] == "-sandbox":
        args = args[1:]
        if not sandbox_available():
            # 要了沙箱又给不了，就明确拒绝启动——降级成"假装有沙箱"
            # 比没有沙箱更危险：你以为有边界，其实没有。
            print("错误: 这台机器提供不了 OS 级沙箱（本章实现只支持带 sandbox-exec 的 macOS），"
                  "拒绝在没有边界的情况下假装有边界地运行", file=sys.stderr)
            sys.exit(1)
        ACTIVE_SANDBOX = default_sandbox_policy()
        print(f"[沙箱开启：可写 {ACTIVE_SANDBOX['write_roots']}，"
              "家目录不可读（工作目录和临时目录除外），网络关闭——OS 强制，批准了也越不出去]",
              file=sys.stderr)
    resume_id = ""
    if len(args) >= 2 and args[0] == "-c":
        resume_id, args = args[1], args[2:]
    # 任务从必填变成选填：不给就直接进提示符，给了就当第一句话，说完
    # 照样留在提示符上。这是这一章唯一改变的用法。
    first_task = args[0] if args else ""
    api_key = os.environ.get("OPENAI_API_KEY", "")
    model = os.environ.get("MODEL", "")
    if not api_key or not model:
        print("需要环境变量 OPENAI_API_KEY 和 MODEL", file=sys.stderr)
        print("例: export OPENAI_API_KEY=sk-xxxx", file=sys.stderr)
        print("    export MODEL=deepseek-v4-flash", file=sys.stderr)
        print("    export OPENAI_BASE_URL=https://api.deepseek.com/v1  # 不设则默认 OpenAI 官方", file=sys.stderr)
        sys.exit(1)
    base = os.environ.get("OPENAI_BASE_URL", "") or "https://api.openai.com/v1"

    # 全部工具在这里注册。加第五个工具 = 在这里加一行，别处一个字不用动。
    skills = discover_skills()
    tools = [ReadFileTool(), WriteFileTool(), EditFileTool(), BashTool()]
    if skills:
        # 一个 skill 都没发现就不挂 skill 工具——模型不该看见一个永远
        # 调不出东西的空壳工具，蒸馏自 octo DefaultTools() 同一条判断。
        tools.append(SkillTool(skills))
        # 清单这一层的账，现在就能算：它冻结进 system prompt，往后
        # 每一轮都要重新算一遍钱，不管这一轮用不用得上任何一个 skill。
        # estimate_text 是练习 12 就有的粗略估算，够拿来对比数量级。
        manifest = skill_manifest(skills)
        print(f"[skill 清单：{len(skills)} 个 skill，约 {estimate_text(manifest)} tokens，"
              "随 system prompt 每轮都算钱]", file=sys.stderr)
    # MCP 工具在这里接入——排在 sub_agent 之前，所以子 agent 的工具集里
    # 也有它们：外部工具没有防递归的顾虑，分身也用得上"别人的工具"。
    tools = connect_mcp_servers(tools)
    # SubAgentTool 拿到的是此刻的 tools——不含它自己，因为这一行还
    # 没把它加进去。子 agent 的注册表由这份列表构造，天生没有 sub_agent
    # 这个名字，递归在结构上就不成立，不是靠模型自觉不去调用它。
    sub_agent = SubAgentTool(base, api_key, model, list(tools), skills)
    tools.append(sub_agent)
    # workflow 也排在 sub_agent 之后才加——子 agent 的工具集里同样没有
    # workflow 这个名字，一份计划里的子任务不能自己再展开一份计划。
    tools.append(WorkflowTool(sub_agent))
    reg = Registry(*tools)

    if resume_id:
        try:
            sess = load_session(resume_id)
        except (OSError, ValueError) as e:
            print(f"错误: 恢复会话失败: {e}", file=sys.stderr)
            sys.exit(1)
        print(f"[恢复会话 {sess.id}，已有 {len(sess.history)} 条消息]", file=sys.stderr)
    else:
        try:
            sess = new_session_file([{"role": "system", "content": compose_system_prompt(skills)}])
        except OSError as e:
            print(f"错误: 创建会话文件失败: {e}", file=sys.stderr)
            sys.exit(1)
        print(f"[新建会话 {sess.id}]", file=sys.stderr)

    # 这一刻是估算值唯一有用武之地的时候：还没发出过任何请求，check_budget
    # 依赖的真实数字根本不存在——尤其是 -c 恢复一个老会话时，history 可能已经
    # 很大，你想在花钱之前先摸个底，能查的只有这个粗略估算。
    window = effective_context_window(model)
    pre_estimate = estimate_tokens(sess.history)
    print(f"[窗口: {model} → {window} tokens（发出第一个请求前，估算值: {pre_estimate} tokens）]",
          file=sys.stderr)
    if pre_estimate >= window * BUDGET_FRACTION:
        print("⚠️  恢复的历史估算下来已经接近预算上限，还没发请求就先说一声——真实数字要等第一轮回来才知道",
              file=sys.stderr)

    sys.exit(repl(base, api_key, model, reg, sess, window, first_task))


# ---- 常驻层：一个不退出的循环 ----

MAX_ROUNDS = 10


# heal_turn 把一轮没正常收尾的历史补回合法状态。
#
# 半途而废不是免费的：它会把 history 停在一个协议不允许的位置。一条带
# tool_calls 的 assistant 消息，后面必须跟着每个 id 对应的 tool 消息，
# 打断正好落在这两者之间，下一句话发出去就是 400——不是模型不高兴，是
# 请求本身不合法。补上"没有执行"的结果，再留一条模型看得见的说明：它得
# 知道刚才那件事是断在半路的，不是自己干完了。
#
# 请求失败走的是同一条路：那时候历史停在一条没人回应的 user 消息上，
# 下一句话再进来就是连着两条 user，同样要在这里收干净。
def heal_turn(history, note):
    if not history:
        return history
    last = history[-1]
    if last.get("role") == "assistant" and not last.get("tool_calls"):
        return history  # 模型把话说完了才出的事，历史本来就是合法的
    if last.get("role") == "assistant" and last.get("tool_calls"):
        for tc in last["tool_calls"]:
            history.append({
                "role": "tool",
                "tool_call_id": tc["id"],
                "content": "错误: 这一轮中断了，这个工具没有执行。",
            })
    history.append({"role": "assistant", "content": note})
    return history


# heal 收拾一轮没能正常收尾的历史，然后存盘。
def heal(sess, note):
    sess.history = heal_turn(sess.history, note)
    try:
        sess.save()
    except OSError as e:
        print(f"警告: 会话保存失败: {e}", file=sys.stderr)


# run_turn 把一句话跑到底：发请求、有 tool_calls 就分发、没有就收工。
# 循环结构和练习 5 一模一样，这一章只多两件事——cancel_event 在检查点
# 被查一遍，以及出错时抛异常而不是 sys.exit。cancel_event 只在轮次
# 边界（下一个请求之前、工具批量执行完之后）生效——urllib 的请求和
# subprocess 的 bash 调用一旦已经发出/已经在跑，这一版不打断它，
# 只保证"这一轮接下来还没做的事不会再做"。
def run_turn(base, api_key, model, reg, sess, window, input_text, cancel_event):
    sess.history.append({"role": "user", "content": input_text})
    for round_no in range(1, MAX_ROUNDS + 1):
        if cancel_event.is_set():
            raise InterruptedError("cancelled")
        r = send(base, api_key, model, sess.history, reg.definitions())
        choice = r["choices"][0]
        msg = choice["message"]
        sess.history.append(msg)
        u = r.get("usage") or {}
        cached = (u.get("prompt_tokens_details") or {}).get("cached_tokens", 0)
        if check_budget(u.get("prompt_tokens", 0), window):
            trigger = int(window * BUDGET_FRACTION)
            keep_budget = compact_keep_budget(window, trigger)
            try:
                rebuilt, folded = compact(base, api_key, model, sess.history, keep_budget)
            except Exception as e:
                print(f"警告: 压缩失败，继续用未压缩的历史: {e}", file=sys.stderr)
            else:
                if folded > 0:
                    print(f"[压缩：把前 {folded} 条消息折叠成一条摘要，{len(sess.history)} 条 → {len(rebuilt)} 条]",
                          file=sys.stderr)
                    sess.history = rebuilt
                    sess.force_rewrite = True
                else:
                    print("[压缩：还没有两条完整的用户消息可折叠，跳过这一轮]", file=sys.stderr)

        if choice.get("finish_reason") != "tool_calls":
            print(msg.get("content") or "", flush=True)
            print(f"\n[本轮 {round_no} 次请求 · 最后一次输入 {u.get('prompt_tokens', 0)} tokens"
                  f"（命中缓存 {cached}）· finish_reason={choice.get('finish_reason')}]", file=sys.stderr)
            sess.save()
            return

        print(f"[round {round_no} 输入 {u.get('prompt_tokens', 0)} tokens，命中缓存 {cached}]",
              file=sys.stderr)
        tool_calls = msg.get("tool_calls") or []
        if can_fan_out(tool_calls):
            print(f"[round {round_no} 并发扇出：{len(tool_calls)} 个 sub_agent，"
                  f"上限 {MAX_PARALLEL_SUB_AGENTS} 个坑位]", file=sys.stderr)
        sess.history.extend(dispatch_tool_calls(reg, round_no, tool_calls))
        sess.save()
        # 检查点放在工具批量执行完之后，跟"发下一个请求之前"对称——
        # 工具已经跑完的这一批不受影响，接下来还要不要再发一轮请求，
        # 到这里才有机会喊停。
        if cancel_event.is_set():
            raise InterruptedError("cancelled")
    raise RuntimeError(f"这一句话跑满 {MAX_ROUNDS} 次请求还没收敛，停在这里")


# run_interruptible 跑一轮，同时盯着 Ctrl+C。
#
# 信号只在轮次跑着的时候接管，跑完立刻还给操作系统：停在提示符上按
# Ctrl+C，就该跟任何一个命令行程序一样直接把进程干掉，那是用户的肌肉
# 记忆，别去改它。要改的只有"模型正在干活"这一小段时间里的含义——那时候
# Ctrl+C 是"这件事别做了"，不是"这个程序不要了"。
#
# 轮次跑在一个后台线程里，主线程留着 join() 它——Python 的信号处理函数
# 只在主线程运行：SIGINT 到达时，即使主线程正阻塞在 join() 里，也会先
# 跳出去执行 handler（这里只是 set 一下事件），再回到 join() 继续等，
# 这跟 Go 版"select 守着 done 和 sig 两个 channel"是同一个效果，只是
# 换了 Python 的机制来实现"等它真的收摊再往下走"。
def run_interruptible(base, api_key, model, reg, sess, window, input_text):
    cancel_event = threading.Event()
    outcome = {}

    def worker():
        try:
            run_turn(base, api_key, model, reg, sess, window, input_text, cancel_event)
        except InterruptedError:
            outcome["interrupted"] = True
        except Exception as e:
            outcome["error"] = e

    def handler(signum, frame):
        cancel_event.set()

    old_handler = signal.signal(signal.SIGINT, handler)
    t = threading.Thread(target=worker)
    t.start()
    t.join()
    signal.signal(signal.SIGINT, old_handler)

    if outcome.get("interrupted"):
        heal(sess, "[这一轮被用户打断]")
        print("\n[已打断这一轮。对话还在，接着说]", file=sys.stderr)
    elif "error" in outcome:
        # 一次请求失败不该带走整个进程——这是常驻和一次性最实际的
        # 区别：报错、收拾干净、回到提示符，对话还在。
        print("错误:", outcome["error"], file=sys.stderr)
        heal(sess, f"[这一轮没跑完：{outcome['error']}]")


# repl 是这一章加的全部东西：读一行、跑一轮、回到读一行。前面二十三章
# 的进程活到 main 的最后一句就结束了，一句话一条命；从这里开始它不走
# 了，一直等着你说下一句。
#
# 这不是一个工具，是运行环境的形态变了。往后几章要加的能力——插话、定时
# 唤醒、后台任务跑完了来报信——全都得先有一个"还醒着的进程"才谈得上。
def repl(base, api_key, model, reg, sess, window, first_task):
    print("[常驻模式：一行一句话。空行忽略，/exit 或 Ctrl+D 退出；轮次跑起来之后 Ctrl+C 打断这一轮，不退出进程]",
          file=sys.stderr)
    while True:
        line = first_task
        first_task = ""
        if not line:
            print("\n> ", file=sys.stderr, end="", flush=True)
            text = sys.stdin.readline()
            if not text:  # EOF（Ctrl+D）
                print(file=sys.stderr)
                break
            line = text.strip()
        if not line:
            continue
        if line in ("/exit", "/quit"):
            break
        run_interruptible(base, api_key, model, reg, sess, window, line)
    try:
        sess.save()
    except OSError as e:
        print(f"警告: 会话保存失败: {e}", file=sys.stderr)
    print(f"[会话 ID: {sess.id}，用 -c {sess.id} 继续]", file=sys.stderr)
    return 0


def send(base, api_key, model, history, tools):
    payload = {
        "model": model,
        "max_tokens": 4096,
        "messages": history,
    }
    # tools 为 None 时整个键都不发——Go 版靠 omitempty 自动做到这一点，
    # Python 的 json.dumps 会把 None 老实写成 null，服务端不一定认，得手动省掉。
    if tools:
        payload["tools"] = tools
    body = json.dumps(payload).encode()
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
