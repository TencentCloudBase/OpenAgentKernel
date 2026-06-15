# @cloudbase/open-agent-kernel

> CloudBase 平台的服务端 Agent SDK。用于创建能对话、持久化、使用 CloudBase 资源、运行沙箱工具并支持人工审批的 AI Agent。

[![npm version](https://img.shields.io/npm/v/@cloudbase/open-agent-kernel)](https://www.npmjs.com/package/@cloudbase/open-agent-kernel)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](./LICENSE)

## 适用场景

Open Agent Kernel（OAK）适合在 Node.js 服务端中构建 CloudBase Agent，例如：

- 给 Web / 小程序 / 管理后台提供流式 AI 对话接口。
- 让 Agent 使用 CloudBase 数据库、云存储、云函数、静态托管等资源。
- 把会话、审批状态、附件、用户长期记忆持久化到 CloudBase。
- 运行远程 sandbox，让 Agent 具备文件系统、Shell、代码执行和 CloudBase MCP 工具能力。
- OAK 本身只提供协议中立的 `AsyncIterable<SessionEvent>`，开发者自行接入 ACP / AG-UI / SSE / 自定义协议。

## 安装

要求 **Node.js >= 22**。

```bash
pnpm add @cloudbase/open-agent-kernel
```

## 准备工作

### SDK 运行时环境变量

OAK 默认模型调用会读取一个运行时环境变量：

```bash
TCB_API_KEY=your-cloudbase-server-api-key
```

`TCB_API_KEY` 是 CloudBase 环境的服务端 APIKey，用于：

- 默认的 CloudBase AI 模型调用。
- 默认的 AGS Sandbox 数据面鉴权。

### 标准 `createAgent` 配置

下面是一份覆盖全部配置项的示例。按需删除或注释掉用不到的字段即可；带默认值的字段通常可以省略。

```typescript
import { createAgent } from '@cloudbase/open-agent-kernel'

// 部署时在进程环境注入 TCB_API_KEY；本地跑 examples 时由 config.local.json 写入
process.env.TCB_API_KEY = 'your-cloudbase-server-api-key'

const agent = createAgent({
  // ── 资源锚点 ─────────────────────────────────────────────
  envId: 'your-env-id', // 必填。默认模型网关、DB、Storage、sandbox 均以此为锚点

  credentials: {
    // 操作 CloudBase DB / Storage / sandbox 控制面时需要
    secretId: 'AKIDxxxxxxxx',
    secretKey: 'xxxxxxxx',
    // sessionToken: '...', // STS 临时凭证（可选）
    // region: 'ap-shanghai', // 地域，默认 ap-shanghai
    // envId 可省略，自动继承顶层 envId
  },

  // ── 模型（必填）──────────────────────────────────────────
  model: 'glm-5.1', // 字符串写法：默认走 CloudBase AI gateway + TCB_API_KEY
  // model: { id: 'custom-model', apiKey: '...', apiBaseUrl: 'https://...' }, // 自带 endpoint
  systemPrompt: 'You are a helpful CloudBase assistant. Reply concisely in Chinese.',

  // ── 会话持久化（有 credentials 时默认启用 CloudBase FlexDB）──
  session: {
    // enabled: true, // false 显式关闭；无 credentials 时不启用
    // tablePrefix: 'oak_', // 表前缀 → oak_sessions / oak_session_entries 等
    // projectKey: 'your-env-id', // 多租户隔离 key，默认 envId
    // database: 'flexdb', // 当前内置 flexdb
    // flush: 'batched', // batched（默认）| eager
  },

  // ── 多模态附件（有 credentials 时默认 CloudBase Storage）────
  storage: {
    // enabled: true,
    // pathPrefix: 'agent-attachments/', // COS 路径：{pathPrefix}{envId}/{sessionId}/...
    // urlExpiresIn: 3600, // 临时 URL 有效期（秒）
  },

  // ── 工具审批 HITL ────────────────────────────────────────
  permissions: {
    // requireApproval: '*', // 需要审批的工具；'*' = 全部，也可传工具名数组或函数
    // tablePrefix: 'oak_', // 审批状态 DB 集合前缀 → oak_state
    // approvalTimeoutMs: 1_800_000, // 审批超时，默认 30 分钟
  },

  // ── 远程 Sandbox ─────────────────────────────────────────
  sandbox: {
    // enabled: true, // 启用 AGS Stateful Sandbox
    // provider: 'ags-stateful',
    // apiKey: process.env.TCB_API_KEY, // AGS 数据面 JWT；默认读 TCB_API_KEY
    // scope: 'shared', // shared（默认，多 session 共享实例）| session（每会话独立实例）
    // ttl: 3600, // 沙箱生命周期（秒）
    // cloudbaseTools: true, // 自动暴露 mcp__cloudbase__* 工具（DB / COS / 云函数等）
    // workspaceSnapshot: 'auto', // cwd 自动快照到 COS；仅 ags-stateful + shared 生效
    // userCredentials: { secretId, secretKey }, // 沙箱内 cloudbase 工具的用户租户凭证
  },

  // ── 工具扩展 ───────────────────────────────────────────────
  // tools: [myTool], // kernel-side 本地工具
  // mcpServers: { calc: calculatorServer }, // MCP server（进程内 / stdio / HTTP）

  // ── Skills / 平台资产 ──────────────────────────────────────
  // cwd: '/app/skills-bundle', // skills 和项目级 CLAUDE.md 扫描根目录
  // skills: { enabled: 'all' }, // 需要 cwd/.claude/skills/ 目录

  // ── 用户长期记忆（需 credentials + COS）────────────────────
  // userMemory: true, // 同步 CLAUDE.md / agent-memory 等到 CloudBase COS

  // ── 生命周期钩子 ───────────────────────────────────────────
  // hooks: { onSessionStart, onUserMessage, onToolStart, onToolEnd, onAgentMessage, onSessionEnd },
})
```


### 跑仓库 examples

```bash
cp packages/open-agent-kernel/examples/config.example.json packages/open-agent-kernel/examples/config.local.json
# 编辑 config.local.json，填入 envId / model / tcbApiKey / credentials
pnpm -F @cloudbase/open-agent-kernel build   # 本地跑 examples 前需先构建 dist
pnpm dlx tsx packages/open-agent-kernel/examples/01-quickstart.ts
```

`config.local.json` 仅供 examples 本地演示，不是 SDK 的强制约定。完整 examples 说明见 [`examples/README.md`](./examples/README.md)。

## 功能接入指南

### 模型配置

最简单写法只传模型 ID。SDK 会自动使用 CloudBase AI gateway 和 `TCB_API_KEY`：

```typescript
createAgent({
  envId,
  model: 'glm-5.1',
})
```

如需接入自带 endpoint / key，可传 `ModelSpec`：

```typescript
createAgent({
  envId,
  model: {
    id: 'custom-model',
    apiKey: process.env.MY_MODEL_API_KEY,
    apiBaseUrl: 'https://example.com/v1/anthropic',
  },
})
```

对应示例：`examples/01-quickstart.ts`、`examples/02-debug.ts`。

### 多轮对话

同一个 `Session` 内直接连续 `send()` 即可保持上下文：

```typescript
const session = await agent.startSession({ userId: 'user-1' })

for await (const event of session.send('我叫小明')) {
  // handle event
}

for await (const event of session.send('还记得我的名字吗？')) {
  // handle event
}
```

对应示例：`examples/03-multi-turn.ts`。

### 会话持久化和跨进程恢复

传入 `credentials` 后，SDK 默认启用 CloudBase FlexDB session store，无需手动 new driver / store：

```typescript
const agent = createAgent({
  envId,
  credentials: { secretId, secretKey },
  model: 'glm-5.1',
  session: {
    tablePrefix: 'my_agent_', // 可选，默认 oak_
  },
})

const session = await agent.startSession({ userId: 'user-1' })
const conversationId = session.id

const resumed = await agent.resumeSession(conversationId)
```

默认集合名：

| 集合 | 用途 |
|------|------|
| `oak_sessions` | Session 索引 |
| `oak_session_entries` | SDK transcript，供 resume 使用 |
| `oak_session_summaries` | Session 摘要 |
| `oak_session_messages` | 消息元数据索引，供 `getHistory()` 分页 |

对应示例：`examples/04-multi-turn-db.ts`、`examples/14-session-history.ts`。

### 消息历史查询

`getHistory()` 返回前端可直接渲染的聚合消息结构。内部会过滤 sentinel、resume prompt 等协议产物，并把 assistant 的 `tool_call` / `tool_result` 配对聚合。

```typescript
const history = await session.getHistory({ limit: 20 })

await session.clearHistory()
```

对应示例：`examples/14-session-history.ts`。

### 多模态附件和 CloudBase Storage

传入 `credentials` 后，发送本地文件附件时默认上传到 CloudBase Storage，并把签名 URL 发送给模型：

```typescript
const agent = createAgent({
  envId,
  credentials: { secretId, secretKey },
  model: 'glm-5v-turbo',
  storage: {
    pathPrefix: 'my-agent/attachments/', // 可选，默认 agent-attachments/
    urlExpiresIn: 3600, // 可选，默认 3600 秒
  },
})

const session = await agent.startSession({ userId: 'user-1' })

for await (const event of session.send({
  type: 'message',
  content: '这张图里有什么？',
  attachments: [{ type: 'file', source: './cloud.png' }],
})) {
  // handle event
}
```

附件支持三种输入：

```typescript
type AttachmentInput =
  | { type: 'file'; source: string | Uint8Array; mimeType?: string }
  | { type: 'url'; url: string; mimeType?: string }
  | { type: 'cos'; fileId: string; mimeType?: string }
```

调试时也可以显式使用 `InMemoryStorage`：

```typescript
import { InMemoryStorage } from '@cloudbase/open-agent-kernel'

createAgent({
  envId,
  model: 'glm-5v-turbo',
  storage: new InMemoryStorage(),
})
```

对应示例：`examples/05-multimodal.ts`。

### MCP 工具扩展

OAK 直接透传 Claude Agent SDK 的 MCP server 配置，工具名规则为 `mcp__{serverName}__{toolName}`。

进程内 SDK Server：

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
  envId,
  model: 'glm-5.1',
  mcpServers: { calc: calculator },
})
```

stdio MCP：

```typescript
createAgent({
  envId,
  model: 'glm-5.1',
  mcpServers: {
    everything: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-everything'],
    },
  },
})
```

远程 HTTP MCP：

```typescript
createAgent({
  envId,
  model: 'glm-5.1',
  mcpServers: {
    remote: {
      type: 'http',
      url: 'https://example.com/mcp/v1',
      headers: { Authorization: 'Bearer xxx' },
    },
  },
})
```

对应示例：`examples/06-mcp-sdk-server.ts`、`examples/07-mcp-stdio.ts`。

### Sandbox 文件系统和 Shell

开启默认 sandbox：

```typescript
const agent = createAgent({
  envId,
  credentials: { secretId, secretKey },
  model: 'glm-5.1',
  sandbox: { enabled: true },
})
```

默认行为：

- provider 为 `ags-stateful`。
- `scope` 默认为 `shared`。
- `apiKey` 不传时读取 `TCB_API_KEY`，也可用 `OAK_SANDBOX_API_KEY` 单独覆盖。
- `cloudbaseTools` 默认 `true`，镜像支持时自动暴露 `mcp__cloudbase__*`。
- 默认 sandbox 镜像可通过环境变量 `OAK_SANDBOX_IMAGE` 覆盖；未设置时使用 SDK 内置 fallback（beta 阶段为开发镜像，生产环境请务必显式配置）。

Agent 会获得这些 sandbox 工具：

| 工具名 | 功能 |
|--------|------|
| `mcp__sandbox__bash` | 执行 Shell 命令 |
| `mcp__sandbox__read` | 读取文件内容 |
| `mcp__sandbox__write` | 写入文件 |
| `mcp__sandbox__edit` | 编辑文件 |
| `mcp__sandbox__glob` | 按 pattern 列出文件 |
| `mcp__sandbox__grep` | 正则搜索文件内容 |

用完建议调用：

```typescript
await session.abort()
```

对应示例：`examples/08-sandbox.ts`、`examples/09-sandbox-shared.ts`。

### Sandbox 内 CloudBase 工具

默认 `sandbox.cloudbaseTools: true`。当镜像内置 mcporter + cloudbase-mcp 时，Agent 会额外获得 CloudBase 工具，例如数据库、云存储、云函数、静态托管等管理能力。

```typescript
createAgent({
  envId,
  credentials: { secretId, secretKey },
  model: 'glm-5.1',
  sandbox: {
    enabled: true,
    cloudbaseTools: true,
  },
})
```

多租户场景下，sandbox 控制面可以使用平台凭证，沙箱内 CloudBase 工具可以使用用户租户凭证：

```typescript
sandbox: {
  enabled: true,
  userCredentials: async () => ({
    envId: userEnvId,
    secretId: userSecretId,
    secretKey: userSecretKey,
  }),
}
```

对应示例：`examples/10-sandbox-cloudbase-tools.ts`。

### HITL 工具审批

配置 `permissions.requireApproval` 后，命中的工具调用会暂停并发出 `tool_approval_required` 事件。

```typescript
const agent = createAgent({
  envId,
  credentials: { secretId, secretKey },
  model: 'glm-5.1',
  sandbox: { enabled: true },
  permissions: {
    requireApproval: ['mcp__sandbox__bash', 'mcp__cloudbase__deleteData'],
    tablePrefix: 'my_agent_', // 可选，默认 oak_
  },
})
```

处理审批：

```typescript
for await (const event of session.send('删除测试数据')) {
  if (event.type === 'tool_approval_required') {
    // 展示审批 UI，并保存 event.toolUseId
  }
}

