# AGENTS.md

This file provides guidance to AI agents when working with code in this repository.

## What this is

`pi-debug` is a Pi extension that lets the Pi Agent debug programs over the VS Code
Debug Adapter Protocol (DAP) — the same engine editors use for breakpoint debugging.
It exposes a single `debug` tool to the agent and drives real debug adapters (Node,
Python, Go's `dlv`, …) underneath.

The whole design follows one premise: **the consumer is an LLM, not a GUI.** An agent
cannot "watch" a UI, cannot hold volatile handles across turns, and pays for every token
of output. Every layer above the raw protocol exists to turn DAP's asynchronous,
stateful, handle-heavy model into short, self-describing, awaitable tool calls.

Design priorities, in order: **protocol correctness → agent ergonomics → KISS → layered & testable.**

## 参考文档

优先阅读以下 pi-coding-agent 文档；它们与本仓库的 extension 开发直接相关：

- `node_modules/@earendil-works/pi-coding-agent/docs/extensions.md` — Extension API、事件生命周期、命令、工具、状态管理与自定义 UI 的主参考。
- `node_modules/@earendil-works/pi-coding-agent/docs/tui.md` — `@earendil-works/pi-tui` 组件、自定义编辑器和 footer 的实现模式。
- `node_modules/@earendil-works/pi-coding-agent/docs/packages.md` — pi package 的扩展入口和运行时依赖约定。
