# @cloudbase/open-agent-kernel 交接文档

> 最后更新：2026-06-04 16:37 | 分支：`feat/support-open-agent-kernel` | 版本：`0.2.0-alpha.0`

---

## v0.2.0 — cwd / skills / userMemory (Spec A)

**新增公共 API**:
- `AgentConfig.cwd?: string` — 平台资产根目录(skills + 项目 CLAUDE.md)
- `AgentConfig.skills?: { enabled?: 'all' | string[] }` — SDK skills 透传
- `AgentConfig.userMemory?: { enabled?: boolean }` — 用户级长期记忆(基于 SDK 原生 `.claude/` + COS 同步)

**破坏性改动**(从未生效字段,可接受):
- 删除 `SandboxCapabilities.skills` / `.memory` / `.compaction`
- 删除 `CompactionConfig` interface

**新增 internal 模块**:`src/claude-home/`(同步引擎 / store / 工具)— 不公开 export。

**新增 examples**:`15-skills.ts` / `16-user-memory.ts` / `17-user-memory-distributed.ts`

**测试**:`pnpm test` 跑 5 套单元测试(path-derivation / sync-rules / in-memory-store / sync-engine / agent-builder),共 48 个 case。

**Spec**:`docs/superpowers/specs/2026-06-01-oak-cwd-skills-user-memory-design.md`(commit `2968bdd`)。

**已知限制**(可在 V2 评估补齐):
- **项目级 subagent memory 不同步**:`<cwd>/.claude/agent-memory/<agent>/MEMORY.md`(SDK `memory: 'project'` 配置)目前不在 SYNC_INCLUDES 范围,跨节点不持久化。需要的业务方暂时改用 `memory: 'user'`(走 `<CLAUDE_CONFIG_DIR>/agent-memory/`,该路径已同步)。
- **默认 ephemeral cwd 是 process-level 随机的**:不传 `cwd` 时,SDK 把项目级 auto-memory 写到 `<CLAUDE_CONFIG_DIR>/projects/<random-hash>/memory/`。跨节点 hash 不一致,**项目级主会话 auto-memory 跨节点不可复用**。要复用请传一个稳定的 `cwd`(业务镜像内固定路径)。**用户级 CLAUDE.md 与 user-level subagent memory 不受影响,跨节点正常工作**。
- **CloudBaseCosClaudeHomeStore 缺 mock 单测**:目前仅集成层(example 16/17)验证。建议在 V2 加 mock 单测覆盖 key pattern / assertSafeKey / delete-404。
- **session.send / runClaudeQuery 缺 sync-hook 集成测**:try/finally 触发 push 这条不变量目前没单测验证,只靠 spec compliance review 确认。建议 V2 加。

---

## 一、项目定位

**`@cloudbase/open-agent-kernel`** 是一个**服务端 Agent SDK**，面向 CloudBase 平台开发者。

核心能力：
- 封装 `@anthropic-ai/claude-agent-sdk`（Anthropic 官方 Agent SDK），屏蔽底层细节
- 以 `envId` 为锚点，原生集成 CloudBase 资源（DB / Storage / 云函数 / 沙箱 / MCP）
- 提供 `createAgent()` 工厂函数，一行代码创建带 CloudBase 能力的 Agent

运行环境：Node.js 22+，ESM，与用户业务代码同进程。

---

## 二、架构总览

```
用户代码
  └─ createAgent(config)
       ├─ Session（会话实例，含 send / getHistory / respondApproval / abort）
       │    └─ runClaudeQuery() → Claude Agent SDK → 流式 SDKMessage
       │         └─ event-translator.ts → SessionEvent（message_delta / tool_call / tool_result / ...）
       │
       ├─ SessionStore（可选，持久化会话）
       │    └─ CloudBaseSessionStore → SessionStoreDriver
       │         ├─ InMemoryDriver（测试/本地）
       │         └─ CloudBaseDbDriver（生产，落 CloudBase DB）
       │
       ├─ Sandbox（可选，远程容器）
       │    └─ AgsStatefulSandbox → AGS 控制面 + TRW 数据面
       │         ├─ sandbox-tools.ts → 6 个文件系统/Shell 工具
       │         └─ cloudbase-mcp.ts → CloudBase MCP 工具集
       │
       └─ Permissions（可选，HITL 工具审批）
            └─ InMemoryPermissionStore / CloudBasePermissionStore
                 └─ hooks.ts → PreToolUse hook（流终止 + resume 范式）
```