for await (const event of session.respondApproval({
  toolUseId,
  decision: { kind: 'allow', scope: 'once' },
})) {
  // 审批后继续执行
}
```

有 `credentials` 时默认使用 CloudBase FlexDB permission store，审批状态落到 `{tablePrefix}state`，支持跨进程 / 跨节点 `respondApproval()`。

对应示例：`examples/11-hitl-approval.ts`、`examples/12-hitl-acp-adapter.ts`、`examples/13-hitl-distributed-cloudbase.ts`。

### Skills

`skills` 让底层 Agent SDK 扫描 `cwd/.claude/skills/` 下的 `SKILL.md`。适合平台预置只读能力包。

```typescript
createAgent({
  envId,
  model: 'glm-5.1',
  cwd: '/app/agent-assets',
  skills: {
    enabled: 'all',
  },
})
```

也可以只启用部分 skill：

```typescript
skills: {
  enabled: ['cloudbase-deploy', 'code-review'],
}
```

对应示例：`examples/15-skills.ts`。

### userMemory 用户长期记忆

`userMemory` 用于同步用户私有的 `.claude/` 记忆文件到 CloudBase Storage。

```typescript
const agent = createAgent({
  envId,
  credentials: { secretId, secretKey },
  model: 'glm-5.1',
  userMemory: true,
})
```

可以预置或删除用户记忆文件：

```typescript
import { writeUserMemoryFiles, deleteUserMemoryFiles } from '@cloudbase/open-agent-kernel'

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

