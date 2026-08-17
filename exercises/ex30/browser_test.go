package main

// 练习 30 的单元测试：不碰真 Chrome，用 httptest 起一个假的 CDP
// websocket 服务器，验证客户端这一侧的三件事——响应按 id 找回调用方、
// 协议错误变成 Go 错误、没有 id 的事件帧被安静丢掉。真 Chrome 的行为
// 靠正文的真机实验，这里守的是自己代码的回归。

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// fakeCDP 起一个假 CDP 服务器并返回连上它的客户端。handle 对每个收到的
// 命令决定怎么回，send 是并发安全的回写。
func fakeCDP(t *testing.T, handle func(msg cdpMessage, send func(cdpMessage))) *cdpClient {
	t.Helper()
	up := websocket.Upgrader{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := up.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		var wmu sync.Mutex
		send := func(m cdpMessage) {
			wmu.Lock()
			defer wmu.Unlock()
			_ = conn.WriteJSON(m)
		}
		for {
			var m cdpMessage
			if conn.ReadJSON(&m) != nil {
				return
			}
			go handle(m, send)
		}
	}))
	t.Cleanup(srv.Close)
	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(srv.URL, "http"), nil)
	if err != nil {
		t.Fatalf("拨号假服务器: %v", err)
	}
	cli := newCDPClient(conn)
	t.Cleanup(func() { cli.shutdown(errors.New("测试结束")) })
	return cli
}

// 两个并发调用，服务器故意让先到的那个后回——每个调用方必须拿到自己
// 那份结果，不能串。这是 pending map 按 id 路由的全部意义。
func TestCDPCallRoutesByID(t *testing.T) {
	cli := fakeCDP(t, func(m cdpMessage, send func(cdpMessage)) {
		if m.Method == "slow" {
			time.Sleep(50 * time.Millisecond)
		}
		send(cdpMessage{ID: m.ID, Result: fmt.Appendf(nil, "{\"echo\":%q}", m.Method)})
	})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var wg sync.WaitGroup
	for _, method := range []string{"slow", "fast"} {
		wg.Add(1)
		go func() {
			defer wg.Done()
			res, err := cli.call(ctx, "", method, nil)
			if err != nil {
				t.Errorf("%s: %v", method, err)
				return
			}
			if want := fmt.Sprintf("{\"echo\":%q}", method); string(res) != want {
				t.Errorf("%s 拿到了别人的结果: %s", method, res)
			}
		}()
	}
	wg.Wait()
}

// 协议层错误要变成 Go 错误，带上方法名和 Chrome 给的消息。
func TestCDPErrorSurfaces(t *testing.T) {
	cli := fakeCDP(t, func(m cdpMessage, send func(cdpMessage)) {
		send(cdpMessage{ID: m.ID, Error: &cdpError{Code: -32000, Message: "No target with given id"}})
	})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, err := cli.call(ctx, "", "Target.attachToTarget", nil)
	if err == nil || !strings.Contains(err.Error(), "No target with given id") {
		t.Fatalf("想要带原始消息的错误，拿到: %v", err)
	}
}

// 事件帧（没有 id）夹在响应前面，调用照样正常拿到结果——readLoop 对
// 不认识的帧的态度是丢弃，不是崩溃也不是阻塞。
func TestCDPEventFramesIgnored(t *testing.T) {
	cli := fakeCDP(t, func(m cdpMessage, send func(cdpMessage)) {
		send(cdpMessage{Method: "Page.loadEventFired", Params: map[string]any{"timestamp": 1}})
		send(cdpMessage{Method: "Target.targetCreated"})
		send(cdpMessage{ID: m.ID, Result: []byte(`{"ok":true}`)})
	})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	res, err := cli.call(ctx, "sess-1", "Page.enable", nil)
	if err != nil {
		t.Fatal(err)
	}
	if string(res) != `{"ok":true}` {
		t.Fatalf("结果不对: %s", res)
	}
}

// 连接断掉时，等在半路的调用要立刻收到错误，不能永远挂着。
func TestCDPShutdownWakesWaiters(t *testing.T) {
	cli := fakeCDP(t, func(m cdpMessage, send func(cdpMessage)) {
		// 永不回复
	})
	done := make(chan error, 1)
	go func() {
		_, err := cli.call(context.Background(), "", "Page.navigate", nil)
		done <- err
	}()
	time.Sleep(50 * time.Millisecond)
	cli.shutdown(errors.New("Chrome 关了"))
	select {
	case err := <-done:
		if err == nil || !strings.Contains(err.Error(), "cdp 连接已断") {
			t.Fatalf("想要连接已断的错误，拿到: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("shutdown 没有叫醒等待中的调用")
	}
}

// /json/version 这条路：HTTP 端点答了就用它给的地址。
func TestCDPEndpointFromJSONVersion(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/json/version" {
			fmt.Fprint(w, `{"webSocketDebuggerUrl":"ws://127.0.0.1:19222/devtools/browser/abc"}`)
			return
		}
		http.NotFound(w, r)
	}))
	defer srv.Close()
	var port int
	fmt.Sscanf(srv.URL[strings.LastIndex(srv.URL, ":")+1:], "%d", &port)
	got, err := cdpEndpoint(context.Background(), port)
	if err != nil {
		t.Fatal(err)
	}
	if got != "ws://127.0.0.1:19222/devtools/browser/abc" {
		t.Fatalf("地址不对: %s", got)
	}
}

// headOf 截前面、对齐整行、报告截掉多少——和 tail 正好一对。
func TestHeadOf(t *testing.T) {
	if got := headOf("短的", 100); got != "短的" {
		t.Fatalf("不超限不该动: %q", got)
	}
	long := strings.Repeat("一行内容\n", 100)
	got := headOf(long, 50)
	if !strings.Contains(got, "被截断") {
		t.Fatalf("超限要说明截断: %q", got)
	}
	if strings.Contains(strings.SplitN(got, "\n[", 2)[0], "内") && !strings.HasSuffix(strings.SplitN(got, "\n[", 2)[0], "内容") {
		t.Fatalf("没对齐到整行: %q", got)
	}
}