---

## 三、目录结构

```
src/
├── index.ts                          # 主入口，聚合所有公共导出
├── public/
│   ├── types.ts                      # 公共 API 类型契约（~700 行，对外稳定契约）
│   └── create-agent.ts              # createAgent() 工厂函数 + Session 内部实现
├── runtime/
│   ├── agent-builder.ts             # buildClaudeQueryOptions（薄封装 Claude SDK）
│   ├── credential-factory.ts        # model → ANTHROPIC_BASE_URL / AUTH_TOKEN
│   ├── event-translator.ts          # SDKMessage → SessionEvent 翻译
│   └── prompt-builder.ts            # system prompt 构建
├── resources/
│   ├── credential-provider.ts       # TokenHub 凭证加载
│   └── name-resolver.ts             # envId → 集合名/函数名/网关 URL 派生
├── session-store/
│   ├── cloudbase-session-store.ts   # CloudBaseSessionStore（SDK 协议层适配）
│   └── drivers/
│       ├── types.ts                 # SessionStoreDriver 接口定义
│       ├── in-memory-driver.ts      # InMemoryDriver（测试/本地）
│       └── cloudbase-db-driver.ts   # CloudBaseDbDriver（生产）
├── storage/
│   ├── types.ts                     # StorageProvider 接口
│   ├── in-memory-storage.ts         # InMemoryStorage（base64）
│   ├── cloudbase-storage.ts         # CloudBaseStorage（上传云存储）
│   └── mime.ts                      # MIME 类型处理
├── sandbox/
│   ├── types.ts                     # SandboxRuntime / SandboxInstance 接口
│   ├── ags-stateful-sandbox.ts      # AgsStatefulSandbox 实现
│   ├── sandbox-tools.ts             # 6 个 sandbox 工具
│   └── cloudbase-mcp.ts             # CloudBase MCP 工具集封装
├── permissions/
│   ├── store.ts                     # InMemoryPermissionStore
│   ├── cloudbase-permission-store.ts # CloudBasePermissionStore
│   ├── hooks.ts                     # PreToolUse Hook 实现
│   └── drivers/                     # PermissionStoreDriver 接口 + 实现
└── internal/
    └── errors.ts                    # 6 个错误类型
```

---

## 四、核心模块详解

### 4.1 createAgent() — 入口函数

**文件**: `src/public/create-agent.ts`

```typescript
const agent = createAgent({
  envId: 'your-env-id',                    // 必填
  model: 'glm-5.1',                        // 必填（默认用 glm-5.1，不要用 deepseek 系列）
  systemPrompt: 'You are a helpful assistant.',
  session: { store: sessionStore, projectKey: envId },  // 可选：持久化
  sandbox: { runtime: new AgsStatefulSandbox() },        // 可选：沙箱
  permissions: { requireApproval: [...] },               // 可选：HITL
})
```

返回 `Agent` 接口：
- `startSession(opts)` → 创建新会话
- `resumeSession(conversationId)` → 恢复已有会话
- `sessions.list()` / `sessions.delete()` → 会话管理

### 4.2 Session — 会话实例

**文件**: `src/public/create-agent.ts`（内部 `createSession()`）

核心方法：
- `send(input)` → `AsyncIterable<SessionEvent>`（流式事件）
- `getHistory(opts)` → `MessageRecord[]`（消息历史查询）
- `respondApproval(opts)` → 注入审批决策并 resume
- `abort()` → 终止会话 + 释放沙箱
- `getState()` → JSON 序列化的会话引用

