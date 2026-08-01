// Learn Agent the Hard Way — 练习 18：为什么不让 agent 自动写 skill
//
// 模型手上已经有 write_file，能写到 cwd 下任何路径——包括 .harness-skills/
// 自己。没有任何代码拦着它把一次任务顺手总结成一份新 skill。这一章问：
// 如果真的鼓励它这么干，会发生什么？练习 15 在记忆这件事上已经见过"只生成
// 不回收是熵增"；这一章把同一个问题换到 skill 头上，答案不是"不让它写"，
// 是"写在哪儿、谁来点头，这两件事不能是同一步"。
package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

// ---- 工具层 ----

// toolSpec 是发给模型的声明，和练习 5 相同。
type toolSpec struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	Parameters  map[string]any `json:"parameters"`
}

// tool 是每个工具要实现的接口：一份给模型看的声明，一个真正干活的函数。
// octo 里同名接口也是这两个方法——这不是巧合，是这件事的最小形状。
type tool interface {
	definition() toolSpec
	execute(args string) string
}

// readFileTool 就是练习 5 的 read_file，装进接口的壳。
type readFileTool struct{}

func (readFileTool) definition() toolSpec {
	return toolSpec{
		Name:        "read_file",
		Description: "读取一个本地文件，返回它的文本内容。修改文件前必须先用它读一遍。",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"path": map[string]any{"type": "string", "description": "要读取的文件路径"},
			},
			"required": []string{"path"},
		},
	}
}

func (readFileTool) execute(args string) string {
	var in struct {
		Path string `json:"path"`
	}
	if err := json.Unmarshal([]byte(args), &in); err != nil {
		return "错误: 参数不是合法 JSON: " + err.Error()
	}
	data, err := os.ReadFile(in.Path)
	if err != nil {
		return "错误: " + err.Error()
	}
	return string(data)
}

// writeFileTool 整个写入一个文件（不存在则创建，存在则覆盖）。
type writeFileTool struct{}

func (writeFileTool) definition() toolSpec {
	return toolSpec{
		Name:        "write_file",
		Description: "把内容完整写入一个文件。文件不存在就创建，存在就整个覆盖。",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"path":    map[string]any{"type": "string", "description": "目标文件路径"},
				"content": map[string]any{"type": "string", "description": "要写入的完整内容"},
			},
			"required": []string{"path", "content"},
		},
	}
}

func (writeFileTool) execute(args string) string {
	var in struct {
		Path    string `json:"path"`
		Content string `json:"content"`
	}
	if err := json.Unmarshal([]byte(args), &in); err != nil {
		return "错误: 参数不是合法 JSON: " + err.Error()
	}
	backup, err := backupIfExists(in.Path)
	if err != nil {
		return "错误: 备份旧内容失败，为安全起见拒绝覆盖: " + err.Error()
	}
	if err := os.WriteFile(in.Path, []byte(in.Content), 0o644); err != nil {
		return "错误: " + err.Error()
	}
	if backup != "" {
		return fmt.Sprintf("已把旧内容备份到 %s，然后写入 %s（%d 字节）", backup, in.Path, len(in.Content))
	}
	return fmt.Sprintf("已写入 %s（%d 字节）", in.Path, len(in.Content))
}

// editFileTool 精确替换文件中的一段文本。octo 的设计原样蒸馏：
// old_string 必须在文件里恰好出现一次——多了说明定位不唯一，少了说明找错了，
// 两种都拒绝执行。这比"按行号改"可靠得多：行号在模型的记忆里会漂，原文不会。
type editFileTool struct{}

func (editFileTool) definition() toolSpec {
	return toolSpec{
		Name: "edit_file",
		Description: "在已有文件里做一次精确替换。old_string 必须与文件现有内容逐字一致，" +
			"且只出现一次——不唯一时请带上足够的上下文再试。文件必须已存在（创建用 write_file）。",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"path":       map[string]any{"type": "string", "description": "目标文件路径"},
				"old_string": map[string]any{"type": "string", "description": "要找到的原文，必须唯一"},
				"new_string": map[string]any{"type": "string", "description": "替换成的新文本，可以为空（等于删除）"},
			},
			"required": []string{"path", "old_string", "new_string"},
		},
	}
}

func (editFileTool) execute(args string) string {
	var in struct {
		Path      string `json:"path"`
		OldString string `json:"old_string"`
		NewString string `json:"new_string"`
	}
	if err := json.Unmarshal([]byte(args), &in); err != nil {
		return "错误: 参数不是合法 JSON: " + err.Error()
	}
	data, err := os.ReadFile(in.Path)
	if err != nil {
		return "错误: " + err.Error()
	}
	text := string(data)
	switch n := strings.Count(text, in.OldString); {
	case in.OldString == "":
		return "错误: old_string 不能为空"
	case n == 0:
		return "错误: old_string 在文件里找不到——和 read_file 看到的原文逐字对一下"
	case n > 1:
		return fmt.Sprintf("错误: old_string 出现了 %d 次，无法确定改哪一处——多带几行上下文让它唯一", n)
	}
	text = strings.Replace(text, in.OldString, in.NewString, 1)
	if err := os.WriteFile(in.Path, []byte(text), 0o644); err != nil {
		return "错误: " + err.Error()
	}
	return "已替换 " + in.Path + " 中的一处文本"
}

// ---- bash：特权工具 ----

// 超时是双层的：不传用默认值，传了也有上限——上限保护的是你，不是模型。
const (
	defaultBashTimeout = 30 * time.Second
	maxBashTimeout     = 120 * time.Second
	maxBashOutput      = 8 * 1024 // 字节。工具结果会原样进上下文，必须封顶
)

// workDir 在启动时定死。每次 bash 调用都是一个全新进程，
// 模型在命令里 cd 到哪里，都随那个进程一起消失——工作目录由 harness 持有。
var workDir, _ = os.Getwd()

type bashTool struct{}

func (bashTool) definition() toolSpec {
	return toolSpec{
		Name: "bash",
		Description: "在系统 shell 里运行一条命令，返回 stdout 和 stderr。" +
			"命令总是在固定的工作目录执行，cd 不会跨调用生效。" +
			"默认 30 秒超时；预计更久就传 timeout（整数秒，上限 120）。" +
			"能用 read_file / write_file / edit_file 完成的事，优先用那些专用工具。",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"command": map[string]any{"type": "string", "description": "要执行的 shell 命令"},
				"timeout": map[string]any{"type": "integer", "description": "超时秒数，可选，默认 30，上限 120"},
			},
			"required": []string{"command"},
		},
	}
}

