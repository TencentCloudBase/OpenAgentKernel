# @cloudbase/open-agent-kernel 交接文档

> 最后更新：2026-06-12 18:39 | 分支：`feat/support-open-agent-kernel` | 版本：`0.3.0-alpha.0`

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

## v0.3.0 — Workspace Snapshot (Spec B) 

**新增功能**:COS 快照同步 — 沙箱工作区跨进程/跨节点持久化

### 核心实现
- **AgsStatefulSandbox** 支持 COS mount + workspace snapshot
- **send-end snapshot**:session.send() 结束自动触发 snapshot 到 COS
- **manual snapshot**:`session.snapshotWorkspace()` API
- **restoreFromCos**:新实例启动时自动从 COS 恢复工作区
- **状态查询**:`session.getRestoreStatus()` 返回 `'full' | 'fresh' | 'partial' | 'failed' | null`

### 验证用例
- **example 18**:单进程验证(send-end snapshot + cosfs 持久化)
- **example 19a/19b**:跨进程验证(写阶段 + 手动 stop + 读阶段)

### Spec B 沙箱快照 — 技术架构总结

#### 1. 快照生命周期
```
[OAK session.send() 结束] → [send-end snapshot 触发]
    ↓
[trw snapshotNow()] → [tar.zst 打包 /home/user] → [上传 COS]
    ↓
[新实例启动] → [trw restoreFromCos()] → [下载 snapshot] → [解压到 /home/user]
    ↓
[模型读取恢复的文件] → [跨进程数据接续完成]
```

#### 2. COS 存储结构
```
COS bucket/oak-workspaces/
├── {userId}/                          # 用户隔离命名空间
│   ├── .keep                          # 目录占位文件
│   ├── .sync-out-status.json          # snapshot 元数据
│   └── .snapshot-{timestamp}.tar.zst  # 压缩快照文件
```

#### 3. 关键文件格式

**`.sync-out-status.json`**(快照元数据):
```json
{
  "syncedAt": "2026-06-10T13:20:03.680Z",
  "sizeBytes": 17877984,
  "fileCount": 462,
  "snapshotKey": ".snapshot-2026-06-10T13-20-03.680Z.tar.zst",
  "snapshotSha256": "3d2d46bbf94fef6d0442b50c3c28c807918e2652acfb9339304d8662bf29b48a",
  "snapshotSizeBytes": 4284680,
  "lastGoodSnapshotKey": ".snapshot-2026-06-10T13-20-09.082Z.tar.zst",
  "format": "tar.zst",
  "version": 2
}
```

#### 4. 挂载配置
```json
{
  "MountOptions": [{
    "Name": "oak-cos-workspace",
    "SubPath": "restore-probe-{userId}"  // COS 子目录
  }],
  "CustomConfiguration": {
    "Env": [{
      "Name": "COS_MOUNT_DIR", 
      "Value": "/mnt/workspace"  // 容器内挂载点
    }]
  }
}
```

#### 5. 状态同步机制
- **trw `/health`**:返回 `restored: "full" | "fresh" | "partial" | "failed"`
- **OAK `getRestoreStatus()`**:读取 trw 状态并返回给业务层
- **时序要求**:startSession 后需等待 trw bootstrap 完成才能读取准确状态

### 已验证功能
✅ **COS 写入链路**:OAK send-end → trw snapshotNow() → COS bucket/oak-workspaces/{userId}/.snapshot-*.tar.zst  
✅ **COS 恢复链路**:新实例启动 → trw restoreFromCos() → 从 COS 下载 snapshot → 解压到 /home/user  
✅ **跨进程数据接续**:新实例读到旧实例写入的文件内容
✅ **trw 状态同步**:`/health` 正确返回 `restored: "full"`

### 待优化问题
- **OAK restoreStatus API 误报**:trw `/health` 显示 `"full"` 但 OAK `getRestoreStatus()` 有时返回 `null`(时序问题)
- **example 19b 验收逻辑**:需要优化以模型读取结果为最终标准
- **错误处理增强**:snapshot/restore 失败的用户提示

