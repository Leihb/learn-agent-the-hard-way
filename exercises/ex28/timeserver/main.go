// timeserver 是一个最小的 MCP 服务器，给练习 22 的客户端当陪练：
// initialize / tools/list / tools/call 三个方法，两个工具。真实项目里
// 服务器一般用官方 SDK 写，这里手写协议是为了让你看清线上到底流过什么
// ——它和客户端说的是同一种话，一行一个 JSON 对象。
//
// 两个工具都是模型自己算不准的事：它不知道现在几点（训练数据有截止日），
// 也算不稳两个日期隔几天（大数和日历运算是语言模型的短板）。
package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"time"
)

// message 和客户端侧是同一个形状——JSON-RPC 的帧不分客户端服务器。
type message struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      int             `json:"id,omitempty"`
	Method  string          `json:"method,omitempty"`
	Params  json.RawMessage `json:"params,omitempty"`
	Result  any             `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func main() {
	dec := json.NewDecoder(bufio.NewReader(os.Stdin))
	enc := json.NewEncoder(os.Stdout) // Encode 自带换行，正好一行一帧
	reply := func(id int, result any) {
		_ = enc.Encode(message{JSONRPC: "2.0", ID: id, Result: result})
	}
	replyErr := func(id, code int, msg string) {
		_ = enc.Encode(message{JSONRPC: "2.0", ID: id, Error: &rpcError{Code: code, Message: msg}})
	}

	for {
		var m message
		if err := dec.Decode(&m); err != nil {
			return // 标准输入关了（客户端退出），我们也退出
		}
		switch m.Method {
		case "initialize":
			reply(m.ID, map[string]any{
				"protocolVersion": "2024-11-05",
				"capabilities":    map[string]any{"tools": map[string]any{}},
				"serverInfo":      map[string]any{"name": "timeserver", "version": "0.1"},
			})
		case "notifications/initialized":
			// 通知没有 ID，不需要回复
		case "tools/list":
			reply(m.ID, map[string]any{"tools": []map[string]any{
				{
					"name":        "current_time",
					"description": "返回服务器本地的当前日期、时间和星期几。",
					"inputSchema": map[string]any{"type": "object", "properties": map[string]any{}},
				},
				{
					"name":        "days_between",
					"description": "计算两个日期之间隔多少天（格式 2026-01-02，结束早于开始时为负数）。",
					"inputSchema": map[string]any{
						"type": "object",
						"properties": map[string]any{
							"start": map[string]any{"type": "string", "description": "开始日期，YYYY-MM-DD"},
							"end":   map[string]any{"type": "string", "description": "结束日期，YYYY-MM-DD"},
						},
						"required": []string{"start", "end"},
					},
				},
			}})
		case "tools/call":
			var p struct {
				Name      string            `json:"name"`
				Arguments map[string]string `json:"arguments"`
			}
			if err := json.Unmarshal(m.Params, &p); err != nil {
				replyErr(m.ID, -32602, "参数不是合法 JSON: "+err.Error())
				continue
			}
			text, err := runTool(p.Name, p.Arguments)
			if err != nil {
				// 工具收到了调用但干活失败：isError 是结果的一部分，
				// 不是协议错误——客户端那侧对这两种要分开处理。
				reply(m.ID, map[string]any{
					"content": []map[string]any{{"type": "text", "text": err.Error()}},
					"isError": true,
				})
				continue
			}
			reply(m.ID, map[string]any{
				"content": []map[string]any{{"type": "text", "text": text}},
			})
		default:
			if m.ID != 0 {
				replyErr(m.ID, -32601, "没有这个方法: "+m.Method)
			}
		}
	}
}

var weekdays = [...]string{"星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"}

func runTool(name string, args map[string]string) (string, error) {
	switch name {
	case "current_time":
		now := time.Now()
		return fmt.Sprintf("%s %s", now.Format("2006-01-02 15:04:05"), weekdays[now.Weekday()]), nil
	case "days_between":
		start, err := time.Parse("2006-01-02", args["start"])
		if err != nil {
			return "", fmt.Errorf("start 不是合法日期（要 YYYY-MM-DD）: %v", err)
		}
		end, err := time.Parse("2006-01-02", args["end"])
		if err != nil {
			return "", fmt.Errorf("end 不是合法日期（要 YYYY-MM-DD）: %v", err)
		}
		days := int(end.Sub(start).Hours() / 24)
		return fmt.Sprintf("%d 天", days), nil
	default:
		return "", fmt.Errorf("没有这个工具: %s", name)
	}
}
