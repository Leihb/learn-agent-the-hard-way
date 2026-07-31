// Learn Agent the Hard Way — 练习 4：provider 抽象
//
// 同一份 REPL，接两种协议。差别全部关进两个适配器里，
// 循环本身一个字不改——这就是抽象层的全部价值。
package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
)

// message 是我们自己的中立形状——不属于任何一家协议。
type message struct {
	Role    string
	Content string
}

// provider 是本书第一个接口：给我系统提示词和历史，还我一句回复。
// 两种协议的全部差异，都消失在这个签名后面。
type provider interface {
	send(system string, history []message) (reply string, err error)
}

// ---- OpenAI 协议适配器（练习 1 的代码装进盒子）----

type openaiProvider struct {
	base, key, model string
}

func (p openaiProvider) send(system string, history []message) (string, error) {
	// OpenAI 协议里 system 是 messages 数组的第 0 条——塞回去。
	type apiMsg struct {
		Role    string `json:"role"`
		Content string `json:"content"`
	}
	msgs := []apiMsg{{Role: "system", Content: system}}
	for _, m := range history {
		msgs = append(msgs, apiMsg{Role: m.Role, Content: m.Content})
	}
	body, _ := json.Marshal(map[string]any{
		"model":      p.model,
		"max_tokens": 1024, // 可以不传，各家有默认值
		"messages":   msgs,
	})

	req, err := http.NewRequest("POST", p.base+"/chat/completions", bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+p.key) // 认证：标准 Bearer

	raw, err := do(req)
	if err != nil {
		return "", err
	}

	var r struct {
		Choices []struct {
			Message      struct{ Content string }
			FinishReason string `json:"finish_reason"`
		}
		Usage struct {
			PromptTokens     int `json:"prompt_tokens"`
			CompletionTokens int `json:"completion_tokens"`
		}
	}
	if err := json.Unmarshal(raw, &r); err != nil {
		return "", fmt.Errorf("解析失败: %w", err)
	}
	if len(r.Choices) == 0 {
		return "", fmt.Errorf("空响应: %s", raw)
	}
	fmt.Fprintf(os.Stderr, "[输入 %d tokens · 输出 %d tokens · finish_reason=%s]\n",
		r.Usage.PromptTokens, r.Usage.CompletionTokens, r.Choices[0].FinishReason)
	return r.Choices[0].Message.Content, nil
}

// ---- Anthropic 协议适配器（对照组）----

type anthropicProvider struct {
	base, key, model string
}

func (p anthropicProvider) send(system string, history []message) (string, error) {
	type apiMsg struct {
		Role    string `json:"role"`
		Content string `json:"content"`
	}
	msgs := make([]apiMsg, 0, len(history))
	for _, m := range history {
		msgs = append(msgs, apiMsg{Role: m.Role, Content: m.Content})
	}
	body, _ := json.Marshal(map[string]any{
		"model":      p.model,
		"max_tokens": 1024,   // 这家必填，不传直接 400
		"system":     system, // system 不进 messages，是顶层字段
		"messages":   msgs,
	})

	req, err := http.NewRequest("POST", p.base+"/v1/messages", bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-api-key", p.key)                // 认证：自家头，没有 Bearer
	req.Header.Set("anthropic-version", "2023-06-01") // 版本头，必带

	raw, err := do(req)
	if err != nil {
		return "", err
	}

	var r struct {
		Content []struct {
			Type string `json:"type"` // "text" | "thinking" | "tool_use"…
			Text string `json:"text"`
		}
		StopReason string `json:"stop_reason"`
		Usage      struct {
			InputTokens  int `json:"input_tokens"`
			OutputTokens int `json:"output_tokens"`
		}
	}
	if err := json.Unmarshal(raw, &r); err != nil {
		return "", fmt.Errorf("解析失败: %w", err)
	}
	// 回复不是一个字符串，是一个块数组——文字只是其中一种块。
	var reply strings.Builder
	for _, b := range r.Content {
		if b.Type == "text" {
			reply.WriteString(b.Text)
		}
	}
	fmt.Fprintf(os.Stderr, "[输入 %d tokens · 输出 %d tokens · stop_reason=%s]\n",
		r.Usage.InputTokens, r.Usage.OutputTokens, r.StopReason)
	return reply.String(), nil
}

// do 发出请求，非 200 时把响应体当错误返回。两个适配器共用。
func do(req *http.Request) ([]byte, error) {
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("HTTP %d: %s", resp.StatusCode, raw)
	}
	return raw, nil
}

// ---- 同一个 REPL，练习 3 原样搬来（只是退回非流式）----

func main() {
	var p provider
	switch proto := os.Getenv("PROTOCOL"); proto {
	case "", "openai":
		base := os.Getenv("OPENAI_BASE_URL")
		if base == "" {
			base = "https://api.openai.com/v1"
		}
		p = openaiProvider{base: base, key: os.Getenv("OPENAI_API_KEY"), model: os.Getenv("MODEL")}
	case "anthropic":
		base := os.Getenv("ANTHROPIC_BASE_URL")
		if base == "" {
			base = "https://api.anthropic.com"
		}
		p = anthropicProvider{base: base, key: os.Getenv("ANTHROPIC_API_KEY"), model: os.Getenv("MODEL")}
	default:
		fmt.Fprintf(os.Stderr, "未知 PROTOCOL %q（要 openai 或 anthropic）\n", proto)
		os.Exit(1)
	}

	const system = "你是一个说话简洁的助手，回答不超过三句话。"
	var history []message

	fmt.Println(`输入你的话，回车发送；输入 exit 退出。`)
	stdin := bufio.NewScanner(os.Stdin)
	fmt.Print("> ")
	for stdin.Scan() {
		input := strings.TrimSpace(stdin.Text())
		if input == "" {
			fmt.Print("> ")
			continue
		}
		if input == "exit" {
			break
		}

		history = append(history, message{Role: "user", Content: input})
		reply, err := p.send(system, history)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			history = history[:len(history)-1] // 失败弹回，练习 3 的纪律
			fmt.Print("> ")
			continue
		}
		fmt.Println(reply)
		history = append(history, message{Role: "assistant", Content: reply})
		fmt.Print("> ")
	}
}
