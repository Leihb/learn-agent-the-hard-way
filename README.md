# 笨办法学 Agent · 亲手打造一个 harness

> 同系列第二本《[笨办法学 Agent · 用 LangGraph 上线](https://github.com/Leihb/langgraph-in-action)》
> 用框架把场景 agent 做出来、放到线上，不需要先读完这一本。

**从 60 行代码开始，亲手写出一个 agent。**

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
- 你需要：Go 1.22+（或 Python 3.10+ / Node 18+，见下方"三种语言"）、
  任意一家模型服务商的 key（DeepSeek / Kimi / OpenAI 官方，
  或本机 Ollama——第一个练习起就支持，不花一分钱）。
- 每个练习的参考实现在 [`exercises/`](exercises/)，**卡住了再看**。

## 三种语言

代码以 Go 为母本，Python 和 JavaScript 版本正在逐章补齐。
凡是正文里出现语言切换标签的章节，三种语言都过了同一套真机验证
（DeepSeek + 本机 Ollama）；点一次标签，全书跟着你切换。
参考实现的位置：Go 在 `exercises/exNN/`，Python 和 JavaScript
在对应的 `exercises/exNN/python/` 和 `exercises/exNN/node/`。

## 目录

**全书已完结**：前言 + 32 个练习 + 后记，全部发布。

| 部 | 练习 |
|---|---|
| 前言 | 什么是 agent |
| Part 0 · 为什么要自己写一遍 | 0 |
| Part 1 · 最小对话 | 1-4 |
| Part 2 · 长出手脚：工具循环 | 5-10 |
| Part 3 · 记住事情 | 11-15 |
| Part 4 · 长出知识：skills | 16-18 |
| Part 5 · 长出分身：并行 | 19-21 |
| Part 6 · 高阶功能 | 22-23 |
| Part 7 · 一个真正的产品 | 24-30 |
| 终章 · 你手里的这个东西 | 31 |
| 后记 · 一通百通 | — |

读完最后一个练习，你手里是一个约五千行、19 种工具、只有一个第三方
依赖的完整 harness——常驻对话、权限、沙箱、记忆、skill、subagent、
MCP、定时循环、后台任务、浏览器，全部亲手写的。

## 许可

正文采用 [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/deed.zh-hans)，
`exercises/` 下的代码采用 MIT（见 [LICENSE](LICENSE)）。