### 4.3 SessionEvent — 流式事件类型

```typescript
type SessionEvent =
  | { type: 'message_delta'; text: string }
  | { type: 'tool_call'; toolUseId: string; toolName: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; output: unknown; isError: boolean }
  | { type: 'session_idle'; reason: 'completed' | 'aborted' | 'error' }
  | { type: 'error'; error: Error }
```

### 4.4 SessionStore — 会话持久化

**接口**: `SessionStore`（Claude Agent SDK 定义）

**实现**: `CloudBaseSessionStore` → 桥接到 `SessionStoreDriver`

**Driver 接口** (`session-store/drivers/types.ts`):
- `appendEntries(key, entries)` — 写入 transcript entries
- `loadEntries(key)` — 读取 entries
- `appendSessionMessage(key, entries)` — **双写**消息元数据到 `session_messages`
- `querySessionMessages(projectKey, conversationId, opts)` — 查询消息元数据
- `deleteSession(key)` / `deleteSessionMessages(key)` — 删除
- `listSessions(projectKey)` / `listSummaries(projectKey)` — 列表
- `upsertSummary(args)` — 更新 summary
- `listSubkeys(key)` — 列出子路径

**CloudBase DB 集合**（前缀 `oak_`）：
- `oak_sessions` — session 索引
- `oak_session_entries` — transcript entries（`entry` 字段存完整 SessionStoreEntry）
- `oak_session_summaries` — session summaries
- `oak_session_messages` — 消息元数据索引（PR #4.6 双写）

### 4.5 Sandbox — 远程沙箱

**实现**: `AgsStatefulSandbox`（`sandbox/ags-stateful-sandbox.ts`）

生命周期：
```
acquire() → CreateSandboxTool + StartSandboxInstance → SandboxInstance
  ├─ exec(command) — 执行 bash
  ├─ readFile(path) / writeFile(path, content) — 文件操作
  └─ release() → PauseSandboxInstance
```

工具注入：
- `mcp__sandbox__bash/read/write/edit/glob/grep` — 文件系统/Shell
- `mcp__cloudbase__*` — CloudBase 资源（DB/COS/云函数/静态托管，需凭证）

### 4.6 Permissions — HITL 工具审批

**范式**: 流终止 + 重新进入（跨进程友好）

```
send() → PreToolUse hook 检测到 requireApproval → 发 approval_required 事件 → 流终止
  ↓
业务层展示给用户，收集决策
  ↓
respondApproval({ toolUseId, decision }) → 权限写入 store → resume agent
  ↓
PreToolUse hook 从 store 读到决策 → 放行/拒绝
```

---

## 五、公共类型（`src/public/types.ts`）

核心类型：
- `Agent` / `Session` — Agent 和会话接口
- `AgentConfig` — createAgent 配置
- `SessionEvent` — 流式事件
- `MessageRecord` / `MessagePart` — 消息记录和部件
- `SessionStoreDriver` / `SessionMessageMeta` — 存储驱动接口
- `SandboxRuntime` / `SandboxInstance` — 沙箱接口
- `StorageProvider` — 存储接口
- `PermissionStore` / `ApprovalDecision` — 权限接口

`MessagePart` 联合类型：
```typescript
type MessagePart =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'image'; mimeType: string; ref: ImageRef }
  | { type: 'tool_call'; toolUseId: string; toolName: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; output: unknown; isError: boolean }
  | { type: 'tool_approval_required'; toolUseId: string; toolName: string; input: unknown }
```

---

## 六、示例清单