### 技术细节
- **COS 路径映射**:bucket/oak-workspaces/{userId}/ 正确挂载到 /mnt/workspace/
- **文件格式**:`.snapshot-*.tar.zst`(压缩快照) + `.sync-out-status.json`(元数据)
- **触发条件**:`workspaceRoot` ≠ `COS_MOUNT_DIR` 时自动启用 rsync 模式

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

> ⚠️ **凭证环境变量正在规范化中**（见 [十四、当前优化任务 → 优化 1](#优化1凭证环境变量规范化)）。  
> 最终标准：`TENCENTCLOUD_SECRETID` / `TENCENTCLOUD_SECRETKEY` / `TENCENTCLOUD_SESSIONTOKEN`。  
> `TCB_SECRET_ID` / `TCB_SECRET_KEY` / `TCB_TOKEN` 仅保留在 `.env.example` / `.env.local` 方便测试注入。

### 必填

| 变量 | 说明 |
|---|---|
| `TCB_ENV_ID` | CloudBase 环境 ID |
| `TENCENTCLOUD_TOKENHUB_API_KEY` | 模型凭证（TokenHub） |

### 可选

| 变量 | 说明 |
|---|---|
| `TCB_API_KEY` | 沙箱数据面长期 JWT |
| `TCB_REGION` | 区域（默认 `ap-shanghai`） |
| `OAK_DEBUG` | 设为 `1` 启用调试日志 |
| `CLOUDBASE_AGENT_MODEL` | 覆盖默认模型 |

### 凭证相关（下表中变量 kernel 代码不应直接读取）

> Kernel SDK 逻辑中不应存在读取 `TCB_SECRET_ID` / `TCB_SECRET_KEY` / `TCB_TOKEN` /  
> `TENCENTCLOUD_SECRETID` / `TENCENTCLOUD_SECRETKEY` / `TENCENTCLOUD_SESSIONTOKEN` 等凭证环境变量的代码。  
> 这些变量仅存在于 `.env.example` / `.env.local`，供测试/示例注入使用。

| 变量 | 说明 |
|---|---|
| `TENCENTCLOUD_SECRETID` | 腾讯云标准 SecretId（**正确标准名**） |
| `TENCENTCLOUD_SECRETKEY` | 腾讯云标准 SecretKey（**正确标准名**） |
| `TENCENTCLOUD_SESSIONTOKEN` | 腾讯云标准临时 Token（**正确标准名**） |
| `TCB_SECRET_ID` | ~~旧名，待弃用~~ |
| `TCB_SECRET_KEY` | ~~旧名，待弃用~~ |
| `TCB_TOKEN` | ~~旧名，待弃用~~ |

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

### v0.2.0 (Spec A) 待完善

1. ~~**`history-store/` 模块**~~ — ✅ 已删除（双写机制已覆盖需求）
2. ~~**`getHistory()` 分页**~~ — ✅ 已优化（`loadEntriesByMessageIds` 避免全量扫描）
3. ~~**`oak_session_messages` 清理**~~ — ✅ 已暴露 `session.clearHistory()` 方法
4. ~~**`listSessions()` 返回结构**~~ — ✅ 已通过 `registerSession` 持久化 userId
5. **`resumeSession()` 实现** — 当前 SDK 层 resume 能工作（transcript 由 SDK 加载），但 kernel 层 userId 硬编码为 `'resumed'`、沙箱/权限状态未恢复（低优先级）

### v0.3.0 (Spec B) 待优化

1. **OAK restoreStatus API 误报** — trw `/health` 显示 `"full"` 但 OAK `getRestoreStatus()` 有时返回 `null`（时序同步问题）
2. **example 19b 验收逻辑** — 需要优化以模型读取结果为最终标准，减少对 `getRestoreStatus()` 的依赖
3. **错误处理增强** — snapshot/restore 失败的用户提示和 graceful 降级
4. **性能监控** — snapshot 耗时、成功率等指标收集

### 技术债

1. `cloudbase-db-driver.ts` 的 `gtCommand()` / `ltCommand()` 每次都动态加载 CloudBase SDK 获取 `db.command`，可缓存
2. `extractMessageParts()` 中 `sdkMsg.message as { content?: unknown[] | string }` 类型断言链过长，应定义 SDKMessage 类型
3. **CloudBaseCosClaudeHomeStore mock 单测** — 目前仅集成层验证，建议 V2 加 mock 单测
4. **session.send / runClaudeQuery sync-hook 集成测** — try/finally 触发 push 的不变量需要单测验证

---

### 优化 1：凭证环境变量规范化（✅ 已完成）

> **状态**: 已实施。kernel SDK 逻辑中不再读取 CloudBase 凭证类环境变量；示例层负责从 `.env.local` 读取后显式注入 `credentials` / `apiKey`。
>
> **验证**: `pnpm format`、`pnpm -F @cloudbase/open-agent-kernel test`、`pnpm -F @cloudbase/open-agent-kernel type-check`、`pnpm -F @cloudbase/open-agent-kernel build`、`pnpm lint` 均通过。

#### 背景

kernel SDK 当前存在凭证环境变量使用不规范的问题：
- 多处代码读取 `TCB_SECRET_ID` / `TCB_SECRET_KEY` / `TCB_TOKEN` 等非标准变量名
- 各模块有独立的 `resolveCredentials()` 函数，环境变量 fallback 链不一致
- 正确标准名：`TENCENTCLOUD_SECRETID` / `TENCENTCLOUD_SECRETKEY` / `TENCENTCLOUD_SESSIONTOKEN`

#### 核心设计原则

1. **kernel SDK 逻辑中不应存在读取凭证环境变量的代码** — 这些变量仅存在于 `.env.example` / `.env.local`，供测试和示例注入使用
2. **凭证统一通过 `createAgent` 的 `credentials` 参数注入** — 所有下游模块从同一处取值
3. **当下游 SDK 有内部 env 读取机制时，可不传让它自取；没有时，强制要求传参**

#### 下游 SDK 的凭证行为（关键发现）

| 依赖 | 能否自动读 env？ | 结论 |
|------|:---:|------|
| `@cloudbase/node-sdk` | ⚠️ 仅云函数环境 | 云函数内可自动读 `TENCENTCLOUD_SECRETID/SECRETKEY`；通用服务器环境需显式传 `auth.secretId/secretKey` |
| `@cloudbase/manager-node` | ❌ 无此机制 | 构造函数要求显式传入 `secretId`/`secretKey`/`envId`，文档"云函数内可不填"仅适用于云函数自动注入 |
| `tencentcloud-sdk-nodejs` | ❌ 代码中未使用 | `AgsStatefulSandbox` 根本不依赖此包，全部走 `@cloudbase/manager-node` 的 `CloudService` 工具类 |

**结论**：
- `AgsStatefulSandbox` + `CloudBaseCosClaudeHomeStore`（manager-node 用户）→ **必须显式传凭证**，不传直接报错
- `CloudBaseDbDriver` + `CloudBaseStorage` + `CloudBaseDbPermissionDriver`（node-sdk 用户）→ **建议传凭证**；不传时由 node-sdk 自己处理（非云函数环境会报错）

#### 实施方案

##### 第 0 步：类型定义

在 `src/public/types.ts` 新增统一凭证类型，加入 `AgentConfig`：

```typescript
/** 平台凭证 — 用于初始化 @cloudbase/node-sdk 和 @cloudbase/manager-node */
export interface PlatformCredentials {
  secretId: string
  secretKey: string
  sessionToken?: string
  envId: string
}

// AgentConfig 新增字段
export interface AgentConfig {
  // ...existing fields
  /** 平台凭证，用于初始化 CloudBase SDK。不传则依赖下游 SDK 自身行为。 */
  credentials?: PlatformCredentials
}
```

`SandboxUserCredentials` 保持不变（用于注入 sandbox MCP 工具），其 JSDoc 需从 `TCB_SECRET_ID` 改为 `TENCENTCLOUD_SECRETID`。

##### 第 1 步：清理 `createAgent()` 中的凭证解析

`src/public/create-agent.ts`:
- 删除 `resolveUserCredentials()` 中所有 `process.env.TCB_*` / `process.env.TENCENTCLOUD_*` 的 fallback
- 将 `credentials` 参数传递给所有需要凭证的下游模块

##### 第 2 步：清理各模块的 `resolveCredentials()`

以下 6 处 `resolveCredentials()` 函数需删除 env var fallback，改为从构造参数接收：

| 文件 | 依赖 | 改动 |
|------|------|------|
| `src/session-store/drivers/cloudbase-db-driver.ts` | node-sdk | 删除 `resolveCredentials()`，从 `CloudBaseDbDriverOptions` 取 credentials |
| `src/storage/cloudbase-storage.ts` | node-sdk | 同上 |
| `src/permissions/drivers/cloudbase-db-driver.ts` | node-sdk | 同上 |
| `src/claude-home/cloudbase-cos-store.ts` | manager-node | 删除 `resolveCredentials()`，从构造参数取 credentials；缺则报 `InvalidConfigError` |
| `src/sandbox/ags-stateful-sandbox.ts` | manager-node | 删除 `resolveCredentials()`，从 `AgsStatefulSandboxOptions` 取；缺则报 `InvalidConfigError` |
| `src/public/create-agent.ts` | - | 删除 `resolveUserCredentials()` 的 env fallback，改为从 `AgentConfig.credentials` 取 |

##### 第 3 步：错误提示

| 模块 | 缺凭证时行为 |
|------|-------------|
| manager-node 用户 (sandbox / cos-store) | 抛出 `InvalidConfigError('必须提供 platform credentials')` |
| node-sdk 用户 (db-driver / storage / permission-driver) | 由 node-sdk 自身报错（其在非云函数环境会抛认证错误） |

##### 第 4 步：更新 `.env.example`

`packages/open-agent-kernel/examples/.env.example`:
- 变量名改为 `TENCENTCLOUD_SECRETID` / `TENCENTCLOUD_SECRETKEY` / `TENCENTCLOUD_SESSIONTOKEN`
- 保留旧名注释 + 弃用标记

##### 第 5 步：更新测试文件

以下测试文件通过 `createAgent({ credentials })` 或构造参数传入凭证，不再设置 env：

- `src/sandbox/__tests__/ags-stateful-sandbox.test.ts` — 当前设 `TCB_SECRET_ID/KEY`
- `src/claude-home/__tests__/cloudbase-cos-store.test.ts` — 当前设 `TCB_SECRET_ID/KEY`
- `src/runtime/__tests__/agent-builder.test.ts` — 当前设 `TCB_SECRET_ID/KEY`
- `src/sandbox/workspace-snapshot/__tests__/init-client.test.ts` — 当前用 `TCB_SECRET_ID` 作为 credential key

#### 凭证流转图（改造后）

```
createAgent({ credentials })
  ├→ SessionStore (CloudBaseDbDriver)      ← credentials 传入 node-sdk init()
  ├→ Storage (CloudBaseStorage)            ← credentials 传入 node-sdk init()
  ├→ PermissionDriver (CloudBaseDbPerm)    ← credentials 传入 node-sdk init()
  ├→ ClaudeHomeStore (CloudBaseCosStore)   ← credentials 传入 manager-node constructor（必传）
  └→ Sandbox (AgsStatefulSandbox)          ← credentials 传入 manager-node constructor（必传）
```

#### 不改变的部分

- `src/resources/credential-provider.ts` — 处理 TokenHub 模型 API Key，与 CloudBase 凭证无关，保持不变
- `src/sandbox/cloudbase-mcp.ts` — `injectCredentials()` 发送到 sandbox 的 HTTP body 已使用标准 key 名 `TENCENTCLOUD_SECRETID/SECRETKEY/SESSIONTOKEN`，保持不变
- `src/sandbox/workspace-snapshot/init-client.ts` — 内部逻辑不变，但传入的 credential key 名需统一为标准名

#### 验收标准

- [x] 所有 `resolveCredentials()` 函数中无 `process.env.TCB_*` / `process.env.TENCENTCLOUD_*` 等凭证 env var 读取
- [x] `AgentConfig.credentials` 类型定义完整
- [x] `.env.example` 使用标准变量名
- [x] 测试文件中无凭证 env var 设置
- [x] `pnpm build` 通过
- [x] `pnpm type-check` 通过
- [x] `pnpm lint` 通过
- [x] `pnpm test` 通过
- [x] 更新 `src/public/types.ts` 中 `SandboxUserCredentials` 的 JSDoc 中 env var 引用

#### 确认点（实施前与用户确认）

1. ✅ 统一 `credentials` 到 `AgentConfig` 入口 — 已确认
2. ✅ manager-node 用户必须传凭证，缺则报错 — 已确认
3. ✅ node-sdk 用户建议传凭证，不传交由 SDK 自身处理 — 已确认
4. ✅ `PlatformCredentials` 独立于 `SandboxUserCredentials`（平台控制面凭证 vs 用户租户凭证语义不同）

---

### 优化 2：sessionStore 默认启用与 API 简化（✅ 已完成）

> **状态**: 已实施。面向 SDK 用户的默认路径从
> `new CloudBaseDbDriver({ credentials })` → `new CloudBaseSessionStore({ driver })` →
> `createAgent({ session: { store } })` 简化为只传 `createAgent({ credentials })`。

#### 设计结论

1. **默认启用 CloudBase FlexDB session store**
   - 当 `AgentConfig.credentials` 存在且 `session.enabled !== false` 时，kernel 自动创建默认 `CloudBaseSessionStore`。
   - 默认 provider 为 `cloudbase`，默认 database 为 `flexdb`，默认表前缀为 `oak_`。
   - `projectKey` 默认使用 `envId`，避免 SDK cwd 派生 key 导致跨节点 resume 断裂。

2. **保留显式关闭与高级扩展**
   - `session: { enabled: false }` 显式关闭默认持久化。
   - `session: { store }` 仍支持完全自定义 SessionStore。
   - `session.provider` 表达资源域，当前为 `'cloudbase'`。
   - `session.database` 表达 CloudBase 内部数据资源类型：`'flexdb' | 'mongo' | 'mysql' | 'pgsql'`。
   - 当前内置实现为 `database: 'flexdb'`；其他 CloudBase 数据库类型预留，使用时会给出明确未支持错误。

3. **允许自定义表前缀**
   - 新增 `session.tablePrefix`，用于默认 CloudBase FlexDB 后端。
   - 生成 `{tablePrefix}sessions` / `{tablePrefix}session_entries` /
     `{tablePrefix}session_summaries` / `{tablePrefix}session_messages`。

#### 新推荐用法

```typescript
const agent = createAgent({
  envId,
  credentials: { secretId, secretKey },
  model: 'glm-5.1',
  // 不配置 session 时，credentials 存在会默认启用 CloudBase FlexDB session store
})
```

自定义表前缀:

```typescript
const agent = createAgent({
  envId,
  credentials,
  model: 'glm-5.1',
  session: { tablePrefix: 'my_agent_' },
})
```

关闭默认持久化:

```typescript
const agent = createAgent({
  envId,
  credentials,
  model: 'glm-5.1',
  session: { enabled: false },
})
```

#### 验证

- `pnpm format`
- `pnpm -F @cloudbase/open-agent-kernel test`（14 files / 167 tests）
- `pnpm -F @cloudbase/open-agent-kernel type-check`
- `pnpm -F @cloudbase/open-agent-kernel build`
- `pnpm lint`

---

### 优化 3：createAgent 顶层默认资源补齐（✅ 已完成）

> **状态**: 已实施。继续降低 SDK 用户的上手成本，避免在多个 CloudBase 能力里重复传 `envId` 或手动初始化默认资源类。

#### 设计结论

1. **`credentials.envId` 默认继承顶层 `envId`**
   - `PlatformCredentials.envId` 改为可选。
   - `createAgent` 内部会把 `credentials.envId ?? AgentConfig.envId` 归一化后再传给默认 CloudBase 资源。
   - 推荐写法从 `createAgent({ envId, credentials: { envId, secretId, secretKey } })` 简化为 `createAgent({ envId, credentials: { secretId, secretKey } })`。

2. **有 `credentials` 时默认启用 CloudBase Storage**
   - 用户不显式传 `storage`，且已提供 `credentials` 时，kernel 自动创建 `CloudBaseStorage`。
   - 多模态附件默认上传到 CloudBase 云存储并以签名 URL 发送给模型。
   - 用户仍可通过 `storage: new InMemoryStorage()` 或自定义 `StorageProvider` 覆盖默认行为。

#### 新推荐用法

```typescript
const agent = createAgent({
  envId,
  credentials: { secretId, secretKey },
  model: 'glm-5v-turbo',
  // 发送 attachments 时默认使用 CloudBase Storage，无需手动 new CloudBaseStorage
})
```

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