func (bashTool) execute(args string) string {
	var in struct {
		Command string `json:"command"`
		Timeout int    `json:"timeout"`
	}
	if err := json.Unmarshal([]byte(args), &in); err != nil {
		return "错误: 参数不是合法 JSON: " + err.Error()
	}
	if strings.TrimSpace(in.Command) == "" {
		return "错误: command 不能为空"
	}
	d := defaultBashTimeout
	if in.Timeout > 0 {
		d = time.Duration(in.Timeout) * time.Second
		if d > maxBashTimeout {
			return fmt.Sprintf("错误: timeout 最大 %d 秒。要跑更久的命令，把它拆小，或者放弃在一次调用里等它",
				int(maxBashTimeout.Seconds()))
		}
	}

	ctx, cancel := context.WithTimeout(context.Background(), d)
	defer cancel()
	cmd := exec.CommandContext(ctx, "sh", "-c", in.Command)
	cmd.Dir = workDir
	out, err := cmd.CombinedOutput() // stdout 和 stderr 合在一起，模型两样都要看

	text := tail(string(out), maxBashOutput)
	if ctx.Err() == context.DeadlineExceeded {
		// 被杀也要把已产生的输出交回去——死前的输出往往就是死因。
		return fmt.Sprintf("错误: 命令超过 %s 被终止。被杀前的输出：\n%s", d, text)
	}
	if err != nil {
		// 非零退出不是异常，是情报：让模型自己读 exit code 和错误输出。
		return fmt.Sprintf("%s\n[%v]", text, err)
	}
	if text == "" {
		return "(命令成功，无输出)"
	}
	return text
}

// tail 超长时保留结尾——命令的结论和报错几乎总在最后，开头多半是刷屏。
func tail(s string, max int) string {
	if len(s) <= max {
		return s
	}
	cut := s[len(s)-max:]
	if i := strings.IndexByte(cut, '\n'); i >= 0 {
		cut = cut[i+1:] // 对齐到整行，别吐半截行
	}
	return fmt.Sprintf("[... 前面 %d 字节被截断，只保留结尾 ...]\n%s", len(s)-len(cut), cut)
}

// ---- 注册表层 ----

// registry 按名字分发工具调用，并在这一层安装横切纪律。
// 纪律装在注册表而不是某个工具里，因为它管的是工具**之间**的关系。
type registry struct {
	tools   map[string]tool
	order   []string        // 保持声明顺序，发给模型的列表要稳定
	hasRead map[string]bool // read-before-write 记录：这个会话里读过哪些文件
}

func newRegistry(ts ...tool) *registry {
	r := &registry{tools: map[string]tool{}, hasRead: map[string]bool{}}
	for _, t := range ts {
		spec := t.definition()
		r.tools[spec.Name] = t
		r.order = append(r.order, spec.Name)
	}
	return r
}

// definitions 生成发给模型的 tools 数组。
func (r *registry) definitions() []map[string]any {
	var out []map[string]any
	for _, name := range r.order {
		out = append(out, map[string]any{
			"type":     "function",
			"function": r.tools[name].definition(),
		})
	}
	return out
}

// execute 查表分发。改文件的调用先过 read-before-write 检查：
// 没读过就想改一个已存在的文件？拒绝——模型会先去读，然后带着事实回来。
// bash 调用还要多过一关：权限检查。这一关不问模型愿不愿意，
// deny 直接拒绝、ask 停下来问人——两种情况下面这行 t.execute 都不会被跑到，
// 真正调 exec.CommandContext 的代码，危险命令根本够不着。
func (r *registry) execute(name, args string) string {
	t, ok := r.tools[name]
	if !ok {
		return "错误: 未知工具 " + name
	}
	if name == "write_file" || name == "edit_file" {
		path := pathOf(args)
		if path != "" && fileExists(path) && !r.hasRead[path] {
			return "错误: " + path + " 已存在但这个会话里还没读过它。先用 read_file 看一眼，再来修改。"
		}
		if strings.HasPrefix(path, skillsRoot+"/") {
			// 生效目录，见 skillAuthoringGuidance 那段规矩：写进这里的
			// 东西下一轮就会算进清单的 token 账，这不是模型一个人能拍板
			// 的事——跟练习 9 的 bash ask 档同一个道理，同一个函数。
			if !confirm("模型想把一份 skill 写进生效目录：" + path) {
				return "错误: 权限拒绝——写入生效的 skill 目录需要用户批准，这次没有批准。"
			}
		}
	}
	if name == "bash" {
		cmd := commandOf(args)
		switch classifyBash(cmd) {
		case decisionDeny:
			return "错误: 权限拒绝——这条命令匹配了硬性禁止规则，不会执行，也不会询问。"
		case decisionAsk:
			if !askApproval(cmd) {
				return "错误: 权限拒绝——用户没有批准这条命令。"
			}
		}
	}
	result := t.execute(args)
	// 调用成功就记账：读过的文件可以改；刚写完的文件模型知道最新内容，也算读过。
	if path := pathOf(args); path != "" && !strings.HasPrefix(result, "错误:") {
		r.hasRead[path] = true
	}
	// skill 正文加载这一刻才真的花钱：清单那笔账每轮都付，这笔账只在
	// 被点名的这一轮付一次——两笔账分开打印，账本上的数字自己会说话。
	if name == "skill" && !strings.HasPrefix(result, "错误:") {
		fmt.Fprintf(os.Stderr, "[skill 正文进入对话：约 %d tokens，只这一轮付这笔账]\n", estimateText(result))
	}
	return result
}