| # | 文件 | 功能 |
|---|---|---|
| 01 | `01-quickstart.ts` | 最简对话（无沙箱/无持久化） |
| 02 | `02-debug.ts` | OAK_DEBUG 调试日志 |
| 03 | `03-multi-turn.ts` | 多轮对话 |
| 04 | `04-multi-turn-db.ts` | 多轮对话 + CloudBase DB 持久化 |
| 05 | `05-multimodal.ts` | 多模态图片输入 |
| 06 | `06-mcp-sdk-server.ts` | 进程内 MCP SDK server |
| 07 | `07-mcp-stdio.ts` | stdio MCP server |
| 08 | `08-sandbox.ts` | AGS 沙箱（文件系统/Shell） |
| 09 | `09-sandbox-shared.ts` | 共享沙箱模式 |
| 10 | `10-sandbox-cloudbase-tools.ts` | 沙箱 + CloudBase MCP 工具 |
| 11 | `11-hitl-approval.ts` | HITL 工具审批 |
| 12 | `12-hitl-acp-adapter.ts` | HITL + ACP 适配 |
| 13 | `13-hitl-distributed-cloudbase.ts` | 分布式 HITL（CloudBase DB） |
| 14 | `14-session-history.ts` | getHistory 综合演示（对话 + MCP 工具 + HITL 审批 + 原始数据结构 + clearHistory） |

运行方式：
```bash
pnpm dlx tsx packages/open-agent-kernel/examples/XX-xxx.ts
```

---

## 七、最近修复的关键 Bug（PR #4.6 双写机制）

### Bug 1: `oak_session_messages` 表写入空数据

**根因**: `entry.data` 是 `undefined`，实际 SDKMessage 存储在 `entry` 本身。

**修复**: `cloudbase-db-driver.ts` 和 `in-memory-driver.ts` 中：
```typescript
// 修复前（错误）
const sdkMsg = typeof entry.data === 'string' ? JSON.parse(entry.data) : entry.data

// 修复后（正确）
const sdkMsg = entry
```

### Bug 2: `getHistory()` 返回 0 条消息

**根因**: `sdkMsg.timestamp` 是 ISO 字符串（如 `"2026-05-28T09:35:25.876Z"`），但 `querySessionMessages` 过滤条件要求 `typeof row['createdAt'] === 'number'`。

**修复**: 写入时转换为数字时间戳：
```typescript
let createdAt: number
if (typeof sdkMsg.timestamp === 'string') {
  createdAt = new Date(sdkMsg.timestamp).getTime()
} else if (typeof sdkMsg.timestamp === 'number') {
  createdAt = sdkMsg.timestamp
} else if (typeof entry.createdAt === 'number') {
  createdAt = entry.createdAt
} else {
  createdAt = now
}
```

### Bug 3: `getHistory()` 只返回 assistant 消息，不返回 user 消息

**根因**: User 消息的 `content` 是纯字符串，但 `extractMessageParts` 只处理了数组类型。

**修复**: `create-agent.ts` 中增加字符串 content 处理：
```typescript
const content = (sdkMsg.message as { content?: unknown[] | string })?.content
if (typeof content === 'string' && content.length > 0) {
  parts.push({ type: 'text', text: content })
  return parts
}
```

### 涉及文件

| 文件 | 修改内容 |
|---|---|
| `session-store/drivers/cloudbase-db-driver.ts` | Bug 1 + Bug 2 + 调试日志 + CommandPredicate 类型 |
| `session-store/drivers/in-memory-driver.ts` | Bug 1 + Bug 2 |
| `public/create-agent.ts` | Bug 1 + Bug 3 + getHistory() 调试日志 |
| `session-store/cloudbase-session-store.ts` | 调试日志 |

---

## 八、最近改进（2026-05-28）

### 1. 删除 `history-store/` 模块

`history-store/` 只有接口定义，从未实现。双写机制（PR #4.6）已覆盖同样需求（`oak_session_messages` 索引 + `getHistory()` 现场翻译）。已删除。

### 2. `getHistory()` 分页优化

**新增方法**: `SessionStoreDriver.loadEntriesByMessageIds(key, messageIds)`

**修改前**: `getHistory()` 调 `loadEntries()` 加载整个 session 的所有 entries → O(session_size)

