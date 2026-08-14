package main

import (
	"context"
	"os/exec"
	"strings"
	"testing"
	"time"
)

func newTestBg() *bgManager {
	return &bgManager{procs: map[string]*bgProc{}, done: make(chan string, 8)}
}

// readNew 只给增量，缓冲被挤掉时带截断标记。
func TestReadNewIncrementalAndTruncation(t *testing.T) {
	p := &bgProc{}
	p.append([]byte("第一段\n"))
	out, _ := p.readNew()
	if out != "第一段\n" {
		t.Fatalf("第一次 readNew 应拿到全部输出，实际 %q", out)
	}
	if out, _ = p.readNew(); out != "" {
		t.Fatalf("没有新输出时 readNew 应为空，实际 %q", out)
	}
	// 截断标记只在"还没读过的输出被挤掉"时出现：新起一个进程，一口气
	// 塞爆缓冲再读——挤掉的是没人看过的字节，必须承认丢了东西。
	p2 := &bgProc{}
	p2.append([]byte("这一段没人读过就会被挤掉\n"))
	p2.append([]byte(strings.Repeat("x", maxBgOutputBytes)))
	out, _ = p2.readNew()
	if !strings.Contains(out, "挤出缓冲") {
		t.Fatal("未读输出被挤掉时应有截断标记")
	}
}

// tailLines 是快照：反复调用同一个视图，也不影响 readNew 的游标。
func TestTailIsSnapshot(t *testing.T) {
	p := &bgProc{}
	p.append([]byte("a\nb\nc\n"))
	one, _, _ := p.tailLines(2)
	two, _, _ := p.tailLines(2)
	if one != two {
		t.Fatalf("重复 tail 应看到同一视图：%q vs %q", one, two)
	}
	if out, _ := p.readNew(); !strings.Contains(out, "a\nb\nc") {
		t.Fatalf("tail 不应动 readNew 的游标，实际 %q", out)
	}
}

// 防轮询：30 秒窗口内第三次空快照触发硬停；有输出就清零；退出的进程不算。
func TestAntiPollingWindow(t *testing.T) {
	p := &bgProc{} // done=false 视为还在跑
	for i := 1; i <= 2; i++ {
		if _, _, blocked := p.tailLines(10); blocked {
			t.Fatalf("第 %d 次空查还不该硬停", i)
		}
	}
	if _, _, blocked := p.tailLines(10); !blocked {
		t.Fatal("窗口内第三次空查应硬停")
	}
	// 有输出之后计数清零。
	p.append([]byte("进展\n"))
	if _, _, blocked := p.tailLines(10); blocked {
		t.Fatal("有输出的快照不算轮询")
	}
	// 已退出的进程空快照不算轮询——它不会再有新输出，查一下无罪。
	p2 := &bgProc{}
	p2.finish(nil)
	for i := 0; i < 5; i++ {
		if _, _, blocked := p2.tailLines(10); blocked {
			t.Fatal("退出进程的空快照不应触发硬停")
		}
	}
}

// 真实进程：快退出的命令，完成通知必须带上它的全部输出（守望者要等
// 读者排干管道才发通知），async 秒完的还要带"不需要后台"的教育。
func TestStartAsyncNotifyKeepsOutputAndNudges(t *testing.T) {
	m := newTestBg()
	id, err := m.start("echo 干完了", bgAsync)
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	select {
	case note := <-m.done:
		if !strings.Contains(note, "干完了") {
			t.Fatalf("完成通知应带上进程输出，实际 %q", note)
		}
		if !strings.Contains(note, id) || !strings.Contains(note, "exited: 0") {
			t.Fatalf("完成通知应带 id 和退出状态，实际 %q", note)
		}
		if !strings.Contains(note, "不需要放后台") {
			t.Fatalf("秒完的 async 应被教育，实际 %q", note)
		}
		if !strings.Contains(note, "<system-reminder>") {
			t.Fatal("完成通知应包在 <system-reminder> 里")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("等完成通知超时")
	}
}

// interactive 全链路：起一个 cat，喂 stdin，tail 看到回显，killAll 收编。
func TestInteractiveStdinAndKillAll(t *testing.T) {
	m := newTestBg()
	id, err := m.start("cat", bgInteractive)
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	p := m.get(id)
	if p == nil {
		t.Fatal("get 找不到刚起的进程")
	}
	if _, err := p.stdin.Write([]byte("你好后台\n")); err != nil {
		t.Fatalf("写 stdin: %v", err)
	}
	// 等回显穿过管道进缓冲。
	deadline := time.Now().Add(3 * time.Second)
	for {
		out, _, _ := p.tailLines(0)
		if strings.Contains(out, "你好后台") {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("等不到 cat 的回显，缓冲=%q", out)
		}
		time.Sleep(20 * time.Millisecond)
	}
	m.killAll()
	select {
	case <-m.done: // cat 被杀，守望者发出通知
	case <-time.After(5 * time.Second):
		t.Fatal("killAll 之后等不到退出通知")
	}
}

// 子 agent 的 ctx 抹掉宿主之后，后台分支拿不到 manager。
func TestBgFromNilGate(t *testing.T) {
	ctx := withBg(context.Background(), theBg)
	if bgFrom(ctx) == nil {
		t.Fatal("主循环的 ctx 应带宿主")
	}
	ctx = withBg(ctx, nil)
	if bgFrom(ctx) != nil {
		t.Fatal("抹掉之后 bgFrom 应为 nil")
	}
}

// killAll 杀的是整个进程组：sh -c 包装 fork 出来的孙进程（这里的 sleep）
// 也要一起死，不能只杀最外层的 sh。
func TestKillAllKillsProcessGroup(t *testing.T) {
	m := newTestBg()
	// && 让 sh 不做单命令 exec 优化，sleep 保持为 sh 的子进程。
	if _, err := m.start("sleep 3777 && echo 永远到不了", bgInteractive); err != nil {
		t.Fatalf("start: %v", err)
	}
	time.Sleep(200 * time.Millisecond) // 等 sh fork 出 sleep
	m.killAll()
	select {
	case <-m.done:
	case <-time.After(5 * time.Second):
		t.Fatal("killAll 之后等不到退出通知")
	}
	time.Sleep(100 * time.Millisecond)
	out, _ := exec.Command("pgrep", "-f", "sleep 3777").Output()
	if s := strings.TrimSpace(string(out)); s != "" {
		exec.Command("pkill", "-f", "sleep 3777").Run()
		t.Fatalf("孙进程活过了 killAll（pid %s）——只杀到了 sh 包装层", s)
	}
}