func pathOf(args string) string {
	var in struct {
		Path string `json:"path"`
	}
	_ = json.Unmarshal([]byte(args), &in)
	return in.Path
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// ---- 备份层：覆盖前留一份 ----

// trashDir 是备份落地的地方，就在工作目录底下——足够找、足够简单，
// 不需要 octo 真实实现里那套按项目哈希分桶的复杂结构。
const trashDir = ".trash"

// backupIfExists 在覆盖一个已存在的文件前，把旧内容原样复制进 trashDir，
// 文件名前缀时间戳避免撞名。目标文件本来就不存在时什么都不做，返回空字符串
// ——没有"旧版本"可备份。这是覆盖前的最后一步，不是覆盖的替代品：
// write_file 该做的事一件没少，只是多了一份退路。
func backupIfExists(path string) (string, error) {
	if !fileExists(path) {
		return "", nil
	}
	if err := os.MkdirAll(trashDir, 0o755); err != nil {
		return "", err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	ts := time.Now().Format("20060102-150405")
	dest := filepath.Join(trashDir, ts+"_"+filepath.Base(path))
	if err := os.WriteFile(dest, data, 0o644); err != nil {
		return "", err
	}
	return dest, nil
}

// restore 找 trashDir 里这个文件名最新的一份备份，写回原路径。恢复动作
// 本身也先给"现在这份"备份一次——误删保护对自己也生效，不会因为你手滑
// 恢复错了版本就白白丢掉当前内容。
func restore(path string) int {
	entries, err := os.ReadDir(trashDir)
	if err != nil {
		fmt.Fprintln(os.Stderr, "错误: 没有找到", trashDir, "目录，或读取失败:", err)
		return 1
	}
	suffix := "_" + filepath.Base(path)
	var newest string
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), suffix) && e.Name() > newest {
			newest = e.Name()
		}
	}
	if newest == "" {
		fmt.Fprintf(os.Stderr, "错误: %s 里没有 %s 的备份\n", trashDir, filepath.Base(path))
		return 1
	}
	if _, err := backupIfExists(path); err != nil {
		fmt.Fprintln(os.Stderr, "错误: 备份当前版本失败，为安全起见拒绝恢复:", err)
		return 1
	}
	data, err := os.ReadFile(filepath.Join(trashDir, newest))
	if err != nil {
		fmt.Fprintln(os.Stderr, "错误:", err)
		return 1
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		fmt.Fprintln(os.Stderr, "错误:", err)
		return 1
	}
	fmt.Printf("已从 %s 恢复到 %s\n", filepath.Join(trashDir, newest), path)
	return 0
}

// ---- 权限层：拦下危险命令 ----

// decision 是权限检查的结论，档位从低到高：allow < ask < deny。
type decision int

const (
	decisionAllow decision = iota
	decisionAsk
	decisionDeny
)

// permRule 是一条模式规则：命令里出现了 pattern，就归到 decide 那一档。
type permRule struct {
	pattern string
	decide  decision
}

// bashRules 蒸馏自 octo 的 internal/permission/defaults.yml——声明顺序不重要，
// 重要的是档位：deny 赢 ask，ask 赢 allow。一条规则都没命中时，隐式默认是
// ask——宁可多问一句，不要放过一个没见过的命令。
var bashRules = []permRule{
	{"rm -rf /", decisionDeny},
	{"rm -rf ~", decisionDeny},
	{"rm -rf", decisionAsk},
	{"sudo ", decisionAsk},
	{"git push --force", decisionAsk},
	{"curl ", decisionAsk},
	{"ls", decisionAllow},
	{"cat ", decisionAllow},
	{"pwd", decisionAllow},
	{"echo ", decisionAllow},
	{"git status", decisionAllow},
}

// classifyBash 给一条 shell 命令分档。分三遍独立扫描，而不是一遍碰到就返回，
// 就是为了让"deny 赢 ask 赢 allow"这件事跟规则声明的先后顺序无关。
func classifyBash(cmd string) decision {
	for _, r := range bashRules {
		if r.decide == decisionDeny && strings.Contains(cmd, r.pattern) {
			return decisionDeny
		}
	}
	for _, r := range bashRules {
		if r.decide == decisionAsk && strings.Contains(cmd, r.pattern) {
			return decisionAsk
		}
	}
	for _, r := range bashRules {
		if r.decide != decisionAllow || !strings.Contains(cmd, r.pattern) {
			continue
		}
		// allow 比 deny/ask 挑剔：命令必须以这个词开头，且整条命令里不能有
		// shell 的链接符号——否则 "ls && rm -rf /" 会被 "ls" 这条规则放行。
		trimmed := strings.TrimLeft(cmd, " \t")
		if strings.HasPrefix(trimmed, r.pattern) && !containsShellChain(cmd) {
			return decisionAllow
		}
	}
	return decisionAsk
}

// containsShellChain 检查命令里有没有把一条命令接到另一条上的符号。
func containsShellChain(cmd string) bool {
	return strings.ContainsAny(cmd, ";|&$()`\n")
}

// confirm 停下来问人，不是问模型——危险命令要过这一关，模型自己怎么想
// 不算数。读不到回答（比如脚本化调用、没有终端）一律按拒绝处理，安全
// 边界宁可保守，不能因为读不到输入就放行。练习 9 只拿它拦 bash；这一章
// 把它从 askApproval 里剥出来单独命名，因为要拦的不只是命令了。
func confirm(prompt string) bool {
	fmt.Fprintf(os.Stderr, "\n⚠️  %s\n允许吗？(y/N) ", prompt)
	line, err := bufio.NewReader(os.Stdin).ReadString('\n')
	if err != nil {
		return false
	}
	answer := strings.ToLower(strings.TrimSpace(line))
	return answer == "y" || answer == "yes"
}

// askApproval 是 confirm 在 bash 场景下的老名字，练习 9 的调用点不用改。
func askApproval(cmd string) bool {
	return confirm("模型想执行: " + cmd)
}

func commandOf(args string) string {
	var in struct {
		Command string `json:"command"`
	}
	_ = json.Unmarshal([]byte(args), &in)
	return in.Command
}

// ---- base prompt：给模型的说明书 ----

// basePrompt 蒸馏自 octo 的 internal/prompt/base.md——生产 harness 里
// 模型真实读到的规矩，这里只留下和我们这四个工具相关的几条。
// 它坐进 history 第 0 位的 system 消息，练习 3 你已经知道这个位置；
// 没讲过的是：为什么内容从此定死，一个字都不该在会话中途改。
const basePrompt = `你是一个能操作本地文件和 shell 的助手，通过工具真正执行动作，而不是描述打算做什么。

- 能用 read_file / write_file / edit_file 完成的事，优先用它们；bash 留给专用工具做不到的事（跑测试、跑 git、装依赖、查系统信息）。
- 修改一个已经存在的文件前，必须先用 read_file 读过它一遍——这条规矩不因为你换了工具执行修改就不算数：用 bash 的 echo / sed / tee 等方式直接改文件内容，同样要先读一遍再动手。能用 edit_file 完成的局部修改，优先用 edit_file 而不是 sed -i，这样改动会经过校验，而不是绕开它。
- 只做任务要求的改动，不顺手重构、不改无关代码。`

// ---- 规则文件层：项目自己的约定 ----

// projectRulesFile 蒸馏自 octo 的 ProjectContextFile（.octorules）——
// 每个项目自己的行为约定，跟 basePrompt 那种"放之四海皆准"的规矩不同，
// 这份文件只对当前项目生效，随项目一起进版本库。
const projectRulesFile = ".harnessrules"

