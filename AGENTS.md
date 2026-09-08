# AGENTS.md

This file provides guidance to AI agents when working with code in this repository.

## 参考文档

优先阅读以下 pi-coding-agent 文档；它们与本仓库的 extension 开发直接相关：

- `node_modules/@earendil-works/pi-coding-agent/docs/extensions.md` — Extension API、事件生命周期、命令、工具、状态管理与自定义 UI 的主参考。
- `node_modules/@earendil-works/pi-coding-agent/docs/tui.md` — `@earendil-works/pi-tui` 组件、自定义编辑器和 footer 的实现模式。
- `node_modules/@earendil-works/pi-coding-agent/docs/custom-provider.md` — 自定义 provider、模型定义与认证；修改 `pi-provider-ark` 时阅读。
- `node_modules/@earendil-works/pi-coding-agent/docs/session-format.md` — session 条目格式与 `SessionManager`；修改历史、recap 或 subagent 的持久化逻辑时阅读。
- `node_modules/@earendil-works/pi-coding-agent/docs/packages.md` — pi package 的扩展入口和运行时依赖约定。

需要核对实现或未公开的行为时，查看已安装版本的运行时代码与类型声明：

- `node_modules/@earendil-works/pi-coding-agent/dist/index.d.ts` — 公开导出的类型与函数。
- `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/{types,loader,runner}.{d.ts,js}` — 扩展类型、加载和事件执行流程。
- `node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.{d.ts,js}` — 交互 TUI 模式的集成行为。
- `node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.{d.ts,js}` — 会话状态与分支恢复实现。