同步范围：

- `<CLAUDE_CONFIG_DIR>/CLAUDE.md`
- `<CLAUDE_CONFIG_DIR>/projects/*/memory/`
- `<CLAUDE_CONFIG_DIR>/agent-memory/`

不建议并发处理同一 `userId` 的多个请求。允许跨节点，但上游需要保证同一用户请求串行。

对应示例：`examples/16-user-memory.ts`、`examples/17-user-memory-distributed.ts`。

### Workspace Snapshot

Workspace Snapshot 会在每次 `session.send()` 结束后把 sandbox cwd 打包上传到 COS，并在下次 `startSession` 时自动 restore。

```typescript
const agent = createAgent({
  envId,
  credentials: { secretId, secretKey },
  model: 'glm-5.1',
  sandbox: {
    enabled: true,
    workspaceSnapshot: 'auto',
  },
})
```

常用 API：

```typescript
await session.snapshotWorkspace?.()
const status = await session.getRestoreStatus?.()
```

`status` 可能为：

```typescript
'full' | 'fresh' | 'partial' | 'failed' | null
```

关键注意事项：

- 默认 sandbox 使用 `scope: 'shared'`，`workspaceSnapshot: 'auto'` 仅对 `ags-stateful` runtime 自动启用。
- 真正验证跨进程 restore，应使用 `19a-snapshot-write.ts` 写入并停止实例，再运行 `19b-snapshot-read.ts` 读取。
- 如果自定义 sandbox 镜像，需确认镜像支持 workspace snapshot bootstrap。

