package main

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// globToRegexp 的语义：** 跨目录，* 不跨，? 单字符。
func TestGlobToRegexp(t *testing.T) {
	cases := []struct {
		pattern, path string
		want          bool
	}{
		{"**/*.go", "main.go", true},
		{"**/*.go", "a/b/c.go", true},
		{"*.go", "main.go", true},
		{"*.go", "a/main.go", false}, // * 不跨目录
		{"src/**/*.ts", "src/a/b.ts", true},
		{"src/**/*.ts", "lib/a.ts", false},
		{"a?.txt", "ab.txt", true},
		{"a?.txt", "a/b.txt", false}, // ? 不匹配斜杠
		{"docs/*.md", "docs/x.md", true},
		{"docs/*.md", "docs/sub/x.md", false},
	}
	for _, c := range cases {
		re, err := globToRegexp(c.pattern)
		if err != nil {
			t.Fatalf("globToRegexp(%q): %v", c.pattern, err)
		}
		if got := re.MatchString(c.path); got != c.want {
			t.Errorf("模式 %q 对 %q：期望 %v，实际 %v", c.pattern, c.path, c.want, got)
		}
	}
}

// grep 真跑一遍 ripgrep：有匹配、无匹配、非法 mode。
func TestGrepExecute(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "a.go"), []byte("package main\nfunc 找我() {}\n"), 0o644)
	os.WriteFile(filepath.Join(dir, "b.txt"), []byte("无关内容\n"), 0o644)

	out := grepTool{}.execute(context.Background(),
		fmt.Sprintf(`{"pattern":"找我","path":%q}`, dir))
	if !strings.Contains(out, "a.go") || !strings.Contains(out, "找我") {
		t.Fatalf("应命中 a.go 的内容行，实际 %q", out)
	}
	out = grepTool{}.execute(context.Background(),
		fmt.Sprintf(`{"pattern":"不存在的串xyz","path":%q}`, dir))
	if out != "(没有匹配)" {
		t.Fatalf("无匹配应返回干净答案，实际 %q", out)
	}
	out = grepTool{}.execute(context.Background(), `{"pattern":"x","mode":"weird"}`)
	if !strings.Contains(out, "不认识的 mode") {
		t.Fatalf("非法 mode 应报错，实际 %q", out)
	}
}

// glob 真跑：** 命中子目录，mtime 新的在前，无匹配有干净答案。
func TestGlobExecute(t *testing.T) {
	dir := t.TempDir()
	os.MkdirAll(filepath.Join(dir, "sub"), 0o755)
	os.WriteFile(filepath.Join(dir, "old.go"), []byte("x"), 0o644)
	os.WriteFile(filepath.Join(dir, "sub", "new.go"), []byte("x"), 0o644)

	out := globTool{}.execute(context.Background(),
		fmt.Sprintf(`{"pattern":"**/*.go","path":%q}`, dir))
	if !strings.Contains(out, "old.go") || !strings.Contains(out, filepath.Join("sub", "new.go")) {
		t.Fatalf("** 应同时命中根和子目录，实际 %q", out)
	}
	lines := strings.Split(strings.TrimSpace(out), "\n")
	if lines[0] != filepath.Join("sub", "new.go") {
		t.Fatalf("最近修改的应排在前面，实际第一行 %q", lines[0])
	}
	out = globTool{}.execute(context.Background(),
		fmt.Sprintf(`{"pattern":"*.rs","path":%q}`, dir))
	if !strings.Contains(out, "没有匹配") {
		t.Fatalf("无匹配应有干净答案，实际 %q", out)
	}
}

// stripHTMLToText：script/style 整块消失，标签剥掉，实体解码。
func TestStripHTMLToText(t *testing.T) {
	in := `<html><head><style>body{color:red}</style>
<script>alert("噪音")</script></head>
<body><h1>标题</h1><p>正文 &amp; 实体</p></body></html>`
	out := stripHTMLToText(in)
	if strings.Contains(out, "alert") || strings.Contains(out, "color:red") {
		t.Fatalf("script/style 应整块消失，实际 %q", out)
	}
	if !strings.Contains(out, "标题") || !strings.Contains(out, "正文 & 实体") {
		t.Fatalf("正文和解码后的实体应保留，实际 %q", out)
	}
}

// 假 bing 页面：两段式提取拿到标题、URL、摘要。
func fakeBingHTML() string {
	return `<html><body><ol id="b_results">
<li class="b_algo"><h2><a href="https://example.com/one">第一条 <strong>结果</strong></a></h2><div><p class="b_lineclamp2">这是第一条的摘要 &#0183; 带实体</p></div></li>
<li class="b_algo"><h2><a href="https://example.com/two">第二条</a></h2><p>第二条摘要</p></li>
</ol></body></html>`
}

