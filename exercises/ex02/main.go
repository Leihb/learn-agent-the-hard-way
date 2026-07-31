// Learn Agent the Hard Way — 练习 2：流式输出
//
// 和练习 1 同一个请求，多一个字段：stream。
// 响应从一份 JSON 变成一条流——你的 harness 从此有了"边生成边看"的感官。
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

// request 比练习 1 多了 Stream 和 StreamOptions 两个字段。
type request struct {
	Model         string         `json:"model"`
	Messages      []message      `json:"messages"`
	MaxTokens     int            `json:"max_tokens,omitempty"`
	Stream        bool           `json:"stream"`
	StreamOptions *streamOptions `json:"stream_options,omitempty"`
}

// streamOptions.IncludeUsage 让服务端在流的最后补一个带 usage 的块。
// 不带这个选项，OpenAI 和多数兼容服务商在流式下不报 token 数——账单直接消失。
type streamOptions struct {
	IncludeUsage bool `json:"include_usage"`
}

type message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

// chunk 是流里每条 data: 行的形状。对照练习 1 的 response：
// message 变成了 delta——同一个位置，从"完整的话"变成"新吐出的几个字"。
// 其余字段都还在原地。
type chunk struct {
	Choices []struct {
		Delta struct {
			Content string `json:"content"`
		} `json:"delta"`
		FinishReason string `json:"finish_reason"` // 只在最后一个内容块上非空
	} `json:"choices"`
	Usage *struct { // 只在 include_usage 补发的终块上非空
		PromptTokens     int `json:"prompt_tokens"`
		CompletionTokens int `json:"completion_tokens"`
	} `json:"usage"`
	Error *struct { // 200 之后服务端也可能在流里报错——形状和练习 1 相同
		Message string `json:"message"`
		Type    string `json:"type"`
	} `json:"error"`
}

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, `用法: ./ex02 "你的问题"`)
		os.Exit(1)
	}
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

	body, _ := json.Marshal(request{
		Model:         model,
		MaxTokens:     1024,
		Messages:      []message{{Role: "user", Content: os.Args[1]}},
		Stream:        true,
		StreamOptions: &streamOptions{IncludeUsage: true},
	})

	req, err := http.NewRequest("POST", base+"/chat/completions", bytes.NewReader(body))
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+apiKey)
	req.Header.Set("Accept", "text/event-stream") // 声明：我要的是事件流

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		fmt.Fprintln(os.Stderr, "请求失败:", err)
		os.Exit(1)
	}
	defer resp.Body.Close()

	// 流式请求失败在"开流之前"：非 200 时响应体是普通 JSON，不是流。
	if resp.StatusCode != 200 {
		raw, _ := io.ReadAll(resp.Body)
		fmt.Fprintf(os.Stderr, "HTTP %d: %s\n", resp.StatusCode, raw)
		os.Exit(1)
	}

	var (
		finish        string
		inTok, outTok int
	)
	scanner := bufio.NewScanner(resp.Body)
	for scanner.Scan() {
		line := scanner.Text()
		// SSE 的全部语法就这一条：以 "data:" 开头的行，后面跟一份 JSON。
		// 冒号后那个空格按规范是可选的——OpenAI 和 DeepSeek 会发，
		// 有的兼容服务商不发，所以两段都要剥。
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		data := strings.TrimPrefix(strings.TrimPrefix(line, "data:"), " ")
		if data == "" {
			continue
		}
		if data == "[DONE]" { // 终止哨兵：流到头了
			break
		}

		var c chunk
		if err := json.Unmarshal([]byte(data), &c); err != nil {
			fmt.Fprintf(os.Stderr, "\n解析失败: %v\n原始行: %s\n", err, data)
			os.Exit(1)
		}
		if c.Error != nil {
			fmt.Fprintf(os.Stderr, "\nAPI 错误 [%s]: %s\n", c.Error.Type, c.Error.Message)
			os.Exit(1)
		}
		if c.Usage != nil {
			inTok, outTok = c.Usage.PromptTokens, c.Usage.CompletionTokens
		}
		if len(c.Choices) == 0 { // include_usage 的终块没有 choices
			continue
		}
		if c.Choices[0].Delta.Content != "" {
			fmt.Print(c.Choices[0].Delta.Content) // 到手就打，不攒
		}
		if c.Choices[0].FinishReason != "" {
			finish = c.Choices[0].FinishReason
		}
	}
	if err := scanner.Err(); err != nil {
		fmt.Fprintln(os.Stderr, "\n读流失败:", err)
		os.Exit(1)
	}

	fmt.Println()
	fmt.Fprintf(os.Stderr, "\n[输入 %d tokens · 输出 %d tokens · finish_reason=%s]\n",
		inTok, outTok, finish)
}