对应示例：`examples/18-workspace-snapshot.ts`、`examples/19a-snapshot-write.ts`、`examples/19b-snapshot-read.ts`。

## 完整参数说明

### `createAgent(config)`

| 字段 | 类型 | 必填 | 说明 |
|------|------|:----:|------|
| `envId` | `string` | 是 | CloudBase 环境 ID。默认模型网关、DB、Storage、sandbox 资源都会以它为锚点。 |
| `model` | `string \| ModelSpec` | 是 | 模型 ID 或完整模型配置。字符串写法默认走 CloudBase AI gateway。 |
| `credentials` | `PlatformCredentials` | 使用 CloudBase 资源时 | CloudBase 平台凭证。`envId` 可省略并继承顶层 `envId`。 |
| `systemPrompt` | `string` | 否 | 系统提示词。 |
| `tools` | `ToolDefinition[]` | 否 | Kernel-side 本地工具。 |
| `mcpServers` | `Record<string, McpServerConfig>` | 否 | MCP server 配置，透传给底层 Agent SDK。 |
| `sandbox` | `SandboxConfig` | 否 | 远程 sandbox 配置。 |
| `permissions` | `PermissionConfig` | 否 | HITL 工具审批配置。 |
| `session` | `SessionConfig` | 否 | 会话持久化配置。 |
| `storage` | `StorageConfig` | 否 | 多模态附件存储配置或自定义 `StorageProvider`。 |
| `cwd` | `string` | 否 | 平台资产根目录，影响 skills 和项目级 `CLAUDE.md`。 |
| `skills` | `{ enabled?: 'all' \| string[] }` | 否 | 启用 Agent SDK skills。需要配合 `cwd`。 |
| `userMemory` | `boolean \| { enabled?: boolean }` | 否 | 用户级长期记忆。`true` 是 `{ enabled: true }` 的简写。 |
| `hooks` | `AgentHooks` | 否 | 生命周期钩子。 |
| `handoffs` | `Agent[]` | 否 | 预留。类型已定义，当前未接入底层 SDK。 |
| `metadata` | `Record<string, unknown>` | 否 | 预留。AgentConfig 级元数据，当前未读取。 |
| `name` | `string` | 否 | 可选。仅回显到 `agent.name`，SDK 内部不使用。 |
| `description` | `string` | 否 | 预留。当前未读取。 |