**修改后**: 先从 `querySessionMessages` 拿到分页后的 messageIds，再调 `loadEntriesByMessageIds` 只加载匹配条目 → O(page_size)

CloudBase DB 实现使用 `db.command.in()` 批量查询（每批 20 条）。

### 3. 新增 `session.clearHistory()`

```typescript
await session.clearHistory()
```

仅清除 `oak_session_messages` 消息元数据索引，不影响 SDK transcript（session 仍可继续对话）。用途：用户在 UI 上"清除聊天记录"但保留对话上下文。

### 4. 持久化 userId 到 `oak_sessions` 表

**新增方法**: `SessionStoreDriver.registerSession({ projectKey, sessionId, userId, title?, metadata? })`

- 在 `session.startSession()` 时自动调用（非阻塞，`.catch()` 吞错误）
- `listSessions()` 现在返回 `{ sessionId, mtime, userId? }`
- `CloudBaseSessionStore.registerSession()` 也独立暴露供高阶用户调用

**`oak_sessions` 表新增字段**:
```json
{
  "userId": "demo-user",
  "title": null,
  "metadata": null
}
```

### 5. `getHistory()` 聚合与过滤（2026-05-29）

`getHistory()` 返回的 `MessageRecord[]` 经过 `aggregateHistory()` 后处理，确保前端拿到干净、可直接渲染的数据：

**聚合规则：**

| 原始数据 | 处理方式 |
|----------|---------|
| User 消息只含 tool_result | 按 toolUseId 合并到 assistant 的 tool_call 后 → 排除 user 消息 |
| User 消息含 `__OAK_INTERRUPT__` | 排除（HITL sentinel） |
| User 消息 `[系统通知]` 开头 | 排除（resume prompt） |
| `oak_pending_approval_in_turn` tool_result | 排除（同轮保护） |
| 被 HITL 中断且从未被 respond 的 tool_call | 排除（abandoned，无用户价值） |
| 连续多条 assistant 消息 | 合并为一条（parts 拼接），保证严格 user→assistant 交替 |

**最终输出格式：**
```json
[
  { "role": "user", "parts": [{ "type": "text", "text": "请查询..." }] },
  { "role": "assistant", "parts": [
    { "type": "tool_call", "toolName": "glob", "input": {} },
    { "type": "tool_result", "toolUseId": "...", "output": [...] },
    { "type": "text", "text": "查询完成！..." }
  ]}
]
```

前端直接遍历 `parts` 渲染即可：text → 文字气泡，tool_call+tool_result → 工具执行卡片。

### 6. 修复 SDK 权限系统冲突

**问题**: 配置 HITL (`permissions.requireApproval`) 后，SDK 内置权限系统拦截所有工具（包括不需审批的）。

**修复**: `agent-builder.ts` 始终 `permissionMode: 'bypassPermissions'`，由 PreToolUse Hook 全权负责审批逻辑。

---

## 九、环境变量

### 必填

| 变量 | 说明 |
|---|---|
| `TCB_ENV_ID` | CloudBase 环境 ID |
| `TENCENTCLOUD_TOKENHUB_API_KEY` | 模型凭证（TokenHub） |
| `TCB_SECRET_ID` | CloudBase 控制面 AK |
| `TCB_SECRET_KEY` | CloudBase 控制面 SK |

### 可选

| 变量 | 说明 |
|---|---|
| `TCB_API_KEY` | 沙箱数据面长期 JWT |
| `TCB_TOKEN` | STS 临时凭证 token |
| `TCB_REGION` | 区域（默认 `ap-shanghai`） |
| `OAK_DEBUG` | 设为 `1` 启用调试日志 |
| `CLOUDBASE_AGENT_MODEL` | 覆盖默认模型 |

### 凭证模式

TokenHub Anthropic 协议接入文档：https://cloud.tencent.com/document/product/1823/130079

**模型选择规则**（重要）：
- 默认模型一律使用 `glm-5.1`
- 实测在 TokenHub Anthropic 协议下请求不通的模型：`deepseek-v3.1-terminus`、`deepseek-r1-0528`

