# @cloudbase/open-agent-kernel

> CloudBase 平台的服务端 Agent SDK — 一行代码创建具备 CloudBase 资源能力的 AI Agent

[![npm version](https://img.shields.io/npm/v/@cloudbase/open-agent-kernel)](https://www.npmjs.com/package/@cloudbase/open-agent-kernel)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

## 什么是 Open Agent Kernel

Open Agent Kernel（OAK）是面向 **CloudBase 平台开发者** 的服务端 Agent SDK。它封装了底层 AI Agent 引擎，让开发者以 `envId` 为锚点，一行代码创建能读写数据库、操作云存储、执行 Shell 命令的 AI Agent。

```typescript
import { createAgent } from '@cloudbase/open-agent-kernel'

const agent = createAgent({
  envId: 'my-env-123',
  model: 'glm-5.1',
  systemPrompt: 'You are a helpful CloudBase assistant.',
  sandbox: { runtime: new AgsStatefulSandbox() },
})

const session = await agent.startSession({ userId: 'user-1' })
for await (const event of session.send('帮我创建一个 hello.txt 文件')) {
  if (event.type === 'message_delta') process.stdout.write(event.text)
}
```

## 核心特性

| 特性 | 描述 |
|------|------|
| **5 分钟上手** | 纯 npm 库 import，`envId` + `model` 两个参数即可启动 |
| **CloudBase 资源原生集成** | 数据库 / 云存储 / 云函数 / 静态托管 — 自动通过沙箱注入 |
| **远程沙箱** | AGS Stateful Sandbox，支持 bash / 文件读写 / 编辑 / 搜索 |
| **MCP 扩展** | 支持 4 种形态的 MCP Server（stdio / http / sse / 进程内 SDK） |
| **HITL 工具审批** | 敏感操作自动暂停等待用户确认，支持分布式跨节点 resume |
| **会话持久化** | 多轮对话 + 跨进程 resume + 消息历史查询 |
| **多模态输入** | 图片附件 + 视觉模型（本地文件 / URL / 云存储） |
| **协议中立** | 不绑定客户端协议，可对接 ACP / AG-UI / SSE 等任意协议 |

## 安装

```bash
pnpm add @cloudbase/open-agent-kernel
# 使用 CloudBase 功能时需额外安装（peer dependency）
pnpm add @cloudbase/node-sdk
```

## 快速开始

### 最简对话

```typescript
import { createAgent } from '@cloudbase/open-agent-kernel'

const agent = createAgent({
  envId: process.env.TCB_ENV_ID!,
  model: 'glm-5.1',
  systemPrompt: 'You are a helpful assistant. Reply in Chinese.',
})

const session = await agent.startSession({ userId: 'demo-user' })
for await (const event of session.send('你好，介绍一下你自己')) {
  if (event.type === 'message_delta') process.stdout.write(event.text)
}
```

### 带沙箱的 Coding Agent

```typescript
import { createAgent, AgsStatefulSandbox } from '@cloudbase/open-agent-kernel'

const agent = createAgent({
  envId: process.env.TCB_ENV_ID!,
  model: 'glm-5.1',
  systemPrompt: 'You are a coding assistant with sandbox access.',
  sandbox: { runtime: new AgsStatefulSandbox() },
})

const session = await agent.startSession({ userId: 'user-1' })
for await (const event of session.send('创建一个 Express 服务器并运行')) {
  if (event.type === 'message_delta') process.stdout.write(event.text)
  if (event.type === 'tool_call') console.log(`→ ${event.toolName}`)
}
await session.abort() // 释放沙箱
```

### 多轮对话 + 持久化

```typescript
import { createAgent, CloudBaseSessionStore, CloudBaseDbDriver } from '@cloudbase/open-agent-kernel'

const envId = process.env.TCB_ENV_ID!
const store = new CloudBaseSessionStore({
  driver: new CloudBaseDbDriver(),
  projectKey: envId,
})

const agent = createAgent({
  envId,
  model: 'glm-5.1',
  session: { store, projectKey: envId },
})

// 创建会话
const session = await agent.startSession({ userId: 'user-1' })
for await (const e of session.send('我叫小明')) { /* ... */ }

// 跨进程恢复（任意节点）
const resumed = await agent.resumeSession(session.id)
for await (const e of resumed.send('还记得我的名字吗？')) { /* ... */ }
```

## API 概览

### `createAgent(config)` → `Agent`

| 配置项 | 类型 | 必填 | 说明 |
|--------|------|:----:|------|
| `envId` | `string` | ✅ | CloudBase 环境 ID |
| `model` | `string \| ModelSpec` | ✅ | 模型标识（如 `'glm-5.1'`） |
| `systemPrompt` | `string` | | 系统提示词 |
| `sandbox` | `SandboxConfig` | | 沙箱配置（启用文件系统/Shell） |
| `session` | `SessionConfig` | | 会话持久化配置 |
| `permissions` | `PermissionConfig` | | HITL 工具审批配置 |
| `mcpServers` | `Record<string, McpServerConfig>` | | MCP 服务器 |
| `storage` | `StorageProvider` | | 多模态附件存储 |
| `hooks` | `AgentHooks` | | 业务生命周期钩子 |

<details>
<summary>配置类型定义展开</summary>

```typescript
/** 模型配置：简单字符串或完整 spec */
type ModelInput = string | ModelSpec
interface ModelSpec {
  id: string             // 模型 ID，如 'glm-5.1'
  apiKey?: string        // 自带 key（不传走平台网关）
  apiBaseUrl?: string    // 自带 endpoint
}

/** 沙箱配置 */
interface SandboxConfig {
  runtime?: SandboxRuntime         // AgsStatefulSandbox 实例
  scope?: 'session' | 'shared'     // 实例粒度（默认 session）
  cloudbaseTools?: boolean         // 暴露 mcp__cloudbase__* 工具（默认 true）
  userCredentials?: SandboxUserCredentials | (() => Promise<SandboxUserCredentials>)
}

/** 会话持久化配置 */
interface SessionConfig {
  store?: SessionStore             // CloudBaseSessionStore 实例
  projectKey?: string              // 多租户隔离键（推荐传 envId）
  flush?: 'batched' | 'eager'      // 落盘策略
}

/** HITL 权限配置 */
interface PermissionConfig {
  requireApproval?: RequireApprovalRule  // 哪些工具需要审批
  store?: PermissionStore                // 审批状态存储（默认 InMemory）
  approvalTimeoutMs?: number             // 超时时间（默认 30 分钟）
}

/** 审批规则：字符串通配 / 数组 / 函数 */
type RequireApprovalRule =
  | string                          // '*' 全部 | 'Bash' 精确 | 'mcp__*' 通配
  | string[]                        // 多个规则
  | ((ctx: { toolName: string; input: unknown }) => boolean)

/** 审批决策 */
type ApprovalDecision =
  | { kind: 'allow'; scope?: 'once' | 'session' | 'forever'; updatedInput?: Record<string, unknown> }
  | { kind: 'deny'; scope?: 'once' | 'session'; reason?: string; interrupt?: boolean }

/** MCP Server 配置（4 种形态） */
type McpServerConfig =
  | { type: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }  // 子进程
  | { type: 'http'; url: string; headers?: Record<string, string> }                     // 远程 HTTP
  | { type: 'sse'; url: string; headers?: Record<string, string> }                      // 远程 SSE
  | { type: 'sdk'; name: string; instance: McpServerInstance }                          // 进程内 SDK

/** 业务生命周期钩子 */
interface AgentHooks {
  onUserMessage?: (ctx: UserMessageContext) => void | { modifiedPrompt?: string }
  onToolStart?: (ctx: ToolStartContext) => void
  onToolEnd?: (ctx: ToolEndContext) => void | { updatedOutput?: unknown }
  onAgentMessage?: (ctx: AgentMessageContext) => void
  onSessionStart?: (ctx: SessionContext) => void
  onSessionEnd?: (ctx: SessionContext) => void
}
```

</details>

### `Agent`

```typescript
interface Agent {
  startSession(opts: { userId: string; conversationId?: string }): Promise<Session>
  resumeSession(conversationId: string): Promise<Session>
  sessions: SessionManagement  // list / get / delete
}
```

### `Session`

```typescript
interface Session {
  id: string
  send(input: string | SessionInput): AsyncIterable<SessionEvent>
  respondApproval(opts: { toolUseId: string; decision: ApprovalDecision }): AsyncIterable<SessionEvent>
  getHistory(opts?: { limit?: number; before?: number }): Promise<MessageRecord[]>
  clearHistory(): Promise<void>
  abort(): Promise<void>
}
```

### `SessionEvent`（流式事件）

```typescript
type SessionEvent =
  | { type: 'message_delta'; text: string }
  | { type: 'message_complete'; text: string }
  | { type: 'tool_call'; toolUseId: string; toolName: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; toolName: string; output: unknown; isError: boolean }
  | { type: 'tool_approval_required'; toolUseId: string; toolName: string; input: unknown }
  | { type: 'session_idle'; reason: 'completed' | 'requires_action' | 'aborted' | 'error' }
  | { type: 'error'; error: Error }
```

## 沙箱工具

启用 `sandbox` 后，Agent 自动获得以下工具：

| 工具名 | 功能 |
|--------|------|
| `mcp__sandbox__bash` | 执行 Shell 命令 |
| `mcp__sandbox__read` | 读取文件内容 |
| `mcp__sandbox__write` | 写入文件 |
| `mcp__sandbox__edit` | 编辑文件（查找替换） |
| `mcp__sandbox__glob` | 按 pattern 列出文件 |
| `mcp__sandbox__grep` | 正则搜索文件内容 |

设置 `sandbox.cloudbaseTools: true`（默认）还会额外暴露 `mcp__cloudbase__*` 工具集（数据库 CRUD / 云存储 / 云函数 / 静态托管等）。

## MCP 扩展

支持 4 种形态接入外部工具。工具名规则：`mcp__{serverName}__{toolName}`。

### 进程内 SDK Server（推荐）

零外部依赖，工具就是普通 TS 函数，凭证 / 上下文跟 kernel 共享：

```typescript
import { createAgent } from '@cloudbase/open-agent-kernel'
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'

const calculator = createSdkMcpServer({
  name: 'calc',
  version: '1.0.0',
  tools: [
    tool('add', 'Add two numbers', { a: z.number(), b: z.number() }, async (args) => ({
      content: [{ type: 'text', text: String(args.a + args.b) }],
    })),
  ],
})

const agent = createAgent({
  envId: process.env.TCB_ENV_ID!,
  model: 'glm-5.1',
  mcpServers: { calc: calculator }, // 模型看到工具名为 mcp__calc__add
})
```

### stdio 子进程

```typescript
mcpServers: {
  everything: { type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-everything'] },
}
```

### 远程 HTTP / SSE

```typescript
mcpServers: {
  remote: { type: 'http', url: 'https://example.com/mcp/v1', headers: { Authorization: 'Bearer xxx' } },
}
```

## HITL 工具审批

对敏感工具调用设置人工审批：

```typescript
import {
  createAgent,
  AgsStatefulSandbox,
  CloudBaseSessionStore,
  CloudBaseDbDriver,
  CloudBasePermissionStore,
  CloudBaseDbPermissionDriver,
} from '@cloudbase/open-agent-kernel'

const envId = process.env.TCB_ENV_ID!
const sessionStore = new CloudBaseSessionStore({ driver: new CloudBaseDbDriver(), projectKey: envId })
const permissionStore = new CloudBasePermissionStore({
  driver: new CloudBaseDbPermissionDriver(),
  projectKey: envId,
})

const agent = createAgent({
  envId,
  model: 'glm-5.1',
  sandbox: { runtime: new AgsStatefulSandbox() },
  session: { store: sessionStore, projectKey: envId },
  permissions: {
    requireApproval: ['mcp__sandbox__bash', 'mcp__cloudbase__deleteData'],
    store: permissionStore,
  },
})

const session = await agent.startSession({ userId: 'u1' })
for await (const e of session.send('删除测试数据')) {
  if (e.type === 'tool_approval_required') {
    // 展示审批 UI → 收集用户决策
  }
}
// 用户决策后 resume
for await (const e of session.respondApproval({
  toolUseId: '...',
  decision: { kind: 'allow', scope: 'once' },
})) { /* agent 继续 */ }
```

## 消息历史查询

`getHistory()` 返回前端可直接渲染的聚合结果：

```typescript
const history = await session.getHistory({ limit: 20 })
// 返回严格的 user → assistant 交替结构
// assistant 的 parts 包含 tool_call + tool_result 配对
// 内部协议产物（sentinel、resume prompt）已过滤
```

## 环境变量

| 变量 | 说明 | 必需 |
|------|------|:----:|
| `TCB_ENV_ID` | CloudBase 环境 ID | ✅ |
| `TENCENTCLOUD_TOKENHUB_API_KEY` | 模型凭证（TokenHub） | ✅ |
| `TCB_SECRET_ID` | CloudBase AK | 使用 DB/沙箱时 |
| `TCB_SECRET_KEY` | CloudBase SK | 使用 DB/沙箱时 |
| `TCB_API_KEY` | 沙箱数据面 JWT | 使用沙箱时 |
| `OAK_DEBUG` | 设为 `1` 启用调试日志 | |

## CloudBase DB 集合

SDK 使用以下集合（前缀默认 `oak_`）：

| 集合 | 用途 |
|------|------|
| `oak_sessions` | Session 索引 |
| `oak_session_entries` | SDK Transcript（给 resume 用） |
| `oak_session_summaries` | Session 摘要 |
| `oak_session_messages` | 消息元数据索引（给 getHistory 分页） |
| `oak_state` | 统一临时状态（HITL 审批等） |

## 示例

```bash
# 运行示例前先配置凭证
cp packages/open-agent-kernel/examples/.env.example packages/open-agent-kernel/examples/.env.local

# 最简对话
pnpm dlx tsx packages/open-agent-kernel/examples/01-quickstart.ts

# 沙箱 + 文件操作
pnpm dlx tsx packages/open-agent-kernel/examples/08-sandbox.ts

# HITL 审批
pnpm dlx tsx packages/open-agent-kernel/examples/11-hitl-approval.ts

# 综合测试（沙箱 + HITL + 历史查询 + 聚合验证）
pnpm dlx tsx packages/open-agent-kernel/examples/14-session-history.ts
```

完整示例列表见 [`examples/README.md`](./examples/README.md)。

## 架构

```
用户代码
  └─ createAgent(config) → Agent
       ├─ Session
       │    ├── send() → AsyncIterable<SessionEvent>
       │    ├── respondApproval() → AsyncIterable<SessionEvent>
       │    ├── getHistory() → MessageRecord[]
       │    └── abort()
       ├─ SessionStore（CloudBase DB / InMemory）
       ├─ Sandbox（AGS Stateful Sandbox + CloudBase MCP）
       └─ Permissions（PreToolUse Hook, 流终止+resume 范式）
            └─ oak_state 统一临时状态表
```

## 设计原则

1. **5 分钟上手** — `envId` + `model` 两个参数即可跑通
2. **CloudBase 原生** — 资源通过 `envId` 自动派生，无需手动配置
3. **协议中立** — 不绑定客户端协议（ACP / AG-UI / SSE 等由业务层适配）
4. **纯库形态** — 无 spawn 子进程依赖，任意 Node.js 运行时可用
5. **渐进式能力** — 沙箱、持久化、审批、MCP 全部可选，按需开启

## License

MIT
