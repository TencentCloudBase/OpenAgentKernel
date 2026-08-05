# Open Agent Kernel：内置 ACP 流式输出方案

> 文档状态：已落地（2026-06，v2 对齐标准 ACP 1.0.0）
> 适用范围：`@cloudbase/open-agent-kernel` 的 `session.send()` / `respond*()` 流式输出

## 决策

OAK 默认输出 ACP `session/update` 语义，**标准 variant 直接复用 `@agentclientprotocol/sdk@^1.0.0` 的 `SessionUpdate` 类型**，OAK 扩展定义在 `src/acp/types.ts` 并明确标注：

```typescript
const agent = createAgent({ envId, model, credentials })
const session = await agent.startSession({ userId: 'u1' })

for await (const update of session.send('你好')) {
  // update: AcpSessionUpdate = SessionUpdate | OAK extensions
}
```

用户不需要声明 `streamAdapter`。`createAgent()` 内部默认使用内置 `AcpStreamAdapter`。

## 架构

```text
Claude Agent SDK query()
  -> SDKMessage stream
  -> AcpStreamAdapter
  -> AsyncIterable<AcpSessionUpdate>
```

关键点：

- 标准 variant（13 个）直接来自 `@agentclientprotocol/sdk` 的 `SessionUpdate`。
- OAK 扩展 variant（6 个）定义在 `src/acp/types.ts`，处理标准 ACP 不覆盖的场景。
- 不对外暴露 raw `SDKMessage`。
- 不再公开 `SessionEvent`。
- `streamAdapter` 仅作为高级覆盖入口保留。

## SessionUpdate variant 清单

### 标准 variant（来自 `@agentclientprotocol/sdk@1.0.0`）

| `sessionUpdate` | 类型 | 说明 |
|-----------------|------|------|
| `user_message_chunk` | `ContentChunk` | 用户消息流式回放 |
| `agent_message_chunk` | `ContentChunk` | 模型文本输出 |
| `agent_thought_chunk` | `ContentChunk` | 模型思考流（替代旧 `thinking`） |
| `tool_call` | `ToolCall` | 工具调用开始（`rawInput` / `kind: ToolKind` / `locations`） |
| `tool_call_update` | `ToolCallUpdate` | 工具状态/结果更新（`rawOutput` / `content[]`） |
| `plan` | `Plan` | 执行计划 |
| `plan_update` | `PlanUpdate` | 计划更新 |
| `plan_removed` | `PlanRemoved` | 计划移除 |
| `available_commands_update` | `AvailableCommandsUpdate` | 可用斜杠命令 |
| `current_mode_update` | `CurrentModeUpdate` | 当前模式切换 |
| `config_option_update` | `ConfigOptionUpdate` | 配置选项更新 |
| `session_info_update` | `SessionInfoUpdate` | 会话信息更新 |
| `usage_update` | `UsageUpdate` | token / cost 用量 |

### OAK 扩展 variant（非标准，payload 兼容标准形状）

| `sessionUpdate` | 说明 | 对标标准概念 |
|-----------------|------|-------------|
| `request_permission` | HITL 审批请求（stop-and-resume 模式） | `session/request_permission` JSON-RPC（payload 镜像 `RequestPermissionRequest`） |
| `ask_user` | AskUserQuestion 问询（stop-and-resume） | `session/elicitation`（OAK 用独立 variant） |
| `log` | 错误 / 状态消息 | 无标准对应 |
| `artifact` | 部署产物通知 | 无标准对应 |
| `history_page` | 历史分页回放 | `session/load` 请求-响应（OAK 用 sessionUpdate 推一页） |
| `agent_phase` | 执行阶段指示器 | 无标准对应 |

## 主要映射（SDK → ACP）

| SDK 来源 | ACP `sessionUpdate` |
|----------|---------------------|
| `stream_event.content_block_delta.text_delta` | `agent_message_chunk` |
| `stream_event.content_block_delta.thinking_delta` | `agent_thought_chunk` |
| `stream_event.content_block_start.tool_use` | `tool_call`（`rawInput` / `kind: toolKindFromName()`） |
| `stream_event.input_json_delta` | `tool_call_update`（`rawInput`） |
| `assistant.tool_use` replay | `tool_call` 或 `tool_call_update`（去重） |
| `user.tool_result` | `tool_call_update`（`rawOutput` / `content[]`） |
| OAK approval/client-tool sentinel | `request_permission`（`toolCall: ToolCallUpdate` + `options: PermissionOption[]`） |
| OAK askUser sentinel | `ask_user` |
| `result` | `usage_update` + `agent_phase: idle` |

## `_meta.oak` 扩展命名空间

OAK 专有数据通过标准 `_meta.oak.*` 扩展传递，不污染标准字段：

- `_meta.oak.parentToolCallId` — 子 agent 工具链父 ID
- `_meta.oak.assistantMessageId` — SSE 关联用 assistant 消息 ID
- `_meta.oak.planContent` — ExitPlanMode 计划内容

## 文件结构

```text
packages/open-agent-kernel/src/
├── acp/
│   ├── index.ts          # re-export 标准 + OAK 类型
│   └── types.ts          # OAK 扩展定义
├── adapters/
│   ├── acp-stream-adapter.ts  # SDKMessage → AcpSessionUpdate
│   ├── index.ts
│   └── types.ts
├── public/
│   ├── create-agent.ts
│   └── types.ts
└── runtime/
    └── agent-builder.ts
```

## 验证

```bash
pnpm --filter @cloudbase/open-agent-kernel type-check
pnpm --filter @cloudbase/open-agent-kernel build
pnpm dlx tsx packages/open-agent-kernel/examples/20-acp-stream-adapter-fixture.ts
pnpm exec tsc --noEmit --target ES2022 --module NodeNext --moduleResolution NodeNext --skipLibCheck packages/open-agent-kernel/examples/21-default-acp-session-contract.ts
```