// readProjectRules 读工作目录下的 .harnessrules，文件不存在或读不出来
// 就返回空字符串——没有这份文件是完全正常的状态，不是错误。
func readProjectRules() string {
	data, err := os.ReadFile(projectRulesFile)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(data))
}

// ---- 记忆层：模型自己维护的跨会话笔记 ----

// memoryFile 蒸馏自 octo 的 MEMORY.md——但只留最小的那一部分：一个项目
// 一份文件，本章不做 octo 真实实现里的按仓库分目录、跨项目继承、200 行/25KB
// 截断预算，够用就好，把"跨会话"这一件事立住是这一章的唯一目的。
const memoryFile = "MEMORY.md"

// readMemory 读工作目录下的 MEMORY.md，文件不存在就返回空字符串——
// 全新项目还没写过这份文件，这是正常状态，不是错误。
func readMemory() string {
	data, err := os.ReadFile(memoryFile)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(data))
}

// memoryGuidance 是这一层唯一新增的"规矩"，蒸馏自 octo 真实的 memory 注入
// 说明：MEMORY.md 是什么、什么值得写、用什么工具写。这段话不因文件是否
// 存在而变化——第一次跑到这个项目，模型也要知道有这么个地方能写。
// 全书唯一一处故意不新增专用工具的地方：记东西用 write_file，改错一条、
// 删掉一条用 edit_file——和练习 6 已经有的工具是同一套，没有专门的
// remember/forget。
const memoryGuidance = `# 跨会话记忆 (` + memoryFile + `)

` + memoryFile + ` 是你自己维护的记忆文件，不是这次任务的草稿。这次任务
结束后，下一次全新会话——不是用 -c 续接这一次，是完全重新开始的下一次
——会在系统提示里重新读到你现在写下的内容。

- 值得写：用户明确要求记住的偏好、和默认做法不一样的项目约定、你自己
  验证过、以后大概率还用得上的结论。不值得写：这次任务本身的中间状态、
  代码改动的具体内容——那些内容已经在文件和 git 历史里，不需要在这里
  重复一份。
- 没有专门的"记住"或"忘记"工具。` + memoryFile + ` 就是一个普通文件：
  想写新的用 write_file，想改一条用 edit_file，想删掉一条也是 edit_file
  ——记错一件事和改错一行代码，是同一种操作，用同一套工具。
- 引用这份文件里的内容之前，先确认它现在还成立——项目会变，你之前记下
  的事，不保证放到现在还是真的。`

// ---- skill 层：写在磁盘上、按需读的说明书 ----

// skillsRoot 蒸馏自 octo 的三层发现（default/user/project），本章只留
// 最简单的一层——一个项目一个目录，够用就好：这一章要立住的是"发现 +
// 注入"这一件事，不是完整的优先级覆盖体系。
const skillsRoot = ".harness-skills"

// skill 是一份发现到的说明书。Body 是正文——只有模型真的调用 skill 工具
// 要来的时候才会离开磁盘、进入对话。
type skill struct {
	Name        string
	Description string
	Body        string
	Dir         string
}

// discoverSkills 扫 skillsRoot 下的每个子目录，读它的 SKILL.md。跟 octo
// 真实实现一样宽容：目录里没有 SKILL.md、frontmatter 缺 description，
// 就跳过这一个，不中断整个发现过程——一份写坏的说明书不该拖垮整个会话。
// 目录名是权威的 skill 名，frontmatter 里写的 name 只是给人看的，不参与
// 查找——这是 Claude Code 的行为，兼容它意味着别人写好的 skill 目录，
// 挪过来就能用。
func discoverSkills() map[string]skill {
	out := map[string]skill{}
	entries, err := os.ReadDir(skillsRoot)
	if err != nil {
		return out
	}
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		dir := filepath.Join(skillsRoot, e.Name())
		data, err := os.ReadFile(filepath.Join(dir, "SKILL.md"))
		if err != nil {
			continue
		}
		desc, body, ok := parseSkillFile(string(data))
		if !ok || desc == "" {
			continue
		}
		out[e.Name()] = skill{Name: e.Name(), Description: desc, Body: body, Dir: dir}
	}
	return out
}

// parseSkillFile 切开一份 SKILL.md：开头一对 "---" 之间是 frontmatter，
// 之后是正文。frontmatter 只认一行一个 "key: value"，够用就好——真正的
// Claude Code 格式用 yaml.v3 解析、能处理嵌套 metadata 块，这里手写的
// 是一个只够识别 description 的子集，其余字段（allowed-tools、license
// 之类）原样跳过，不报错也不生效。
func parseSkillFile(text string) (description, body string, ok bool) {
	lines := strings.Split(text, "\n")
	if len(lines) == 0 || strings.TrimSpace(lines[0]) != "---" {
		return "", "", false
	}
	i := 1
	for ; i < len(lines); i++ {
		if strings.TrimSpace(lines[i]) == "---" {
			break
		}
		key, val, found := strings.Cut(lines[i], ":")
		if found && strings.TrimSpace(key) == "description" {
			description = strings.TrimSpace(val)
		}
	}
	if i >= len(lines) {
		return "", "", false // 没找到闭合的 "---"，frontmatter 不完整
	}
	body = strings.TrimSpace(strings.Join(lines[i+1:], "\n"))
	return description, body, true
}

// skillManifest 渲染 L1 清单：每个 skill 只留名字和 description，这是
// 模型判断"要不要用这个 skill"的唯一依据。正文不放这里——清单要塞进
// 冻结的 system prompt，多数任务用不上大多数 skill，正文太贵，全塞进去
// 不划算，留给 skill 工具按需加载才是这一层存在的意义。
func skillManifest(skills map[string]skill) string {
	if len(skills) == 0 {
		return ""
	}
	names := make([]string, 0, len(skills))
	for name := range skills {
		names = append(names, name)
	}
	sort.Strings(names) // 顺序必须稳定，否则清单文本每次不同，缓存前缀跟着作废
	var b strings.Builder
	b.WriteString("# 可用的 skill\n\n任务匹配某条 description 时，先调用 skill 工具" +
		"（参数 name）加载完整指令再动手——不要只凭这一句描述去猜正文写了什么。\n\n")
	for _, name := range names {
		b.WriteString("- " + name + ": " + skills[name].Description + "\n")
	}
	return strings.TrimSpace(b.String())
}