### `PlatformCredentials`

| 字段 | 类型 | 必填 | 说明 |
|------|------|:----:|------|
| `secretId` | `string` | 是 | 腾讯云 SecretId。 |
| `secretKey` | `string` | 是 | 腾讯云 SecretKey。 |
| `envId` | `string` | 否 | CloudBase 环境 ID。不传时继承 `AgentConfig.envId`。 |
| `sessionToken` | `string` | 否 | STS 临时凭证 token。 |
| `region` | `string` | 否 | 地域，默认 `ap-shanghai`。 |

### `ModelSpec`

| 字段 | 类型 | 必填 | 说明 |
|------|------|:----:|------|
| `id` | `string` | 是 | 模型 ID，如 `glm-5.1`。 |
| `apiKey` | `string` | 否 | 自带 key。不传时读取 `TCB_API_KEY`。 |
| `apiBaseUrl` | `string` | 否 | 自带 endpoint。不传时使用 CloudBase AI gateway。 |
| `options` | `Record<string, unknown>` | 否 | 预留给底层 provider 的额外配置。 |

### `SessionConfig`

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `enabled` | `boolean` | 有 `credentials` 时启用 | `false` 可显式关闭默认持久化。 |
| `provider` | `'cloudbase'` | `'cloudbase'` | 持久化资源域。 |
| `database` | `'flexdb' \| 'mongo' \| 'mysql' \| 'pgsql'` | `'flexdb'` | 当前内置实现为 `flexdb`，其他值为未来 CloudBase 数据库扩展预留。 |
| `store` | `unknown` | 自动创建 | 高级自定义 SessionStore。传入后 SDK 不再创建默认 store。 |
| `tablePrefix` | `string` | `'oak_'` | 默认 CloudBase FlexDB 表前缀。 |
| `projectKey` | `string` | `envId` | 多租户隔离 key。 |
| `flush` | `'batched' \| 'eager'` | `'batched'` | 落盘策略。 |

### `PermissionConfig`

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `requireApproval` | `RequireApprovalRule` | 不审批 | 哪些工具调用需要人工审批。 |
| `store` | `PermissionStore` | 有 `credentials` 时为 CloudBase，否则内存 | 高级自定义审批状态存储。 |
| `tablePrefix` | `string` | `'oak_'` | CloudBase FlexDB 表前缀，最终集合为 `{tablePrefix}state`。 |
| `approvalTimeoutMs` | `number` | `1800000` | 审批超时时间，默认 30 分钟。 |

`RequireApprovalRule` 支持：

```typescript
type RequireApprovalRule =
  | string
  | string[]
  | ((ctx: { toolName: string; input: unknown; conversationId: string }) => boolean | Promise<boolean>)
```

示例：

```typescript
permissions: {
  requireApproval: '*',
}

permissions: {
  requireApproval: ['mcp__sandbox__bash', 'mcp__cloudbase__delete*'],
}
```

### `StorageConfig`

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `enabled` | `boolean` | 有 `credentials` 时启用 | `false` 关闭默认 storage。 |
| `provider` | `'cloudbase'` | `'cloudbase'` | 当前内置 provider。 |
| `pathPrefix` | `string` | `'agent-attachments/'` | 上传路径前缀。实际路径为 `{pathPrefix}{envId}/{sessionId}/...`。 |
| `urlExpiresIn` | `number` | `3600` | 临时 URL 有效期，单位秒。 |

