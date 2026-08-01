// Learn Agent the Hard Way — 练习 11：会话持久化
//
// 练习 3 说过："对话是幻觉，幻觉的维护者是你"——history 数组活在进程的内存里，
// 进程一退出，幻觉跟着消失。这一章把它写到磁盘上：一次一条，追加写，
// 进程可以死，对话不用死。
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
	"strings"
	"time"
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
		if path := pathOf(args); path != "" && fileExists(path) && !r.hasRead[path] {
			return "错误: " + path + " 已存在但这个会话里还没读过它。先用 read_file 看一眼，再来修改。"
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

// askApproval 停下来问人，不是问模型——危险命令要过这一关，
// 模型自己怎么想不算数。读不到回答（比如脚本化调用、没有终端）一律按拒绝处理，
// 安全边界宁可保守，不能因为读不到输入就放行。
func askApproval(cmd string) bool {
	fmt.Fprintf(os.Stderr, "\n⚠️  模型想执行: %s\n允许吗？(y/N) ", cmd)
	line, err := bufio.NewReader(os.Stdin).ReadString('\n')
	if err != nil {
		return false
	}
	answer := strings.ToLower(strings.TrimSpace(line))
	return answer == "y" || answer == "yes"
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
// 部分，不是每次都把整个文件重写一遍。这是这一章的核心账本：存盘的代价
// 只跟"这一轮新增了多少条"有关，跟"这场对话已经聊了多久"无关。
type session struct {
	ID        string
	CreatedAt time.Time
	History   []message
	persisted int
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

// save 只追加 History[persisted:]。没有新消息时是个空操作——
// 一轮里模型只回了一句话、没有工具调用，这一次 save 就什么都不写。
func (s *session) save() error {
	if len(s.History) == s.persisted {
		return nil
	}
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
		fmt.Fprintln(os.Stderr, `用法: ./ex11 "你的任务"  或  ./ex11 -c <session-id> "你的任务"`)
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
	reg := newRegistry(
		readFileTool{},
		writeFileTool{},
		editFileTool{},
		bashTool{},
	)

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
		s, err := newSessionFile([]message{{Role: "system", Content: basePrompt}})
		if err != nil {
			fmt.Fprintln(os.Stderr, "错误: 创建会话文件失败:", err)
			os.Exit(1)
		}
		sess = s
		fmt.Fprintf(os.Stderr, "[新建会话 %s]\n", sess.ID)
	}
	sess.History = append(sess.History, message{Role: "user", Content: task})

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