// skillsProposedRoot 是自动写 skill 的落地位置，刻意不是 skillsRoot。
// discoverSkills 只扫 skillsRoot，这个目录里的东西不会进清单、不会占
// 任何一轮的 token，直到人用 bash mv 把它挪进 skillsRoot 才生效——
// "写"和"生效"从代码层面就是两个不同的目录，不是靠模型自觉。
const skillsProposedRoot = ".harness-skills-proposed"

// skillAuthoringGuidance 把练习 15 那条教训换到 skill 头上：生成不难，
// 回收才是问题。这段规矩不因任何条件变化——即使这个项目现在一个 skill
// 都没有，模型也要知道"写草稿"和"生效"是两个目录、两件事，不是写一次
// write_file 就完事的同一步。
const skillAuthoringGuidance = `# 想沉淀新 skill 时

如果你判断一类任务以后会反复出现，值得写成一份新 skill 供下次复用——
可以写，但不要直接写进 "` + skillsRoot + `/<name>/SKILL.md"：那个目录
里的每一份 SKILL.md，只要存在，description 就会被打进清单，从下一轮起
每一轮对话都要为它多付一点 token，不管这一轮用不用得上。

草稿写到 "` + skillsProposedRoot + `/<name>/SKILL.md"，格式跟正式 skill
完全一样。这个目录不会被扫描、不会出现在清单里，写多少份草稿都不花一分
钱。写完之后告诉用户你觉得这份草稿值得转正，一句话说清楚它是什么、什么
时候该用——要不要挪进 "` + skillsRoot + `/" 生效，由用户决定，不是你。`

// skillTool 是 L2：清单只给名字和一句话，正文才是真正的指令，只有模型
// 点名要用了才发。它需要访问这次进程发现到的 skills，不能像 read_file
// 那样是无状态的零值结构体，所以带一个字段。
type skillTool struct {
	skills map[string]skill
}

func (t skillTool) definition() toolSpec {
	return toolSpec{
		Name: "skill",
		Description: "加载一个 skill 的完整指令。先看系统提示里“可用的 skill”清单，" +
			"任务匹配某条 description 时，用这个工具把对应 skill 的正文加载进来再动手。",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"name": map[string]any{"type": "string", "description": "要加载的 skill 名字，清单里“-”后面那个词"},
			},
			"required": []string{"name"},
		},
	}
}

func (t skillTool) execute(args string) string {
	var in struct {
		Name string `json:"name"`
	}
	if err := json.Unmarshal([]byte(args), &in); err != nil {
		return "错误: 参数不是合法 JSON: " + err.Error()
	}
	sk, ok := t.skills[in.Name]
	if !ok {
		return "错误: 没有叫 " + in.Name + " 的 skill——从系统提示的清单里选一个"
	}
	return "[skill \"" + sk.Name + "\"，所在目录：" + sk.Dir + "]\n\n" + sk.Body
}

// composeSystemPrompt 把 basePrompt、项目规则、skill 清单、记忆拼成一份
// system prompt，蒸馏自 octo Compose 的分层方式：每层之间用同一个分隔符
// 隔开，某一层没有内容就跳过那一层。这份拼好的文字，从会话创建那一刻起
// 冻结——练习 8 讲过为什么：中途改一个字，隐式缓存就整条作废。
func composeSystemPrompt(skills map[string]skill) string {
	prompt := basePrompt
	if rules := readProjectRules(); rules != "" {
		prompt += "\n\n---\n\n# 项目约定 (" + projectRulesFile + ")\n\n" + rules
	}
	if manifest := skillManifest(skills); manifest != "" {
		prompt += "\n\n---\n\n" + manifest
	}
	prompt += "\n\n---\n\n" + skillAuthoringGuidance
	prompt += "\n\n---\n\n" + memoryGuidance
	if mem := readMemory(); mem != "" {
		prompt += "\n\n## 你目前记下的内容\n\n" + mem
	} else {
		prompt += "\n\n## 你目前记下的内容\n\n（还是空的——这是这个项目第一次有你可读的记忆）"
	}
	return prompt
}

// ---- 协议层：和练习 5 相同 ----

type message struct {
	Role       string     `json:"role"`
	Content    string     `json:"content"`
	ToolCalls  []toolCall `json:"tool_calls,omitempty"`
	ToolCallID string     `json:"tool_call_id,omitempty"`
}

type toolCall struct {
	ID       string `json:"id"`
	Type     string `json:"type"`
	Function struct {
		Name      string `json:"name"`
		Arguments string `json:"arguments"`
	} `json:"function"`
}

type request struct {
	Model     string           `json:"model"`
	Messages  []message        `json:"messages"`
	MaxTokens int              `json:"max_tokens,omitempty"`
	Tools     []map[string]any `json:"tools,omitempty"`
}

type response struct {
	Choices []struct {
		Message      message `json:"message"`
		FinishReason string  `json:"finish_reason"`
	} `json:"choices"`
	Usage struct {
		PromptTokens        int `json:"prompt_tokens"`
		CompletionTokens    int `json:"completion_tokens"`
		PromptTokensDetails struct {
			CachedTokens int `json:"cached_tokens"` // 命中隐式前缀缓存的部分，协议字段，不是 DeepSeek 专有
		} `json:"prompt_tokens_details"`
	} `json:"usage"`
	Error *struct {
		Message string `json:"message"`
		Type    string `json:"type"`
	} `json:"error"`
}

// ---- 会话层：把 history 写到磁盘上 ----

// sessionDir 是会话文件存放的地方，跟 .trash 一样就在工作目录底下。
const sessionDir = ".sessions"

// session 是一次对话的全部状态：一个 ID，加上完整的 History。persisted
// 记录 History 里前多少条消息已经写盘——save 只补写 persisted 之后新增的
// 部分，不是每次都把整个文件重写一遍。这是练习 11 的核心账本：存盘的代价
// 只跟"这一轮新增了多少条"有关，跟"这场对话已经聊了多久"无关。
// forceRewrite 是这一章新加的：压缩会把 History 前半段整个换成一条摘要，
// 磁盘上原来那些行不再对应现在的内容，下次 save 不能只追加，得整个重写。
type session struct {
	ID           string
	CreatedAt    time.Time
	History      []message
	persisted    int
	forceRewrite bool
}

// sessionRecord 是 JSONL 里的一行。meta 只在文件开头出现一次；
// 之后每条消息各占一行——练习 3 的 history 数组，这一章有了持久版本。
type sessionRecord struct {
	Type      string    `json:"type"` // "meta" | "message"
	ID        string    `json:"id,omitempty"`
	CreatedAt time.Time `json:"created_at,omitempty"`
	Message   *message  `json:"message,omitempty"`
}