也可以传实现了 `resolveAttachment()` 的自定义 provider 实例。

### `SandboxConfig`

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `enabled` | `boolean` | `false` | `true` 时使用默认 `AgsStatefulSandbox`。 |
| `provider` | `'ags-stateful'` | `'ags-stateful'` | 当前内置 sandbox provider。 |
| `apiKey` | `string` | `TCB_API_KEY` / `OAK_SANDBOX_API_KEY` | AGS 数据面 JWT。 |
| `runtime` | `unknown` | 自动创建 | 高级自定义 `SandboxRuntime`。 |
| `scope` | `'session' \| 'shared'` | `'shared'` | AGS 实例粒度。 |
| `ttl` | `number` | runtime 默认 | 沙箱生命周期秒数。 |
| `capabilities` | `SandboxCapabilities` | runtime 默认 | 文件系统 / Shell 能力开关。 |
| `cloudbaseTools` | `boolean` | `true` | 是否自动暴露 `mcp__cloudbase__*` 工具。 |
| `userCredentials` | `SandboxUserCredentials \| () => Promise<SandboxUserCredentials>` | `credentials` | sandbox 内 CloudBase MCP 工具使用的用户租户凭证。 |
| `workspaceSnapshot` | `'auto' \| 'enabled' \| 'disabled'` | `'auto'` | sandbox cwd 自动持久化策略。 |
| `workspaceSnapshotTimeoutMs` | `number` | `30000` | snapshot RPC 超时。 |
| `workspaceInitTimeoutMs` | `number` | `60000` | restore bootstrap 超时。 |

