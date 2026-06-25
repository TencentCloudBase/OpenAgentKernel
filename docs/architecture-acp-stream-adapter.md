# Open Agent Kernel：内置 ACP 流式输出方案

> 文档状态：已落地（2026-06）
> 适用范围：`@cloudbase/open-agent-kernel` 的 `session.send()` / `respond*()` 流式输出

## 决策

OAK 默认输出 ACP `session/update` 语义：

```typescript
const agent = createAgent({ envId, model, credentials })
const session = await agent.startSession({ userId: 'u1' })

for await (const update of session.send('你好')) {
  // update: AcpSessionUpdate
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

- 不对外暴露 raw `SDKMessage`。
- 不再公开 `SessionEvent`。
- 不保留独立 `event-translator` / `sdk-message-translator` 层。
- 原 translator 必要能力（`stream_event` 状态机、文本去重、工具参数流、HITL sentinel 识别）全部内聚在 `AcpStreamAdapter`。
- `streamAdapter` 仅作为高级覆盖入口保留，常规 examples 和 README 不要求用户配置。

## 主要映射

| SDK 来源 | ACP `sessionUpdate` |
|----------|---------------------|
| `stream_event.content_block_delta.text_delta` | `agent_message_chunk` |
| `stream_event.content_block_start.tool_use` | `tool_call` |
| `stream_event.input_json_delta` | `tool_call_update` |
| `assistant.tool_use` replay | `tool_call` 或 `tool_call_update`（去重） |
| `user.tool_result` | `tool_call_update` |
| OAK approval/client-tool sentinel | `tool_confirm` |
| OAK askUser sentinel | `ask_user` |
| `result` | `agent_phase` with `phase: 'idle'` |

## 文件结构

```text
packages/open-agent-kernel/src/
├── acp/
│   ├── index.ts
│   └── types.ts
├── adapters/
│   ├── acp-stream-adapter.ts
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