// newSessionID 生成 时间戳-随机后缀 形式的 ID：时间戳让它天然按时间排序、
// 人眼可读；随机后缀避免同一秒内两个会话撞名。
func newSessionID() string {
	now := time.Now()
	var b [4]byte
	_, _ = rand.Read(b[:])
	return now.Format("20060102-150405") + "-" + hex.EncodeToString(b[:])
}

func sessionPath(id string) string {
	return filepath.Join(sessionDir, id+".jsonl")
}

// newSessionFile 开一个新会话：建目录、写 meta 头，返回可以继续追加的 session。
func newSessionFile(history []message) (*session, error) {
	if err := os.MkdirAll(sessionDir, 0o755); err != nil {
		return nil, err
	}
	s := &session{ID: newSessionID(), CreatedAt: time.Now(), History: history}
	f, err := os.OpenFile(sessionPath(s.ID), os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	enc := json.NewEncoder(f)
	if err := enc.Encode(sessionRecord{Type: "meta", ID: s.ID, CreatedAt: s.CreatedAt}); err != nil {
		return nil, err
	}
	for i := range history {
		if err := enc.Encode(sessionRecord{Type: "message", Message: &history[i]}); err != nil {
			return nil, err
		}
	}
	s.persisted = len(history)
	return s, nil
}

// save 平时只追加 History[persisted:]；forceRewrite 被压缩置位之后，
// 磁盘上的旧行不再可信，改成整个截断重写。没有新消息、也没被标记
// forceRewrite 时是个空操作——一轮里模型只回了一句话，这次 save 什么都不写。
func (s *session) save() error {
	if s.forceRewrite {
		return s.rewriteAll()
	}
	if len(s.History) == s.persisted {
		return nil
	}
	return s.appendDelta()
}

// appendDelta 是练习 11 原来的 save：只补写 persisted 之后新增的部分。
func (s *session) appendDelta() error {
	f, err := os.OpenFile(sessionPath(s.ID), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return err
	}
	defer f.Close()
	enc := json.NewEncoder(f)
	for i := s.persisted; i < len(s.History); i++ {
		if err := enc.Encode(sessionRecord{Type: "message", Message: &s.History[i]}); err != nil {
			return err
		}
	}
	s.persisted = len(s.History)
	return nil
}

// rewriteAll 截断文件，把 meta 和当前完整的 History 重新写一遍——压缩
// 之后唯一正确的存盘方式：History 前半段的内容已经变了，追加只会把
// 新旧两份摘要和原文混在一起。
func (s *session) rewriteAll() error {
	f, err := os.OpenFile(sessionPath(s.ID), os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		return err
	}
	defer f.Close()
	enc := json.NewEncoder(f)
	if err := enc.Encode(sessionRecord{Type: "meta", ID: s.ID, CreatedAt: s.CreatedAt}); err != nil {
		return err
	}
	for i := range s.History {
		if err := enc.Encode(sessionRecord{Type: "message", Message: &s.History[i]}); err != nil {
			return err
		}
	}
	s.persisted = len(s.History)
	s.forceRewrite = false
	return nil
}

// loadSession 读一份 JSONL，把 meta 和 message 记录重放回 History。
// 最后一行如果不完整（进程写到一半时被杀），就连同它一起丢掉——
// 半条消息比没有消息更危险：模型会把它当成一条完整的历史来读，
// 而它实际上什么都不是。
func loadSession(id string) (*session, error) {
	data, err := os.ReadFile(sessionPath(id))
	if err != nil {
		return nil, err
	}
	if n := bytes.LastIndexByte(data, '\n'); n >= 0 {
		data = data[:n+1]
	} else {
		data = nil
	}

	s := &session{ID: id}
	sc := bufio.NewScanner(bytes.NewReader(data))
	sc.Buffer(make([]byte, 64*1024), 16*1024*1024)
	for sc.Scan() {
		line := sc.Bytes()
		if len(line) == 0 {
			continue
		}
		var rec sessionRecord
		if err := json.Unmarshal(line, &rec); err != nil {
			return nil, fmt.Errorf("会话文件损坏: %w", err)
		}
		switch rec.Type {
		case "meta":
			s.CreatedAt = rec.CreatedAt
		case "message":
			if rec.Message != nil {
				s.History = append(s.History, *rec.Message)
			}
		}
	}
	if err := sc.Err(); err != nil {
		return nil, err
	}
	s.persisted = len(s.History)
	return s, nil
}

// ---- 预算层：知道自己还有多少余地 ----

// contextWindow 返回一个模型的上下文窗口大小（token 数），蒸馏自 octo 里
// 一张更大的模型-窗口对照表——按名字子串匹配，匹配不到就退回保守的默认值。
// 宁可低估：低估最多让你提前一点行动，高估会让你真的撑爆上下文。
func contextWindow(model string) int {
	m := strings.ToLower(model)
	switch {
	case strings.Contains(m, "deepseek"):
		return 1_000_000
	case strings.Contains(m, "gpt-4"):
		return 128_000
	case strings.Contains(m, "claude"):
		return 200_000
	default:
		return 128_000 // 不认识的模型，包括本机跑的大多数开源小模型
	}
}

// effectiveContextWindow 让你在这一章的实验里用 CONTEXT_WINDOW 人为调小窗口。
// 真实模型的窗口大到几十上百万 token，正常聊天几十轮都撞不上；这一章想让你
// 在几轮之内亲眼看到预算告急，所以留了这个后门——不设就用 contextWindow 的
// 真实值，这不是在否定真实模型的窗口有多大，只是为了让实验能在你的终端里
// 几秒钟内跑完。
func effectiveContextWindow(model string) int {
	if v := os.Getenv("CONTEXT_WINDOW"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return n
		}
	}
	return contextWindow(model)
}

// budgetFraction 是触发警告的门槛——占窗口的 75%，蒸馏自 octo 的
// compactThresholdFraction：剩下的 25% 留给最近的对话尾巴和这一轮的输出。
const budgetFraction = 0.75

// checkBudget 拿这一轮 API 真实回报的 token 数（不是估算值——练习 11 你
// 已经知道 API 会把这个数字如实报回来）去跟窗口比，报告一句话，并且告诉
// 调用方要不要开始压缩。练习 12 这个函数只喊话；这一章多了返回值，
// 喊话之后，真的动手。
func checkBudget(usedTokens, window int) bool {
	pct := float64(usedTokens) / float64(window) * 100
	fmt.Fprintf(os.Stderr, "[预算：%d/%d tokens，%.1f%%]\n", usedTokens, window, pct)
	over := float64(usedTokens) >= float64(window)*budgetFraction
	if over {
		fmt.Fprintf(os.Stderr, "⚠️  已用掉窗口的 %.0f%%，接近上限——开始压缩\n", pct)
	}
	return over
}

