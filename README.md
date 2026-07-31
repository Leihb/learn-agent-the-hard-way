# Learn Agent the Hard Way

**从 60 行 Go 代码开始，亲手写出一个 agent。**

你每天用的 agent，智能来自模型，能力边界全来自 harness——那个持有对话、调度工具、
管理上下文的循环。看懂它的唯一方式是写一遍。这本书带你从一次裸 HTTP 请求开始，
一路写到工具循环、权限系统、上下文压缩、skill 加载、subagent 并行——
每个练习结束时，你手里的代码都能跑。

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
| 前言 | 什么是 agent | 🚧 写作中 |
| Part 0 · 为什么要自己写一遍 | 0 | 🚧 |
| Part 1 · 最小对话 | 1-4 | ✅ 练习 1 已发布 |
| Part 2 · 长出手脚：工具循环 | 5-9 | 🚧 |
| Part 3 · 记住事情 | 10-14 | 🚧 |
| Part 4 · 长出知识：skills | 15-17 | 🚧 |
| Part 5 · 长出分身：并行 | 18-20 | 🚧 |
| Part 6 · 高阶功能：MCP、浏览器、沙箱 | 21-24 | 🚧 |

边写边发，写完一章发一章。配套讲解视频在小红书同步更新。

## 许可

正文采用 [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/deed.zh-hans)，
`exercises/` 下的代码采用 MIT（见 [LICENSE](LICENSE)）。
