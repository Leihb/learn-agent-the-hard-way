// Learn Agent the Hard Way — 练习 3：多轮对话
//
// API 没有"会话"。所谓对话，是你维护的一个数组 + 一个 for 循环。
// 这一章练习 1 埋的伏笔全部收回。
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

type request struct {
	Model         string         `json:"model"`
	Messages      []message      `json:"messages"`
	MaxTokens     int            `json:"max_tokens,omitempty"`
	Stream        bool           `json:"stream"`
	StreamOptions *streamOptions `json:"stream_options,omitempty"`
}

type streamOptions struct {
	IncludeUsage bool `json:"include_usage"`
}

type message struct {
	Role    string `json:"role"` // 今天集齐三种："system" / "user" / "assistant"
	Content string `json:"content"`
}

type chunk struct {
	Choices []struct {
		Delta struct {
			Content string `json:"content"`
		} `json:"delta"`
		FinishReason string `json:"finish_reason"`
	} `json:"choices"`
	Usage *struct {
		PromptTokens     int `json:"prompt_tokens"`
		CompletionTokens int `json:"completion_tokens"`
	} `json:"usage"`
	Error *struct {
		Message string `json:"message"`
		Type    string `json:"type"`
	} `json:"error"`
}

func main() {
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

	// 对话的全部状态就是这个数组。system 消息坐第 0 位，开场写一次，
	// 整场不动——它是给模型的"人设"，每一轮都会跟着历史重新发出去。
	history := []message{
		{Role: "system", Content: "你是一个说话简洁的助手，回答不超过三句话。"},
	}

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

		// 先把用户的话放进历史，再发送——发出去的快照必须包含它。
		history = append(history, message{Role: "user", Content: input})

		reply, ok := send(base, apiKey, model, history)
		if !ok {
			// 发送失败：把刚才 append 的那条弹回来。
			// 不弹的话，用户重试一次，历史里就有两条一样的话。
			history = history[:len(history)-1]
			fmt.Print("> ")
			continue
		}

		// 回复原样塞回历史——练习 1 说过：它和你发出去的消息是同一个形状。
		// 下一轮模型能"记得"自己说过什么，全靠这一行。
		history = append(history, message{Role: "assistant", Content: reply})
		fmt.Print("> ")
	}
}

// send 把整个 history 发出去，流式打印回复，返回攒好的完整文本。
// 打印是给人看的，攒是给下一轮用的——同一份字节，两个去处。
func send(base, apiKey, model string, history []message) (string, bool) {
	body, _ := json.Marshal(request{
		Model:         model,
		MaxTokens:     1024,
		Messages:      history,
		Stream:        true,
		StreamOptions: &streamOptions{IncludeUsage: true},
	})

	req, err := http.NewRequest("POST", base+"/chat/completions", bytes.NewReader(body))
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return "", false
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+apiKey)
	req.Header.Set("Accept", "text/event-stream")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		fmt.Fprintln(os.Stderr, "请求失败:", err)
		return "", false
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		raw, _ := io.ReadAll(resp.Body)
		fmt.Fprintf(os.Stderr, "HTTP %d: %s\n", resp.StatusCode, raw)
		return "", false
	}

	var (
		full          strings.Builder // 攒完整回复，退出前塞回 history
		finish        string
		inTok, outTok int
	)
	scanner := bufio.NewScanner(resp.Body)
	for scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		data := strings.TrimPrefix(strings.TrimPrefix(line, "data:"), " ")
		if data == "" {
			continue
		}
		if data == "[DONE]" {
			break
		}

		var c chunk
		if err := json.Unmarshal([]byte(data), &c); err != nil {
			fmt.Fprintf(os.Stderr, "\n解析失败: %v\n原始行: %s\n", err, data)
			return "", false
		}
		if c.Error != nil {
			fmt.Fprintf(os.Stderr, "\nAPI 错误 [%s]: %s\n", c.Error.Type, c.Error.Message)
			return "", false
		}
		if c.Usage != nil {
			inTok, outTok = c.Usage.PromptTokens, c.Usage.CompletionTokens
		}
		if len(c.Choices) == 0 {
			continue
		}
		if d := c.Choices[0].Delta.Content; d != "" {
			fmt.Print(d)
			full.WriteString(d)
		}
		if c.Choices[0].FinishReason != "" {
			finish = c.Choices[0].FinishReason
		}
	}
	if err := scanner.Err(); err != nil {
		fmt.Fprintln(os.Stderr, "\n读流失败:", err)
		return "", false
	}

	fmt.Printf("\n")
	fmt.Fprintf(os.Stderr, "[输入 %d tokens · 输出 %d tokens · finish_reason=%s]\n",
		inTok, outTok, finish)
	return full.String(), true
}
