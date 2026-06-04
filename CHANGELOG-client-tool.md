# Client-Tool 流程修复与分布式支持

## 变更概述

本次改动解决 client-tool 流程的 3 个问题，并为分布式部署提供支持。

## 问题与修复

### 1. `aggregateHistory()` 未过滤 client-tool sentinel

**问题**：`getHistory()` 返回的历史记录中，client-tool 的 sentinel deny tool_result 泄漏到用户可见的输出中。

**根因**：`aggregateHistory()` 只检查 `__OAK_INTERRUPT__`（HITL 审批），未检查 `__OAK_CLIENT_TOOL__`（client-tool）。

**修复**：在 sentinel 检测中加入 `__OAK_CLIENT_TOOL__`。

**文件**：`src/public/create-agent.ts:509-514`

### 2. MCP stub 依赖 `updatedInput` 注入结果（SDK 不支持）

**问题**：PreToolUse hook 通过 `updatedInput` 注入工具结果，但 Claude Agent SDK 不会将 `updatedInput` 传给 MCP server 的 `execute()`。

**根因**：SDK 的 `updatedInput` 机制对 MCP server 无效。hook 返回的 `updatedInput` 被 SDK 忽略，MCP stub 收到的 input 只有原始参数。

**修复**：
- MCP stub 改为直接从 `clientToolStore` 读取结果（通过 `scanRecent`）
- hook 不再删除 store entry（留给 MCP stub 读取后删除）
- hook 返回普通 `{}` allow，不再用 `buildClientToolAllow`

**文件**：
- `src/runtime/agent-builder.ts:255-295`（MCP stub 改为读 store）
- `src/permissions/hooks.ts:261-279`（hook 不再删除 entry）

### 3. `loadEntriesByMessageIds` 截断同一 messageId 的多条 entry

**问题**：`loadEntriesByMessageIds` 的 `limit(batch.length)` 导致同一 messageId 的多条 entry 被截断。SDK 对同一消息发送多次 entry（text + tool_use + thinking），这些 entry 共享 messageId 但有不同 uuid。

**修复**：去掉 limit。

**文件**：`src/session-store/drivers/cloudbase-db-driver.ts:305-316`

### 4. 分布式 ClientToolStore（新功能）

**问题**：`InMemoryClientToolStore` 不支持跨进程/跨节点。`respondToolUse()` 和 hook/MCP stub 必须在同一进程。

**修复**：参照 `PermissionStore` 的模式，新增分布式实现：
- `ClientToolResultStoreDriver` 接口
- `CloudBaseDbClientToolDriver`（复用 `oak_state` 集合，`type='client_tool'`）
- `CloudBaseClientToolStore`（薄封装，注入 projectKey）
- `AgentConfig` 新增 `toolStore?` 字段

**文件**：
- `src/permissions/drivers/types.ts`（新增接口）
- `src/permissions/drivers/cloudbase-client-tool-driver.ts`（新建）
- `src/permissions/cloudbase-client-tool-store.ts`（新建）
- `src/permissions/index.ts`（导出）
- `src/public/types.ts`（AgentConfig 新增字段）
- `src/public/create-agent.ts`（优先用 config.toolStore）

## session_entries 中间态说明

验证确认：
- `session_entries` 保留了中间态的 sentinel deny tool_result（SDK append-only 设计）
- `session_messages` 也包含 sentinel 的元数据
- `getHistory()` → `aggregateHistory()` 在展示层做过滤

尝试过更新 sentinel entry 的方案，但会导致 `aggregateHistory()` 的 sentinel 检测失效，出现重复 tool_call。因此保持原方案。

## 测试状态

| 测试 | 状态 |
|------|------|
| TypeScript 类型检查 | ✅ 通过 |
| 构建 | ✅ 通过 |
| 模拟数据聚合测试（example 15） | ✅ 8/8 通过 |
| 真实 API 集成测试（example 16） | ✅ 7/7 通过（需模型配合调用工具） |
| session store 调试（example 17） | ✅ 确认 entries/messages 数据结构 |

## 分布式用法

```typescript
import {
  CloudBaseClientToolStore,
  CloudBaseDbClientToolDriver,
  createAgent,
} from '@cloudbase/open-agent-kernel'

const agent = createAgent({
  envId,
  model: { id: 'mimo-v2.5-pro', apiKey, apiBaseUrl },
  tools: [{ name: 'get_weather', ... }],
  toolStore: new CloudBaseClientToolStore({
    driver: new CloudBaseDbClientToolDriver(),
    projectKey: envId,
  }),
})
```