func TestSearchBingParsesResults(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, fakeBingHTML())
	}))
	defer srv.Close()
	old := bingEndpoint
	bingEndpoint = srv.URL
	defer func() { bingEndpoint = old }()

	results, err := searchBing(context.Background(), "任意", 5)
	if err != nil {
		t.Fatalf("searchBing: %v", err)
	}
	if len(results) != 2 {
		t.Fatalf("应解析出 2 条，实际 %d", len(results))
	}
	if results[0].Title != "第一条 结果" || results[0].URL != "https://example.com/one" {
		t.Fatalf("第一条解析不对：%+v", results[0])
	}
	if !strings.Contains(results[0].Snippet, "第一条的摘要") {
		t.Fatalf("摘要解析不对：%q", results[0].Snippet)
	}
}

// 链条降级：brave 有 key 但一直 500，链条要顺下去落到 bing，
// provider 如实说结果是谁给的。
func TestWebSearchFallsBackToBing(t *testing.T) {
	brave := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "配额烧完了", http.StatusInternalServerError)
	}))
	defer brave.Close()
	bing := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, fakeBingHTML())
	}))
	defer bing.Close()

	oldBrave, oldBing := braveEndpoint, bingEndpoint
	braveEndpoint, bingEndpoint = brave.URL, bing.URL
	defer func() { braveEndpoint, bingEndpoint = oldBrave, oldBing }()
	t.Setenv("BRAVE_SEARCH_API_KEY", "假key")

	out := webSearchTool{}.execute(context.Background(), `{"query":"测试"}`)
	if !strings.Contains(out, `"provider": "bing"`) {
		t.Fatalf("brave 失败后应降级到 bing，实际 %q", out)
	}
	if !strings.Contains(out, "example.com/one") {
		t.Fatalf("结果应来自 bing 假页面，实际 %q", out)
	}
}

// brave 正常时链条停在第一环，根本不碰 bing。
func TestWebSearchPrefersBrave(t *testing.T) {
	brave := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{"web":{"results":[{"title":"付费结果","url":"https://brave.example/hit","description":"高质量"}]}}`)
	}))
	defer brave.Close()
	bingCalled := false
	bing := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		bingCalled = true
	}))
	defer bing.Close()

	oldBrave, oldBing := braveEndpoint, bingEndpoint
	braveEndpoint, bingEndpoint = brave.URL, bing.URL
	defer func() { braveEndpoint, bingEndpoint = oldBrave, oldBing }()
	t.Setenv("BRAVE_SEARCH_API_KEY", "假key")

	out := webSearchTool{}.execute(context.Background(), `{"query":"测试"}`)
	if !strings.Contains(out, `"provider": "brave"`) || !strings.Contains(out, "付费结果") {
		t.Fatalf("有 key 且 brave 正常时应用 brave，实际 %q", out)
	}
	if bingCalled {
		t.Fatal("brave 成功后不该再碰 bing")
	}
}

// 沙箱网络开关：关网时两个网络工具拒绝干活，本地检索不受影响。
func TestNetworkGateBlocksWebTools(t *testing.T) {
	p := defaultSandboxPolicy() // allowNetwork: false
	activeSandbox = &p
	defer func() { activeSandbox = nil }()

	if out := (webFetchTool{}).execute(context.Background(), `{"url":"https://example.com"}`); !strings.Contains(out, "沙箱关闭了网络") {
		t.Fatalf("关网时 web_fetch 应拒绝，实际 %q", out)
	}
	if out := (webSearchTool{}).execute(context.Background(), `{"query":"x"}`); !strings.Contains(out, "沙箱关闭了网络") {
		t.Fatalf("关网时 web_search 应拒绝，实际 %q", out)
	}
	// 本地检索照常。
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "a.txt"), []byte("本地内容\n"), 0o644)
	if out := (grepTool{}).execute(context.Background(), fmt.Sprintf(`{"pattern":"本地","path":%q}`, dir)); !strings.Contains(out, "本地内容") {
		t.Fatalf("关网不该影响本地 grep，实际 %q", out)
	}
}

// web_fetch 的基本行为：文本返回、二进制拒读、剥标签开关。
func TestWebFetchTextBinaryAndClean(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/page":
			w.Header().Set("Content-Type", "text/html")
			fmt.Fprint(w, `<html><script>alert(1)</script><body><h1>网页标题</h1></body></html>`)
		case "/bin":
			w.Header().Set("Content-Type", "image/png")
			w.Write([]byte{0x89, 0x50})
		}
	}))
	defer srv.Close()

	out := webFetchTool{}.execute(context.Background(), fmt.Sprintf(`{"url":%q}`, srv.URL+"/page"))
	if !strings.Contains(out, "网页标题") || strings.Contains(out, "alert") {
		t.Fatalf("默认应剥标签去脚本，实际 %q", out)
	}
	out = webFetchTool{}.execute(context.Background(), fmt.Sprintf(`{"url":%q,"clean":false}`, srv.URL+"/page"))
	if !strings.Contains(out, "<h1>") {
		t.Fatalf("clean=false 应返回原始 HTML，实际 %q", out)
	}
	out = webFetchTool{}.execute(context.Background(), fmt.Sprintf(`{"url":%q}`, srv.URL+"/bin"))
	if !strings.Contains(out, "二进制") {
		t.Fatalf("二进制内容应返回提示而不是乱码，实际 %q", out)
	}
}
