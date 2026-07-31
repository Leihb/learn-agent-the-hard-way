# 前言：什么是 agent

> 🚧 **写作中。** 先把全书的主旨立在这里：
>
> **agent = LLM + tool use。** 模型在循环里用工具，这是现代 agent 唯一的形状——
> 网上把 ReAct、Plan-and-Execute、Reflexion 并列成"几种实现模式"的教程，
> 都在把考古当架构。
>
> 模型你改不了，循环只有几十行。一个 agent 和另一个 agent 的全部差别，
> 都在工具的设计里——这本书从头到尾，其实都在教你设计 tool。