---

## 十、开发规范

### 提交前必须执行

```bash
pnpm format       # Prettier 格式化
pnpm type-check   # TypeScript 类型检查
pnpm lint         # ESLint
```

### 日志规范

所有 log 语句**只允许静态字符串**，绝不包含动态值（安全规则）。

```typescript
// ✗ 禁止
console.log(`Task created: ${taskId}`)

// ✓ 正确
console.log('[Agent] Task created')
```

调试日志统一使用 `OAK_DEBUG` 环境变量保护：
```typescript
if (process.env.OAK_DEBUG === '1') {
  console.error('[oak][模块名] 静态描述')
}
```

### 代码风格

- ESM，`type: "module"`
- TypeScript strict mode
- 文件名 kebab-case
- 导出接口用 `export interface`，类型用 `export type`
- 内部模块不从 `index.ts` 导出（保持公共 API 精简）

### 错误类型

6 个自定义错误类型（`internal/errors.ts`）：
- `KernelError` — 基类
- `InvalidConfigError` — 配置错误
- `ResourceError` — 资源不存在/不可用
- `StorageError` — 存储操作失败
- `SandboxError` — 沙箱操作失败
- `NotImplementedError` — 未实现

---

## 十一、CloudBase DB 集合结构

### `oak_session_entries`（transcript entries）

```json
{
  "_id": "auto",
  "sessionKey": "projectKey|sessionId",
  "projectKey": "env-id",
  "sessionId": "conversation-id",
  "subpath": null | "string",
  "seq": 1685264125876000,  // 排序键（now * 1000 + i）
  "uuid": "entry-uuid",     // 幂等键
  "type": "assistant" | "user" | "system" | "tool_use" | "tool_result" | ...,
  "entry": { /* 完整 SessionStoreEntry */ },
  "createdAt": 1685264125876
}
```

### `oak_session_messages`（消息元数据索引）

```json
{
  "_id": "auto",
  "sessionKey": "projectKey|sessionId",
  "projectKey": "env-id",
  "conversationId": "conversation-id",
  "messageId": "msg-xxx",
  "role": "user" | "assistant",
  "createdAt": 1685264125876,  // 数字时间戳（非 ISO 字符串）
  "status": "done",
  "mtime": 1685264125876
}
```

### `oak_sessions`（session 索引）

```json
{
  "_id": "auto",
  "sessionKey": "projectKey|sessionId",
  "projectKey": "env-id",
  "sessionId": "conversation-id",
  "userId": "demo-user",
  "title": null,
  "metadata": null,
  "mtime": 1685264125876,
  "createdAt": 1685264125876
}
```

### `oak_session_summaries`

```json
{
  "_id": "auto",
  "projectKey": "env-id",
  "sessionId": "conversation-id",
  "mtime": 1685264125876,
  "data": { /* foldSessionSummary 产出 */ }
}
```

### `oak_state`（统一临时状态表）

所有短生命周期的临时数据收敛到此表，通过 `type` 字段区分用途。
当前 type: `permission`（HITL 审批状态）。未来可扩展 `sandbox_ref`、`lock` 等。

```json
{
  "_id": "auto",
  "projectKey": "env-id",
  "type": "permission",
  "key": "conversationId|toolUseId",
  "conversationId": "conversation-id",
  "toolUseId": "tool-use-id",
  "toolName": "mcp__sandbox__bash",
  "data": {
    "conversationId": "conversation-id",
    "toolUseId": "tool-use-id",
    "toolName": "mcp__sandbox__bash",
    "toolInput": { "command": "rm -rf /" },
    "createdAt": 1685264125876,
    "decision": null | { "kind": "allow", "scope": "once" }
  },
  "createdAt": 1685264125876,
  "expiresAt": 1685265925876,
  "mtime": 1685264125876
}
```

