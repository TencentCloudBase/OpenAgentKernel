# @cloudbase/open-agent-kernel

> CloudBase 平台的服务端 Agent SDK — 一行代码创建具备 CloudBase 资源能力的 AI Agent

[![npm version](https://img.shields.io/npm/v/@cloudbase/open-agent-kernel)](https://www.npmjs.com/package/@cloudbase/open-agent-kernel)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

## 什么是 Open Agent Kernel

Open Agent Kernel（OAK）是面向 **CloudBase 平台开发者** 的服务端 Agent SDK。它封装了底层 AI Agent 引擎，让开发者以 `envId` 为锚点，一行代码创建能读写数据库、操作云存储、执行 Shell 命令的 AI Agent。

```typescript
import { createAgent, AgsStatefulSandbox } from '@cloudbase/open-agent-kernel'

const agent = createAgent({
  envId: 'my-env-123',
  credentials: {
    secretId: process.env.TENCENTCLOUD_SECRETID!,
    secretKey: process.env.TENCENTCLOUD_SECRETKEY!,
  },
  model: 'glm-5.1',
  systemPrompt: 'You are a helpful CloudBase assistant.',
  sandbox: { runtime: new AgsStatefulSandbox({ apiKey: process.env.TCB_API_KEY! }) },
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
  credentials: {
    secretId: process.env.TENCENTCLOUD_SECRETID!,
    secretKey: process.env.TENCENTCLOUD_SECRETKEY!,
  },
  sandbox: { runtime: new AgsStatefulSandbox({ apiKey: process.env.TCB_API_KEY! }) },
})

const session = await agent.startSession({ userId: 'user-1' })
for await (const event of session.send('创建一个 Express 服务器并运行')) {
  if (event.type === 'message_delta') process.stdout.write(event.text)
  if (event.type === 'tool_call') console.log(`→ ${event.toolName}`)
}
await session.abort() // 释放沙箱
```

### 多轮对话 + 默认持久化

```typescript
import { createAgent } from '@cloudbase/open-agent-kernel'

const envId = process.env.TCB_ENV_ID!
const credentials = {
  secretId: process.env.TENCENTCLOUD_SECRETID!,
  secretKey: process.env.TENCENTCLOUD_SECRETKEY!,
}
const agent = createAgent({
  envId,
  credentials,
  model: 'glm-5.1',
  // 有 credentials 时默认启用 CloudBase FlexDB session store 和 CloudBase Storage。
  // 如需自定义表前缀：session: { tablePrefix: 'my_agent_' }
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
| `credentials` | `PlatformCredentials` | 使用 CloudBase 资源时 | 平台凭证；`envId` 可省略并继承顶层 `envId`，传入后默认启用 CloudBase FlexDB session store、CloudBase Storage 和 CloudBase permission store |
| `model` | `string \| ModelSpec` | ✅ | 模型标识（如 `'glm-5.1'`） |
| `systemPrompt` | `string` | | 系统提示词 |
| `sandbox` | `SandboxConfig` | | 沙箱配置（启用文件系统/Shell） |
| `session` | `SessionConfig` | | 会话持久化配置 |
| `permissions` | `PermissionConfig` | | HITL 工具审批配置 |
| `mcpServers` | `Record<string, McpServerConfig>` | | MCP 服务器 |
| `storage` | `StorageProvider` | | 多模态附件存储；不传且有 `credentials` 时默认使用 CloudBase Storage |
| `hooks` | `AgentHooks` | | 业务生命周期钩子 |
| `cwd` | `string` | | 平台资产层根目录(skills + 项目级 CLAUDE.md 加载根) |
| `skills` | `{ enabled?: 'all' \| string[] }` | | 启用 SDK skills 能力(需配合 `cwd`) |
| `userMemory` | `boolean \| { enabled?: boolean }` | | 用户级长期记忆；`true` 表示启用，自动同步到 envId 对应 COS |
| `sandbox.workspaceSnapshot` | `'auto' \| 'enabled' \| 'disabled'` | | sandbox cwd 自动持久化(ags-stateful 默认 `'auto'`,需 `scope: 'shared'`) |
| `sandbox.workspaceSnapshotTimeoutMs` | `number` | | snapshot RPC 超时,默认 `30_000`(镜像内部上限 600_000) |
| `sandbox.workspaceInitTimeoutMs` | `number` | | bootstrap restore 超时,默认 `60_000`(镜像内部上限 1_200_000) |

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
  enabled?: boolean                // 默认：有 credentials 时启用 CloudBase FlexDB
  provider?: 'cloudbase'           // 默认 cloudbase
  database?: 'flexdb' | 'mongo' | 'mysql' | 'pgsql' // 默认 flexdb
  store?: SessionStore             // 高级自定义 SessionStore
  tablePrefix?: string             // 默认 'oak_'
  projectKey?: string              // 默认 envId
  flush?: 'batched' | 'eager'      // 落盘策略
}

/** HITL 权限配置 */
interface PermissionConfig {
  requireApproval?: RequireApprovalRule  // 哪些工具需要审批
  store?: PermissionStore                // 审批状态存储；有 credentials 时默认 CloudBase FlexDB
  tablePrefix?: string                   // 默认 'oak_'，集合名为 `${tablePrefix}state`
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
import { createAgent, AgsStatefulSandbox } from '@cloudbase/open-agent-kernel'

const envId = process.env.TCB_ENV_ID!
const credentials = {
  secretId: process.env.TENCENTCLOUD_SECRETID!,
  secretKey: process.env.TENCENTCLOUD_SECRETKEY!,
}

const agent = createAgent({
  envId,
  credentials,
  model: 'glm-5.1',
  sandbox: { runtime: new AgsStatefulSandbox({ apiKey: process.env.TCB_API_KEY! }) },
  permissions: {
    requireApproval: ['mcp__sandbox__bash', 'mcp__cloudbase__deleteData'],
    // 有 credentials 时默认使用 CloudBase FlexDB permission store，支持跨节点 respondApproval。
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
| `TENCENTCLOUD_SECRETID` | CloudBase AK | 使用 DB/沙箱/userMemory 时 |
| `TENCENTCLOUD_SECRETKEY` | CloudBase SK | 使用 DB/沙箱/userMemory 时 |
| `TENCENTCLOUD_SESSIONTOKEN` | 临时凭证 token | 使用 STS 临时凭证时 |
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

## 平台资产 vs 用户私产

OAK 把 Claude SDK 文件系统资产分两类:

**平台资产**(共享 / 只读心智 — 业务方在镜像或 cwd 中管理):
- 项目级 `CLAUDE.md`(`cwd/CLAUDE.md`)
- Skills(`cwd/.claude/skills/`)
- 子 agent 定义、规则、命令(`cwd/.claude/{agents,rules,commands}/`)

**用户私产**(独占 / 读写心智 — SDK 自动写,跨节点同步到 COS):
- 用户级 `CLAUDE.md`(`<CLAUDE_CONFIG_DIR>/CLAUDE.md`)
- 主会话自动记忆(`<CLAUDE_CONFIG_DIR>/projects/*/memory/`)
- 子 agent 用户级记忆(`<CLAUDE_CONFIG_DIR>/agent-memory/`)

两者用不同的载体:平台资产走 `cwd` 字段,用户私产走 `userMemory: true`。

## 沙箱粒度(scope)与术语对照

`sandbox.scope` 描述 AGS 实例粒度,**与"沙箱内工作区目录派生"是两层正交关系**。

| OAK SDK | server feature/stateful-infra | 含义 |
|---|---|---|
| `scope: 'session'`(默认) | `sandboxMode: 'isolated'` | 每 session 一个独立 AGS 实例 |
| `scope: 'shared'` | `sandboxMode: 'shared'` | 同 envId 多 session 共享一个 AGS 实例 |

工作区目录派生(`/home/user/{conversationId}/`)由沙箱镜像负责,SDK 不感知。

## userMemory 启用前提

启用 `userMemory: true` 后,业务方上游必须保证:

> **同一 userId 的请求不能并发处理** — 即同一时刻不能有两个 SDK 节点同时为 alice 服务。

注意:这只要求"串行性",**不要求"永远固定到同一节点"**。alice 这次请求落 node1、下次落 node2 完全可以,只要两次不重叠即可。常见实现路径:Redis 互斥锁 / userId 队列 / 会话级路由 / 一致性哈希 — 任选其一。

```typescript
import { createAgent, writeUserMemoryFiles, deleteUserMemoryFiles } from '@cloudbase/open-agent-kernel'

const agent = createAgent({
  envId,
  credentials: { secretId, secretKey },
  model: 'glm-5.1',
  userMemory: true,
})

await writeUserMemoryFiles({
  envId,
  userId: 'alice',
  credentials: { secretId, secretKey },
  files: [{ path: 'CLAUDE.md', content: '请始终用中文回答。' }],
})

await deleteUserMemoryFiles({
  envId,
  userId: 'alice',
  credentials: { secretId, secretKey },
  paths: ['CLAUDE.md'],
})
```

### 已知限制

- **项目级主会话 auto-memory 不传 `cwd` 时跨节点不可复用** — SDK 用 cwd hash 派生项目子目录,默认 ephemeral cwd 是随机的。要跨节点复用项目级记忆请传稳定的 `cwd`。
- **项目级 subagent memory 不同步** — 仅同步 `<CLAUDE_CONFIG_DIR>/agent-memory/`(用户级)。子 agent 用 `memory: 'project'` 时不持久化,改用 `memory: 'user'`。

用户级偏好(`CLAUDE.md`)与用户级 subagent memory 跨节点正常工作。

## Workspace Snapshot(sandbox cwd 持久化)

启用 sandbox cwd 自动持久化(适用 AGS stateful sandbox):每次 `session.send()` 结束后把工作目录打包上传 COS,下次 `startSession` 时由镜像内部 bootstrap 自动 restore,model 能读到上一轮写入的文件 — 跨进程 / 跨节点都生效。

```typescript
import { createAgent, AgsStatefulSandbox } from '@cloudbase/open-agent-kernel'

const agent = createAgent({
  envId: process.env.TCB_ENV_ID!,
  credentials: {
    envId: process.env.TCB_ENV_ID!,
    secretId: process.env.TENCENTCLOUD_SECRETID!,
    secretKey: process.env.TENCENTCLOUD_SECRETKEY!,
  },
  model: 'claude-opus-4-8',
  sandbox: {
    runtime: new AgsStatefulSandbox({ apiKey: process.env.TCB_API_KEY! }),
    scope: 'shared',         // 必须为 'shared',否则 startSession 抛 ConfigError
    // workspaceSnapshot 默认 'auto',ags-stateful 自动启用
  },
})
```

**关键约束**:`scope: 'shared'`(同 envId 共享容器,跨 session 接续工作目录)。`workspaceSnapshot: 'auto'` 时,只有 ags-stateful 沙箱会启用 — 其他 runtime 自动跳过。`'enabled'` 表示强制启用(非 ags-stateful 会抛 ConfigError),`'disabled'` 关闭。

**触发**:每次 `session.send()` 结束自动 snapshot;失败 yield 一个 warning event(不抹掉 final answer,bootstrap 失败下次启动时 restore 状态可观测,见下文)。

**配置**:
- `sandbox.workspaceSnapshotTimeoutMs`(默认 `30_000`,镜像内部上限 600_000)
- `sandbox.workspaceInitTimeoutMs`(默认 `60_000`,镜像内部上限 1_200_000)

**镜像选型(重要)**:`workspaceSnapshot` 启用时,沙箱镜像必须用 trw **minimal** preset,**不能**用 vibecoding preset。

- vibecoding 镜像在 `/home/user` 下预装 41MB `node_modules.tar.gz` + 349 个 node_modules 子目录(由 `seedCodingTemplate` 在首次 boot 时拷入),snapshot 时 trw `runZstdList` 读取 tar/zstd stderr 撞 1MB 上限抛 `ENOBUFS` → 500。trw 主线 COS 验收只覆盖 minimal preset(参 trw `AGS一条龙.md` §4 Tool 分工 + `infra/vibecoding-sync.md` §72)。
- 配置方式:`OAK_SANDBOX_IMAGE` 环境变量,或 `new AgsStatefulSandbox({ image })`。OAK 默认 fallback 已是 minimal preset 镜像,但业务下游若覆盖了该值,需自检不要回退到 vibecoding tag。
- 标识方法:tag 末尾后缀 `-minimal` / `-magent` / `-vibecoding` / `-full` 表明 preset(参 trw 一条龙 §3 命名规则 `YYMMDD-HHMM-随机-<preset>`)。

**手动 API**(可选):
- `session.snapshotWorkspace()`:手动触发一次 snapshot(超出 send 周期时使用)
- `session.getRestoreStatus()`:查询启动 restore 状态(`'full' | 'fresh' | 'partial' | 'failed' | null`)

详见 `examples/18-workspace-snapshot.ts`(单进程)和 `examples/19-workspace-snapshot-distributed.ts`(跨节点)。

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
