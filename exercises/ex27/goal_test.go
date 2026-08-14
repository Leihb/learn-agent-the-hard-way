package main

import (
	"strings"
	"sync"
	"testing"
)

// 已有 goal 时 create 必须失败——包括已经完成的 goal，防模型静默覆盖。
func TestCreateFailsWhenGoalExists(t *testing.T) {
	b := &goalBox{}
	if _, err := b.create("目标一", 0); err != nil {
		t.Fatalf("第一次 create 不该失败: %v", err)
	}
	if _, err := b.create("目标二", 0); err == nil {
		t.Fatal("已有 goal 时 create 应该失败")
	}
	if _, err := b.setStatus(goalComplete); err != nil {
		t.Fatalf("setStatus(complete) 不该失败: %v", err)
	}
	if _, err := b.create("目标三", 0); err == nil {
		t.Fatal("goal 已完成仍存在，create 应该失败")
	}
}

// 交过卷的 goal 不能 resume 回 active。
func TestCompleteCannotResume(t *testing.T) {
	b := &goalBox{}
	b.create("目标", 0)
	b.setStatus(goalComplete)
	if _, err := b.setStatus(goalActive); err == nil {
		t.Fatal("complete 的 goal 不该能 resume")
	}
}

// 越线只发生一次：跨线那一刻状态变 budget_limited、暂存一条收尾提示；
// 之后继续记账（在飞的活还在烧钱），但不再有第二条提示。
func TestBudgetCrossingStagesSteersOnce(t *testing.T) {
	b := &goalBox{}
	b.create("目标", 100)
	b.turnStart() // 作废建 goal 的跳账保护，测试里直接记账
	b.account(150)
	g, _ := b.snapshot()
	if g.Status != goalBudgetLimited {
		t.Fatalf("越线后状态应为 budget_limited，实际 %s", g.Status)
	}
	steer, ok := b.consumeBudgetSteer()
	if !ok || !strings.Contains(steer, "150") {
		t.Fatalf("越线应暂存一条带用量的收尾提示，实际 ok=%v steer=%q", ok, steer)
	}
	b.account(30)
	g, _ = b.snapshot()
	if g.TokensUsed != 180 {
		t.Fatalf("budget_limited 的 goal 仍要记账，期望 180，实际 %d", g.TokensUsed)
	}
	if _, ok := b.consumeBudgetSteer(); ok {
		t.Fatal("收尾提示是一次性的，不该有第二条")
	}
}

// resume 一个越了线的 goal 只能落在 budget_limited 上，回不了 active。
func TestResumeOverBudgetLandsBudgetLimited(t *testing.T) {
	b := &goalBox{}
	b.create("目标", 100)
	b.turnStart()
	b.account(150)
	b.setStatus(goalPaused)
	g, err := b.setStatus(goalActive)
	if err != nil {
		t.Fatalf("resume 不该报错: %v", err)
	}
	if g.Status != goalBudgetLimited {
		t.Fatalf("resume 越线 goal 应落在 budget_limited，实际 %s", g.Status)
	}
}

// 零进度刹车：续了一轮 token 没动就停；真实进展或 goal 变更把刹车松开。
func TestZeroProgressBrake(t *testing.T) {
	b := &goalBox{}
	b.create("目标", 0)
	b.turnStart()
	b.account(50)
	if _, ok := b.continuation(); !ok {
		t.Fatal("活跃 goal 第一次问续 turn 应该放行")
	}
	// 这一轮没记任何账，再问就该被刹住。
	if _, ok := b.continuation(); ok {
		t.Fatal("零进度的续 turn 应该被刹住")
	}
	if _, ok := b.continuation(); ok {
		t.Fatal("刹车踩下后应保持刹住")
	}
	// 真实进展松开刹车。
	b.account(10)
	if _, ok := b.continuation(); !ok {
		t.Fatal("记了账之后刹车应松开")
	}
	// 任何 goal 变更也松开刹车：pause 再 resume。
	b.continuation() // 再空转一轮踩下刹车
	b.setStatus(goalPaused)
	b.setStatus(goalActive)
	if _, ok := b.continuation(); !ok {
		t.Fatal("状态变更后刹车应松开")
	}
}

// 打断/报错的 suppress 直接踩死刹车，零进度审计接不住这两种。
func TestSuppressParksContinuation(t *testing.T) {
	b := &goalBox{}
	b.create("目标", 0)
	b.turnStart()
	b.account(50)
	b.suppress()
	if _, ok := b.continuation(); ok {
		t.Fatal("suppress 之后不该放行续 turn")
	}
	b.account(10) // 后续用户轮次里的真实进展重新武装
	if _, ok := b.continuation(); !ok {
		t.Fatal("真实进展应重新放行续 turn")
	}
}

// 立 goal 那一轮的下一笔账不记（防整个上下文算到新 goal 头上），
// 且这个保护只活到轮次边界：turnStart 作废它。
func TestSkipNextDelta(t *testing.T) {
	b := &goalBox{}
	b.create("目标", 0)
	b.account(1000) // 同一轮的下一笔：整个上下文，跳过
	g, _ := b.snapshot()
	if g.TokensUsed != 0 {
		t.Fatalf("建 goal 后的第一笔账应跳过，实际记了 %d", g.TokensUsed)
	}
	b.account(80) // 再下一笔照常记
	if g, _ = b.snapshot(); g.TokensUsed != 80 {
		t.Fatalf("跳账只跳一笔，期望 80，实际 %d", g.TokensUsed)
	}

	b2 := &goalBox{}
	b2.create("目标", 0)
	b2.turnStart() // 轮次边界：没被消费的跳账标记作废
	b2.account(1000)
	if g, _ := b2.snapshot(); g.TokensUsed != 1000 {
		t.Fatalf("轮次边界后第一笔应照常记，期望 1000，实际 %d", g.TokensUsed)
	}
}

// 工具在轮次 goroutine 里、命令在主循环里并发碰同一个 goalBox，-race 兜底。
func TestConcurrentAccess(t *testing.T) {
	b := &goalBox{}
	b.create("目标", 10000)
	b.turnStart()
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 100; j++ {
				b.account(1)
				b.snapshot()
				b.continuation()
			}
		}()
	}
	wg.Wait()
	if g, _ := b.snapshot(); g.TokensUsed != 800 {
		t.Fatalf("并发记账丢账了，期望 800，实际 %d", g.TokensUsed)
	}
}