Agent / Session 运行时 API 详见文末 [API 参考](#api-参考)。

## Examples 索引

| Example | 功能 | 关键配置 |
|---------|------|----------|
| `01-quickstart.ts` | 快速开始 | `config.local.json` |
| `02-debug.ts` | 调试事件流 | `config.local.json` |
| `03-multi-turn.ts` | 进程内多轮对话 | `config.local.json` |
| `04-multi-turn-db.ts` | CloudBase session 持久化 / resume | `config.local.json`（含 `credentials`） |
| `05-multimodal.ts` | 图片附件 / Storage | `config.local.json`（CloudBase Storage 模式需要 `credentials`） |
| `06-mcp-sdk-server.ts` | 进程内 MCP | `config.local.json` |
| `07-mcp-stdio.ts` | stdio MCP | `config.local.json` |
| `08-sandbox.ts` | sandbox 文件 / Shell | `config.local.json`（含 `credentials`） |
| `09-sandbox-shared.ts` | shared sandbox | `config.local.json`（含 `credentials`） |
| `10-sandbox-cloudbase-tools.ts` | sandbox 内 CloudBase MCP | `config.local.json`（含 `credentials`） |
| `11-hitl-approval.ts` | 单进程 HITL | `config.local.json` |
| `12-hitl-acp-adapter.ts` | ACP 风格审批适配 | `config.local.json` |
| `13-hitl-distributed-cloudbase.ts` | 分布式 HITL | `config.local.json`（含 `credentials`） |
| `14-session-history.ts` | 历史查询 / 聚合验证 | `config.local.json` |
| `15-skills.ts` | Skills | `config.local.json` |
| `16-user-memory.ts` | userMemory 单进程 | `config.local.json`（含 `credentials`） |
| `17-user-memory-distributed.ts` | userMemory 跨节点 | `config.local.json`（含 `credentials`） |
| `18-workspace-snapshot.ts` | workspace snapshot 单进程 | `config.local.json`（含 `credentials`） |
| `19a-snapshot-write.ts` / `19b-snapshot-read.ts` | workspace snapshot 跨进程 restore | `config.local.json`（含 `credentials`） |

运行方式：

```bash
pnpm dlx tsx packages/open-agent-kernel/examples/01-quickstart.ts
```

完整 examples 说明见 [`examples/README.md`](./examples/README.md)。

## API 参考

OAK 的核心使用模式是：`createAgent()` 创建 Agent → `startSession()` / `resumeSession()` 获取 Session → `session.send()` 消费事件流。以下列出公开运行时 API。

### `createAgent(config): Agent`

根据 `AgentConfig` 创建 Agent 实例。配置字段见上文「标准 createAgent 配置」和「完整参数说明」。

### `Agent`

`createAgent()` 返回的 Agent 对象：

| 成员 | 类型 | 说明 |
|------|------|------|
| `id` | `string` | Agent **实例** ID（`randomUUID()` 生成，只读）。SDK 内部不用于路由或持久化；供业务层区分同进程内多个 `createAgent()` 返回值，例如挂到自有注册表、日志关联、多租户 Agent 池。 |
| `name` | `string \| undefined` | `AgentConfig.name` 的回显（只读）。SDK 内部不使用；业务可自行读取做展示。 |
| `startSession(opts)` | `(opts: SessionStartOptions) => Promise<Session>` | 创建新会话。 |
| `resumeSession(id)` | `(stateJsonOrConversationId: string) => Promise<Session>` | 恢复已有会话。 |
| `sessions` | `SessionManagement` | 会话列表 / 查询 / 删除。 |

> **注意**：`agent.id` 与 `session.id`（conversationId）是两套标识。前者标识 Agent 配置实例，后者标识一次对话；跨进程恢复用的是 `session.id`。

#### `startSession(opts)`

创建新会话并返回 `Session` 对象。

```typescript
const session = await agent.startSession({
  userId: 'user-1', // 必填，用户标识
  conversationId: 'conv-xxx', // 可选，指定会话 ID；不传则自动生成
  // title / metadata：类型已定义，当前 registerSession 尚未写入 DB，预留字段
})
```

启用 session 持久化（默认有 `credentials` 时自动启用）后，会话 transcript 会写入 CloudBase FlexDB，可通过 `session.id` 跨进程恢复。

#### `resumeSession(stateJsonOrConversationId)`

恢复已有会话。参数为 **conversationId**（即 `session.id`），从 DB 拉取 transcript 后继续对话。需要配置 `session.store`（有 `credentials` 时默认启用）。

> 类型签名中的 `stateJsonOrConversationId` 预留了 RunState JSON 恢复能力，但当前实现仅按 conversationId 处理。

```typescript
// 跨进程恢复（conversationId）
const session = await agent.resumeSession('conv-abc123')

// 同进程多轮（03-multi-turn.ts 演示的是同一 Session 对象连续 send，无需 resume）
for await (const event of session.send('还记得上一轮的内容吗？')) {
  // handle event
}
```

#### `agent.sessions`（`SessionManagement`）

管理已持久化的会话元数据（需要 session store）：

| 方法 | 签名 | 说明 |
|------|------|------|
| `list` | `(opts?) => Promise<SessionSummary[]>` | 列出会话（beta：`userId` / `cursor` 过滤尚未实现）。 |
| `get` | `(conversationId) => Promise<SessionSummary \| null>` | 查询单个会话摘要（beta：当前恒返回 `null`）。 |
| `delete` | `(conversationId) => Promise<void>` | 删除会话记录。 |

```typescript
const summaries = await agent.sessions.list({ userId: 'user-1', limit: 20 })
await agent.sessions.delete(session.id)
```

### `Session`

`startSession()` / `resumeSession()` 返回的会话对象：

| 成员 | 类型 | 说明 |
|------|------|------|
| `id` | `string` | 会话 ID / conversationId（只读）。 |
| `userId` | `string` | 所属用户 ID（只读）。 |
| `send(input)` | `(input) => AsyncIterable<SessionEvent>` | 发送用户消息，返回事件流。 |
| `respondApproval(opts)` | `(opts) => AsyncIterable<SessionEvent>` | 注入 HITL 审批决策后继续运行。 |
| `getHistory(opts?)` | `() => Promise<MessageRecord[]>` | 获取聚合后的历史消息（供 UI 渲染）。 |
| `clearHistory()` | `() => Promise<void>` | 清除消息元数据索引，不影响 SDK transcript。 |
| `getState()` | `() => Promise<string>` | 序列化当前 RunState 为 JSON。 |
| `abort()` | `() => Promise<void>` | 中止当前运行并释放 sandbox 等资源。 |
| `snapshotWorkspace?()` | `() => Promise<{ ms; skipped? }>` | 手动触发 workspace snapshot（sandbox 启用时）。 |
| `getRestoreStatus?()` | `() => Promise<'full' \| 'fresh' \| 'partial' \| 'failed' \| null>` | 查询 workspace restore 状态。 |

#### `send(input)`

发送用户消息并消费事件流。`input` 支持：

- **字符串糖**：`'你好'` 等价于 `{ type: 'message', content: '你好' }`
- **消息 + 附件**：`{ type: 'message', content: '...', attachments: [...] }`
- **工具结果回灌**：`{ type: 'tool_result', toolUseId, output }`（客户端执行工具后回传）

```typescript
// 文本消息
for await (const event of session.send('你好')) {
  if (event.type === 'message_delta') process.stdout.write(event.text)
  if (event.type === 'session_idle') break // 本轮结束
}

// 带附件
for await (const event of session.send({
  type: 'message',
  content: '这张图里有什么？',
  attachments: [{ type: 'file', source: './image.png' }],
})) {
  // handle event
}
```

同一 `Session` 对象内连续 `send()` 即保持多轮上下文（见 `examples/03-multi-turn.ts`）。跨进程需 `resumeSession(conversationId)`（见 `examples/04-multi-turn-db.ts`）。

#### `respondApproval(opts)`

收到 `tool_approval_required` 事件后，收集用户决策并继续运行：

```typescript
for await (const event of session.send('删除这个集合')) {
  if (event.type === 'tool_approval_required') {
    for await (const resumed of session.respondApproval({
      toolUseId: event.toolUseId,
      decision: { kind: 'allow', scope: 'once' }, // kind: allow | deny；scope: once | session | forever
    })) {
      // 决策注入后的后续事件
    }
  }
}
```

#### `getHistory()` / `clearHistory()`

```typescript
const history = await session.getHistory({ limit: 20, before: 1700000000000 })
await session.clearHistory() // 仅清 UI 索引，不影响对话上下文
```

#### `abort()` / workspace snapshot

```typescript
await session.abort() // 中止运行；sandbox scope=session 时会 Pause 实例

await session.snapshotWorkspace?.() // 手动触发 cwd 快照
const status = await session.getRestoreStatus?.() // 'full' | 'fresh' | 'partial' | 'failed' | null
```

### `SessionEvent`

`send()` 和 `respondApproval()` 返回的 `AsyncIterable<SessionEvent>` 中，常见事件类型：

| 事件 | 含义 | 典型处理 |
|------|------|----------|
| `message_delta` | 模型输出增量文本 | 流式渲染到 UI |
| `message_complete` | 模型输出完整文本 | 落盘 / 展示最终回复 |
| `tool_call` | Agent 发起工具调用 | 展示工具名和参数 |
| `tool_result` | 工具执行结果 | 展示工具输出 |
| `tool_approval_required` | 工具需要人工审批 | 调 `respondApproval()` |
| `handoff` | 子 Agent 切换 | 展示 handoff 信息 |
| `session_idle` | 本轮运行结束 | `reason`: `completed` / `requires_action` / `aborted` / `error` |
| `error` | 运行错误 | 展示 `error.message` |

```typescript
type SessionEvent =
  | { type: 'message_delta'; text: string }
  | { type: 'message_complete'; text: string }
  | { type: 'tool_call'; toolUseId: string; toolName: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; toolName: string; output: unknown; isError: boolean }
  | { type: 'tool_approval_required'; toolUseId: string; toolName: string; input: unknown; runStateJson: string; hints?: {...} }
  | { type: 'handoff'; fromAgent: string; toAgent: string }
  | { type: 'session_idle'; reason: 'completed' | 'requires_action' | 'aborted' | 'error' }
  | { type: 'error'; error: Error }
```

OAK 只提供协议中立的 `AsyncIterable<SessionEvent>`；接入 SSE / ACP / AG-UI 时由业务层做事件映射。

## 常见问题

### 为什么需要 `TCB_API_KEY`？

模型调用默认走 CloudBase AI gateway，`TCB_API_KEY` 是服务端 APIKey。部署时在进程环境中设置；跑 examples 时写入 `config.local.json` 的 `tcbApiKey` 字段即可。

### 什么时候需要 `credentials`？

只要要让 SDK 直接操作 CloudBase 资源，就需要传 `credentials`。例如 session 持久化、CloudBase Storage、分布式审批、userMemory、sandbox 控制面。

### `TCB_API_KEY` 和 `TENCENTCLOUD_SECRETID/SECRETKEY` 是一回事吗？

不是。`TCB_API_KEY` 是 CloudBase 服务端 APIKey，主要用于模型网关和 sandbox 数据面。`TENCENTCLOUD_SECRETID/SECRETKEY` 是腾讯云平台凭证，用于 CloudBase Node SDK / Manager SDK 管理资源。

### 为什么传了 `credentials` 后自动多了 DB / Storage 行为？

OAK 的目标是让 CloudBase 资源成为默认生产路径。传入 `credentials` 后：

- 默认启用 CloudBase FlexDB session store。
- 默认启用 CloudBase Storage 处理附件。
- 当配置了 `permissions.requireApproval` 时，默认启用 CloudBase permission store。

这些都可以通过 `session.enabled: false`、`storage.enabled: false` 或显式传自定义 store/provider 覆盖。

## License

Apache-2.0
