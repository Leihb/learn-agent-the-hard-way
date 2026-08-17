//go:build manual

package main

// 手动冒烟：需要一个开着调试端口的 Chrome（CDP_PORT 指定）。
// go test -tags manual -run TestManualSmoke -v

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"
)

func TestManualSmoke(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	pg, err := browserPage(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer closeBrowserTab()

	if err := pg.navigate(ctx, "https://leihb.github.io/learn-agent-the-hard-way/"); err != nil {
		t.Fatal("navigate:", err)
	}
	out, err := pg.observe(ctx)
	if err != nil {
		t.Fatal("observe:", err)
	}
	if !strings.Contains(out, "练习 5") {
		t.Fatal("observe 里没有侧边栏链接")
	}

	// 窄视口下侧栏被折叠：点链接应该收到 hittable 报错，而不是无声无息
	err = pg.click(ctx, `nav > div:nth-of-type(1) > ol > li:nth-of-type(13) > a`)
	fmt.Println("=== 折叠侧栏里的链接，click 返回:", err)

	// 照报错的指引：先点开侧栏开关，再点链接
	if err := pg.click(ctx, "#sidebar-toggle"); err != nil {
		t.Fatal("sidebar-toggle:", err)
	}
	time.Sleep(500 * time.Millisecond)
	if err := pg.click(ctx, `nav > div:nth-of-type(1) > ol > li:nth-of-type(13) > a`); err != nil {
		t.Fatal("再次 click:", err)
	}
	time.Sleep(2 * time.Second)
	var title string
	if err := pg.eval(ctx, "document.title", &title); err != nil {
		t.Fatal(err)
	}
	fmt.Println("=== 点击后 title:", title)
	if !strings.Contains(title, "练习 5") {
		t.Fatalf("点击没有导航到练习 5，title=%q", title)
	}

	// mdBook 搜索：type 只填值不触发（防抖搜索框听 keyup），补一个真实按键
	if err := pg.click(ctx, "#search-toggle"); err != nil {
		t.Fatal("search-toggle:", err)
	}
	time.Sleep(500 * time.Millisecond)
	if err := pg.typeText(ctx, "#searchbar", "bash"); err != nil {
		t.Fatal("type:", err)
	}
	time.Sleep(1 * time.Second)
	var before int
	_ = pg.eval(ctx, `document.querySelectorAll('#searchresults a').length`, &before)
	if err := pg.pressKey(ctx, "enter"); err != nil {
		t.Fatal("key:", err)
	}
	time.Sleep(1500 * time.Millisecond)
	var after int
	_ = pg.eval(ctx, `document.querySelectorAll('#searchresults a').length`, &after)
	fmt.Printf("=== 搜索结果数：只 type=%d，补 enter 后=%d\n", before, after)

	shot, err := pg.screenshot(ctx)
	if err != nil {
		t.Fatal("screenshot:", err)
	}
	fmt.Println("=== screenshot:", shot)
}