**索引建议：**
1. `(projectKey, type, key)` — 主键查询
2. `(projectKey, type, conversationId, toolName, createdAt desc)` — scanRecent
3. `(expiresAt)` — 批量清理过期条目

---

## 十二、待办事项 / 已知问题

### 待完善

1. ~~**`history-store/` 模块**~~ — ✅ 已删除（双写机制已覆盖需求）
2. ~~**`getHistory()` 分页**~~ — ✅ 已优化（`loadEntriesByMessageIds` 避免全量扫描）
3. ~~**`oak_session_messages` 清理**~~ — ✅ 已暴露 `session.clearHistory()` 方法
4. ~~**`listSessions()` 返回结构**~~ — ✅ 已通过 `registerSession` 持久化 userId
5. **`resumeSession()` 实现** — 当前 SDK 层 resume 能工作（transcript 由 SDK 加载），但 kernel 层 userId 硬编码为 `'resumed'`、沙箱/权限状态未恢复（低优先级）

### 技术债

1. `cloudbase-db-driver.ts` 的 `gtCommand()` / `ltCommand()` 每次都动态加载 CloudBase SDK 获取 `db.command`，可缓存
2. `extractMessageParts()` 中 `sdkMsg.message as { content?: unknown[] | string }` 类型断言链过长，应定义 SDKMessage 类型

---

## 十三、依赖关系

### 运行时依赖

| 包 | 说明 |
|---|---|
| `@anthropic-ai/claude-agent-sdk` | Anthropic Agent SDK（核心引擎） |
| `@cloudbase/node-sdk` | CloudBase Node SDK（peer dep，按需加载） |

### 开发依赖

| 包 | 说明 |
|---|---|
| `dotenv` | 环境变量加载（examples 用） |
| `zod` | Schema 验证（类型定义用） |

### 注意事项

- `@cloudbase/node-sdk` 是 **peer dependency**，运行时按需 `import()` 动态加载
- 不使用 CloudBase 功能时不需要安装
- 使用 CloudBase 功能时必须 `pnpm add @cloudbase/node-sdk`

---

## 十四、调试技巧

### 启用调试日志

```bash
OAK_DEBUG=1 pnpm dlx tsx examples/14-session-history.ts
```

日志前缀：
- `[oak][session-store]` — SessionStore 层
- `[oak][session-messages]` — 双写层
- `[oak][getHistory]` — 历史查询层
- `[oak][sandbox]` — 沙箱层
- `[oak][cloudbase-mcp]` — MCP 工具层
- `[oak] credential resolved` — 凭证解析

### 直接查询 CloudBase DB

可使用 CloudBase MCP 工具直接查询集合数据：
```typescript
// 查询 oak_session_entries
mcp__cloudbase__readNoSqlDatabaseContent({ collection: 'oak_session_entries', limit: 10 })

// 查询 oak_session_messages
mcp__cloudbase__readNoSqlDatabaseContent({ collection: 'oak_session_messages', limit: 10 })
```

---

## 十五、分支与提交

当前分支：`feat/support-open-agent-kernel`

提交规范：
```
feat/fix/docs/refactor/chore(scope): 简短描述
```

Co-Author 格式（AI 辅助时）：
```
Co-Authored-By: Claude <noreply@anthropic.com>
```

---

## 十六、运行示例

```bash
# 1. 配置环境变量
cp packages/open-agent-kernel/examples/.env.example packages/open-agent-kernel/examples/.env.local
# 编辑 .env.local 填入真实凭证

# 2. 运行最简示例
pnpm dlx tsx packages/open-agent-kernel/examples/01-quickstart.ts

# 3. 运行带持久化的示例
pnpm dlx tsx packages/open-agent-kernel/examples/04-multi-turn-db.ts

# 4. 运行沙箱示例
pnpm dlx tsx packages/open-agent-kernel/examples/08-sandbox.ts

# 5. 运行 Session History 综合示例（对话 + MCP + HITL + 原始数据结构）
pnpm dlx tsx packages/open-agent-kernel/examples/14-session-history.ts
```
