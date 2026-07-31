// Learn Harness the Hard Way — 练习 1：一次 API 调用
//
// 你的 agent 的一切，都从这一个 HTTP 请求开始。
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
)

// request 是 POST /chat/completions 请求体的最小形状。
// 完整协议还有很多字段（tools、stream、reasoning_effort……），后面的练习会逐个长出来。
type request struct {
	Model     string    `json:"model"`
	Messages  []message `json:"messages"`
	MaxTokens int       `json:"max_tokens,omitempty"`
}

// message 是对话里的一条消息。
// 到练习 5，assistant 的消息里会多出 tool_calls 字段——那是模型伸手干活的地方。
type message struct {
	Role    string `json:"role"` // "system" / "user" / "assistant"
	Content string `json:"content"`
}

// response 只解析我们需要的字段——JSON 里多余的字段会被忽略，这是协议演进的余地。
type response struct {
	Choices []struct {
		Message      message `json:"message"`
		FinishReason string  `json:"finish_reason"` // "stop" | "length" | "tool_calls" …
	} `json:"choices"`
	Usage struct {
		PromptTokens     int `json:"prompt_tokens"`
		CompletionTokens int `json:"completion_tokens"`
	} `json:"usage"`
	Error *struct {
		Message string `json:"message"`
		Type    string `json:"type"`
	} `json:"error"` // 出错时 API 返回的是这个形状，成功时它是 null
}

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, `用法: ./ex01 "你的问题"`)
		os.Exit(1)
	}
	apiKey := os.Getenv("OPENAI_API_KEY")
	model := os.Getenv("MODEL")
	if apiKey == "" || model == "" {
		fmt.Fprintln(os.Stderr, "需要环境变量 OPENAI_API_KEY 和 MODEL")
		fmt.Fprintln(os.Stderr, `例: export OPENAI_BASE_URL=https://api.deepseek.com/v1`)
		fmt.Fprintln(os.Stderr, `    export MODEL=deepseek-chat`)
		os.Exit(1)
	}
	base := os.Getenv("OPENAI_BASE_URL")
	if base == "" {
		base = "https://api.openai.com/v1"
	}

	body, _ := json.Marshal(request{
		Model:     model,
		MaxTokens: 1024,
		Messages:  []message{{Role: "user", Content: os.Args[1]}},
	})

	req, err := http.NewRequest("POST", base+"/chat/completions", bytes.NewReader(body))
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	// 两个头，一个都不能少：
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+apiKey) // 认证

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		fmt.Fprintln(os.Stderr, "请求失败:", err)
		os.Exit(1)
	}
	defer resp.Body.Close()

	raw, _ := io.ReadAll(resp.Body)
	var r response
	if err := json.Unmarshal(raw, &r); err != nil {
		fmt.Fprintf(os.Stderr, "解析失败: %v\n原始响应: %s\n", err, raw)
		os.Exit(1)
	}
	if r.Error != nil {
		fmt.Fprintf(os.Stderr, "API 错误 [%s]: %s\n", r.Error.Type, r.Error.Message)
		os.Exit(1)
	}
	if len(r.Choices) == 0 {
		fmt.Fprintf(os.Stderr, "空响应: %s\n", raw)
		os.Exit(1)
	}

	fmt.Println(r.Choices[0].Message.Content)
	fmt.Fprintf(os.Stderr, "\n[输入 %d tokens · 输出 %d tokens · finish_reason=%s]\n",
		r.Usage.PromptTokens, r.Usage.CompletionTokens, r.Choices[0].FinishReason)
}
