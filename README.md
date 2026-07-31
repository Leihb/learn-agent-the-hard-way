# Learn Agent the Hard Way

**从 60 行 Go 代码开始，亲手写出一个 agent。**

**agent = LLM + tool use。** 模型你改不了，循环只有几十行——一个 agent 和另一个 agent
的全部差别，都在工具的设计里。这本书带你从一次裸 HTTP 请求开始，把工具循环、权限系统、
上下文管理、skill、subagent、MCP、浏览器、沙箱一个个亲手写出来——你会发现它们本质上
都是同一件事：设计 tool。每个练习结束时，你手里的代码都能跑。

书中代码不是教学玩具：每一段都从一个真实生产 harness（[octo](https://github.com/open-octo/octo-agent)，
作者从零写的开源 agent）蒸馏而来。

## 📖 在线阅读

**https://leihb.github.io/learn-agent-the-hard-way/**

## 怎么读

- **跟着敲，不要复制粘贴。** 这是"the hard way"的全部含义。
- 你需要：Go 1.22+、任意一家模型服务商的 key（DeepSeek / Kimi / OpenAI 官方，
  或本机 Ollama——第一个练习起就支持，不花一分钱）。
- 每个练习的参考实现在 [`exercises/`](exercises/)，**卡住了再看**。

## 目录与进度

| 部 | 练习 | 状态 |
|---|---|---|
| 前言 | 什么是 agent | ✅ 已发布 |
| Part 0 · 为什么要自己写一遍 | 0 | ✅ 已发布 |
| Part 1 · 最小对话 | 1-4 | ✅ 练习 1 已发布 |
| Part 2 · 长出手脚：工具循环 | 5-9 | 🚧 |
| Part 3 · 记住事情 | 10-14 | 🚧 |
| Part 4 · 长出知识：skills | 15-17 | 🚧 |
| Part 5 · 长出分身：并行 | 18-20 | 🚧 |
| Part 6 · 高阶功能：MCP、浏览器、沙箱 | 21-24 | 🚧 |
| 后记 · 一通百通 | — | ✅ 已发布 |

边写边发，写完一章发一章。配套讲解视频在小红书同步更新。

## 许可

正文采用 [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/deed.zh-hans)，
`exercises/` 下的代码采用 MIT（见 [LICENSE](LICENSE)）。