// estimateTokens 是没有真实 token 数时的快速估算：ASCII 大约 4 个字符一个
// token，中文这类多字节字符大约 1.5 个字符一个 token——不是真正的分词器，
// 只是个够用的粗略数，在还没发出第一个请求、拿不到 API 真实回报之前，
// 先给自己一个数量级。
func estimateTokens(msgs []message) int {
	total := 0
	for _, m := range msgs {
		total += estimateText(m.Content)
		for _, tc := range m.ToolCalls {
			total += estimateText(tc.Function.Name) + estimateText(tc.Function.Arguments)
		}
	}
	return total
}

func estimateText(s string) int {
	ascii, multi := 0, 0
	for _, r := range s {
		if r < 128 {
			ascii++
		} else {
			multi += utf8.RuneLen(r)
		}
	}
	return ascii/4 + int(float64(multi)/1.5+0.5)
}

// ---- 压缩层：不丢消息，是让模型总结它自己 ----

// compactKeepFraction 压缩后留多少"最近尾巴"原样保留，蒸馏自 octo 的
// defaultCompactKeepFraction：占窗口的 30%，但封顶不超过触发阈值的一半——
// 保证一次压缩确实能把用量拉回阈值以下，不会刚压完又立刻撞线。
const compactKeepFraction = 0.30

func compactKeepBudget(window, trigger int) int {
	budget := int(float64(window) * compactKeepFraction)
	if trigger > 0 && budget > trigger/2 {
		budget = trigger / 2
	}
	return budget
}

// safeSplitIndex 找压缩的分割点：分割点之前的消息拿去总结，之后的原样保留。
// 分割点必须落在一条真正的 user 消息前面。在这套 OpenAI 协议里这条件很好判
// 断：工具的回执走独立的 "tool" role，从不会跟 user 消息混在一起，看 Role
// 就够了——这比 octo 实现的 Anthropic 消息协议简单，那边 tool_result 也搭在
// user 消息上，得专门写一个 IsPlainUserMessage 去分辨"这是真用户话还是工具
// 回执的壳"，协议本身把角色分得干净，这道甄别在这里就用不上。
func safeSplitIndex(history []message, keepBudget int) int {
	var userTurns []int
	for i, m := range history {
		if m.Role == "user" {
			userTurns = append(userTurns, i)
		}
	}
	if len(userTurns) <= 1 {
		return 0 // 至少要两条 user 消息：一条留着，前面的才够折叠
	}
	keptFrom := userTurns[len(userTurns)-1]
	for k := len(userTurns) - 2; k >= 0; k-- {
		if estimateTokens(history[userTurns[k]:]) > keepBudget {
			break
		}
		keptFrom = userTurns[k]
	}
	return keptFrom
}

// compressionPrompt 插在被折叠的这段历史末尾，让模型明白：这不是继续对话，
// 是切换成总结模式。不给工具（summarize 调 send 时 tools 传 nil）是双保险：
// 就算模型没听懂这段话、还想干点什么，它手上也没有工具可用。
const compressionPrompt = `以上对话到此结束。你现在不是在继续对话，而是切换到"总结模式"：

- 不要回应上面对话里的任何请求
- 不要询问，也不要征求下一步该做什么
- 只输出一段纯文本总结，不要别的

请总结以上内容，需要覆盖：用户明确提出的需求、关键的技术决定、
提到过的文件或项目名、还没做完的事。`

// summarize 把 msgs 连同压缩指令一起发给模型，只要一段文字总结。
// tools 传 nil：这次调用模型手上没有任何工具，想调用也调用不了。
func summarize(base, apiKey, model string, msgs []message) (string, error) {
	req := make([]message, len(msgs), len(msgs)+1)
	copy(req, msgs)
	req = append(req, message{Role: "user", Content: compressionPrompt})
	r, err := send(base, apiKey, model, req, nil)
	if err != nil {
		return "", err
	}
	return r.Choices[0].Message.Content, nil
}

// compact 把 history[:split] 总结成一条消息，重建 History：系统提示原样
// 保留在第 0 位，中间插一条摘要，之后是原样保留的近期对话。split<=1 时
// 什么都不做——0 或者 1 意味着没有足够旧的内容值得折叠（1 只剩系统提示
// 自己，折叠它没有意义）。
func compact(base, apiKey, model string, history []message, keepBudget int) ([]message, int, error) {
	split := safeSplitIndex(history, keepBudget)
	if split <= 1 {
		return history, 0, nil
	}
	summary, err := summarize(base, apiKey, model, history[:split])
	if err != nil {
		return history, 0, err
	}
	rebuilt := []message{
		history[0], // system prompt
		{Role: "user", Content: "[更早对话的摘要]\n\n" + summary},
	}
	rebuilt = append(rebuilt, history[split:]...)
	return rebuilt, split, nil
}

