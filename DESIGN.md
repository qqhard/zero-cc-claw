# Zero-Claw 设计文档

## 理念

Zero-Claw 不是一个平台，不是一个框架，甚至不是一个应用。它是一个组合方案——用现成组件拼出一个私人 AI 助理，零基建。

**为什么叫 Zero？**
- Zero infrastructure：不需要服务器、数据库、API 网关、Docker
- Zero gateway：不自建通信层，Claude Code 本身就是后端
- Zero code（几乎）：核心只有一个小型 supervisor 脚本

## 架构

```
用户 (Telegram)
    │
    ▼
主 Bot (Claude Code + Telegram 插件)
    │
    ├── tmux session ── 持久运行
    ├── CLAUDE.md ───── 人格 + 行为定义
    ├── memory/ ─────── 跨 session 记忆
    └── .claude/skills/ ── 可选能力插件

Supervisor Bot (Node.js + pm2)
    │
    ├── tmux send-keys ── 控制主 Bot
    └── watchdog ──────── 崩溃自动重启
```

## 核心组件

| 组件 | 角色 | 来源 |
|------|------|------|
| Claude Code | 大脑（推理、工具调用、代码执行） | Anthropic 订阅 |
| Telegram 插件 | 嘴（接收和回复消息） | claude plugins install |
| tmux | 身体（持久化终端 session） | 系统工具 |
| Supervisor | 心脏监护（远程重启、状态监控） | 本项目 |
| CLAUDE.md | 灵魂（人格、规则、行为定义） | 用户自定义 |
| memory/ | 记忆（跨 session 持久化知识） | Claude Code 内建 |

## 设计原则

### 1. 不造轮子，只组合

Claude Code 已经有工具调用、MCP、文件读写、代码执行。Telegram 插件已经有消息收发。tmux 已经有 session 管理。pm2 已经有进程守护。

Zero-Claw 做的唯一一件事：用一个 supervisor 脚本把它们粘在一起。

### 2. CLAUDE.md 即应用

传统 bot 的逻辑写在代码里。Zero-Claw 的逻辑写在 CLAUDE.md 里——用自然语言定义行为，Claude Code 负责执行。

想加定时任务？在 CLAUDE.md 里写 cron 表。想改回复风格？改 CLAUDE.md 的 Principles。想加新能力？写一个 skill 文件夹。

### 3. 插件是 skill 文件夹

不需要 npm install，不需要 API 注册。一个 `SKILL.md` 就是一个插件——描述触发条件、行为、允许的工具。Claude Code 自动发现和加载。

### 4. 记忆跟着 git 走

memory/ 目录 git 追踪。换机器、重装系统，clone 下来记忆还在。不依赖外部数据库。

## 与 OpenClaw 的区别

| | OpenClaw | Zero-Claw |
|---|---|---|
| 架构 | 自建 gateway + 多 agent 编排 | 直接用 Claude Code |
| 通信 | 自建消息路由 | Telegram 插件 |
| 部署 | Docker + 数据库 + 配置 | tmux + pm2 |
| 代码量 | 数千行 | 一个小 supervisor |
| 扩展 | 插件系统 + API | CLAUDE.md + skill 文件夹 |
| 合规 | 需要 API key | Claude Code 订阅 |

## 文件结构

```
zero-claw/
├── DESIGN.md               # 本文件
├── CLAUDE.md               # Bot 人格模板
├── start.sh                # 启动脚本（1 行）
├── ecosystem.config.cjs    # pm2 配置
├── supervisor/
│   ├── index.mjs           # Supervisor bot
│   └── package.json
├── .claude/
│   ├── settings.json       # SessionStart hook
│   └── skills/
│       └── heartbeat/      # 心跳 + 日记
├── memory/
│   └── MEMORY.md           # 记忆索引
└── plugins/                # 可选插件
```

## 扩展路线

1. **插件生态**：邮件摘要、日历同步、知识库搜索、投资监控……每个都是一个 skill 文件夹
2. **多用户**：一个 supervisor 管理多个 tmux session，每个 session 一个独立 bot
3. **多通道**：除 Telegram 外接入 Slack、Discord（Claude Code 插件生态）
4. **MCP 集成**：通过 MCP server 接入 Notion、Gmail、Google Calendar 等外部服务

## 合规性

Zero-Claw 完全基于 Claude Code 订阅运行，不直接调用 API，不绕过计费。Supervisor 仅做进程管理，不代理 AI 请求。