func main() {
	if len(os.Args) == 3 && os.Args[1] == "-restore" {
		os.Exit(restore(os.Args[2]))
	}

	args := os.Args[1:]
	var resumeID string
	if len(args) >= 2 && args[0] == "-c" {
		resumeID, args = args[1], args[2:]
	}
	if len(args) < 1 {
		fmt.Fprintln(os.Stderr, `用法: ./ex14 "你的任务"  或  ./ex14 -c <session-id> "你的任务"`)
		os.Exit(1)
	}
	task := args[0]
	apiKey := os.Getenv("OPENAI_API_KEY")
	model := os.Getenv("MODEL")
	if apiKey == "" || model == "" {
		fmt.Fprintln(os.Stderr, "需要环境变量 OPENAI_API_KEY 和 MODEL")
		fmt.Fprintln(os.Stderr, `例: export OPENAI_API_KEY=sk-xxxx`)
		fmt.Fprintln(os.Stderr, `    export MODEL=deepseek-v4-flash`)
		fmt.Fprintln(os.Stderr, `    export OPENAI_BASE_URL=https://api.deepseek.com/v1  # 不设则默认 OpenAI 官方`)
		os.Exit(1)
	}
	base := os.Getenv("OPENAI_BASE_URL")
	if base == "" {
		base = "https://api.openai.com/v1"
	}

	// 全部工具在这里注册。加第四个工具 = 在这里加一行，别处一个字不用动。
	skills := discoverSkills()
	toolList := []tool{readFileTool{}, writeFileTool{}, editFileTool{}, bashTool{}}
	if len(skills) > 0 {
		// 一个 skill 都没发现就不挂 skill 工具——模型不该看见一个永远
		// 调不出东西的空壳工具，蒸馏自 octo DefaultTools() 同一条判断。
		toolList = append(toolList, skillTool{skills: skills})
		// 清单这一层的账，现在就能算：它冻结进 system prompt，往后
		// 每一轮都要重新算一遍钱，不管这一轮用不用得上任何一个 skill。
		// estimateText 是练习 12 就有的粗略估算，够拿来对比数量级。
		manifest := skillManifest(skills)
		fmt.Fprintf(os.Stderr, "[skill 清单：%d 个 skill，约 %d tokens，随 system prompt 每轮都算钱]\n",
			len(skills), estimateText(manifest))
	}
	reg := newRegistry(toolList...)

	var sess *session
	if resumeID != "" {
		loaded, err := loadSession(resumeID)
		if err != nil {
			fmt.Fprintln(os.Stderr, "错误: 恢复会话失败:", err)
			os.Exit(1)
		}
		sess = loaded
		fmt.Fprintf(os.Stderr, "[恢复会话 %s，已有 %d 条消息]\n", sess.ID, len(sess.History))
	} else {
		s, err := newSessionFile([]message{{Role: "system", Content: composeSystemPrompt(skills)}})
		if err != nil {
			fmt.Fprintln(os.Stderr, "错误: 创建会话文件失败:", err)
			os.Exit(1)
		}
		sess = s
		fmt.Fprintf(os.Stderr, "[新建会话 %s]\n", sess.ID)
	}
	sess.History = append(sess.History, message{Role: "user", Content: task})

	// 这一刻是估算值唯一有用武之地的时候：还没发出过任何请求，checkBudget
	// 依赖的真实数字根本不存在——尤其是 -c 恢复一个老会话时，History 可能已经
	// 很大，你想在花钱之前先摸个底，能查的只有这个粗略估算。
	window := effectiveContextWindow(model)
	preEstimate := estimateTokens(sess.History)
	fmt.Fprintf(os.Stderr, "[窗口: %s → %d tokens（发出第一个请求前，估算值: %d tokens）]\n",
		model, window, preEstimate)
	if float64(preEstimate) >= float64(window)*budgetFraction {
		fmt.Fprintf(os.Stderr, "⚠️  恢复的历史估算下来已经接近预算上限，还没发请求就先说一声——真实数字要等第一轮回来才知道\n")
	}

	// agent loop 的结构和练习 5 完全一样。变化只有两处：
	// 工具声明从注册表拿（reg.definitions），分发交给注册表（reg.execute）；
	// history 现在是 sess.History，每轮跑完都 save 一次。
	const maxRounds = 10
	for round := 1; round <= maxRounds; round++ {
		r, err := send(base, apiKey, model, sess.History, reg.definitions())
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		msg := r.Choices[0].Message
		sess.History = append(sess.History, msg)

		if checkBudget(r.Usage.PromptTokens, window) {
			trigger := int(float64(window) * budgetFraction)
			keepBudget := compactKeepBudget(window, trigger)
			rebuilt, folded, err := compact(base, apiKey, model, sess.History, keepBudget)
			if err != nil {
				fmt.Fprintln(os.Stderr, "警告: 压缩失败，继续用未压缩的历史:", err)
			} else if folded > 0 {
				fmt.Fprintf(os.Stderr, "[压缩：把前 %d 条消息折叠成一条摘要，%d 条 → %d 条]\n",
					folded, len(sess.History), len(rebuilt))
				sess.History = rebuilt
				sess.forceRewrite = true
			} else {
				fmt.Fprintf(os.Stderr, "[压缩：还没有两条完整的用户消息可折叠，跳过这一轮]\n")
			}
		}

		if r.Choices[0].FinishReason != "tool_calls" {
			fmt.Println(msg.Content)
			fmt.Fprintf(os.Stderr, "\n[共 %d 轮 · 最后一轮输入 %d tokens（命中缓存 %d）· finish_reason=%s]\n",
				round, r.Usage.PromptTokens, r.Usage.PromptTokensDetails.CachedTokens, r.Choices[0].FinishReason)
			if err := sess.save(); err != nil {
				fmt.Fprintln(os.Stderr, "警告: 会话保存失败:", err)
			}
			fmt.Fprintf(os.Stderr, "[会话 ID: %s，用 -c %s 继续]\n", sess.ID, sess.ID)
			return
		}

		fmt.Fprintf(os.Stderr, "[round %d 输入 %d tokens，命中缓存 %d]\n",
			round, r.Usage.PromptTokens, r.Usage.PromptTokensDetails.CachedTokens)
		for _, tc := range msg.ToolCalls {
			fmt.Fprintf(os.Stderr, "[round %d] %s(%s)\n", round, tc.Function.Name, tc.Function.Arguments)
			result := reg.execute(tc.Function.Name, tc.Function.Arguments)
			sess.History = append(sess.History, message{
				Role:       "tool",
				ToolCallID: tc.ID,
				Content:    result,
			})
		}
		if err := sess.save(); err != nil {
			fmt.Fprintln(os.Stderr, "警告: 会话保存失败:", err)
		}
	}
	fmt.Fprintf(os.Stderr, "达到 %d 轮上限，停止。\n", maxRounds)
	os.Exit(1)
}

func send(base, apiKey, model string, history []message, tools []map[string]any) (response, error) {
	var r response
	body, _ := json.Marshal(request{
		Model:     model,
		MaxTokens: 4096,
		Messages:  history,
		Tools:     tools,
	})
	req, err := http.NewRequest("POST", base+"/chat/completions", bytes.NewReader(body))
	if err != nil {
		return r, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+apiKey)

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return r, fmt.Errorf("请求失败: %w", err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		return r, fmt.Errorf("HTTP %d: %s", resp.StatusCode, raw)
	}
	if err := json.Unmarshal(raw, &r); err != nil {
		return r, fmt.Errorf("解析失败: %w\n原始响应: %s", err, raw)
	}
	if r.Error != nil {
		return r, fmt.Errorf("API 错误 [%s]: %s", r.Error.Type, r.Error.Message)
	}
	if len(r.Choices) == 0 {
		return r, fmt.Errorf("空响应: %s", raw)
	}
	return r, nil
}
