# open-agent-kernel examples

每个 example 都是端到端可运行脚本，用来验证 SDK 的一个能力点。建议先跑 `01-quickstart.ts`，再按功能选择后续示例。

## 准备

```bash
cd packages/open-agent-kernel/examples
cp config.example.json config.local.json
# 编辑 config.local.json，填入 envId / model / tcbApiKey / credentials
```

在仓库根目录先构建 SDK，再运行示例：

```bash
pnpm -F @cloudbase/open-agent-kernel build
pnpm dlx tsx packages/open-agent-kernel/examples/01-quickstart.ts
```

`config.local.json` 已被 gitignore，不会被提交。

## `config.local.json` 字段

| 字段 | 用途 |
|------|------|
| `envId` | CloudBase 环境 ID，示例会显式传给 `createAgent({ envId })`。 |
| `model` | 默认模型 ID，示例会显式传给 `createAgent({ model })`。 |
| `tcbApiKey` | CloudBase 服务端 APIKey；helper 会写入 `process.env.TCB_API_KEY` 供 SDK 默认模型网关和 sandbox 使用。 |
| `credentials.secretId` / `credentials.secretKey` | CloudBase 平台凭证，示例会显式传给 `createAgent({ credentials })`。 |
| `credentials.sessionToken` | STS 临时凭证，可选。 |
| `examples.resumeConversationId` | example 04 使用；指定上一次输出的 conversationId 做跨进程 resume。 |
| `examples.storage` | example 05 使用；设为 `memory` 时改用 `InMemoryStorage`。 |
| `examples.imagePath` | example 05 使用；指定自定义图片路径。 |
| `examples.debug` | 为 `true` 时打开 `OAK_DEBUG` 调试日志。 |

## 运行索引

在仓库根目录运行：

```bash
pnpm dlx tsx packages/open-agent-kernel/examples/01-quickstart.ts
```

| Example | 功能 | 运行命令 |
|---------|------|----------|
| `01-quickstart.ts` | 快速开始 | `pnpm dlx tsx packages/open-agent-kernel/examples/01-quickstart.ts` |
| `02-debug.ts` | 打印调试事件 | `pnpm dlx tsx packages/open-agent-kernel/examples/02-debug.ts` |
| `03-multi-turn.ts` | 进程内多轮对话 | `pnpm dlx tsx packages/open-agent-kernel/examples/03-multi-turn.ts` |
| `04-multi-turn-db.ts` | CloudBase session 持久化 / resume | `pnpm dlx tsx packages/open-agent-kernel/examples/04-multi-turn-db.ts` |
| `05-multimodal.ts` | 图片附件 / Storage | `pnpm dlx tsx packages/open-agent-kernel/examples/05-multimodal.ts` |
| `06-mcp-sdk-server.ts` | 进程内 MCP | `pnpm dlx tsx packages/open-agent-kernel/examples/06-mcp-sdk-server.ts` |
| `07-mcp-stdio.ts` | stdio MCP | `pnpm dlx tsx packages/open-agent-kernel/examples/07-mcp-stdio.ts` |
| `08-sandbox.ts` | sandbox 文件系统 / Shell | `pnpm dlx tsx packages/open-agent-kernel/examples/08-sandbox.ts` |
| `09-sandbox-shared.ts` | shared sandbox | `pnpm dlx tsx packages/open-agent-kernel/examples/09-sandbox-shared.ts` |
| `10-sandbox-cloudbase-tools.ts` | sandbox 内 CloudBase MCP 工具 | `pnpm dlx tsx packages/open-agent-kernel/examples/10-sandbox-cloudbase-tools.ts` |
| `11-hitl-approval.ts` | 单进程 HITL 审批 | `pnpm dlx tsx packages/open-agent-kernel/examples/11-hitl-approval.ts` |
| `12-hitl-acp-adapter.ts` | ACP 风格审批适配 | `pnpm dlx tsx packages/open-agent-kernel/examples/12-hitl-acp-adapter.ts` |
| `13-hitl-distributed-cloudbase.ts` | 分布式 HITL 审批 | `pnpm dlx tsx packages/open-agent-kernel/examples/13-hitl-distributed-cloudbase.ts` |
| `14-session-history.ts` | 历史查询 / 聚合验证 | `pnpm dlx tsx packages/open-agent-kernel/examples/14-session-history.ts` |
| `15-skills.ts` | Skills | `pnpm dlx tsx packages/open-agent-kernel/examples/15-skills.ts` |
| `16-user-memory.ts` | userMemory 单进程 | `pnpm dlx tsx packages/open-agent-kernel/examples/16-user-memory.ts` |
| `17-user-memory-distributed.ts` | userMemory 跨节点 | `pnpm dlx tsx packages/open-agent-kernel/examples/17-user-memory-distributed.ts` |
| `18-workspace-snapshot.ts` | workspace snapshot 单进程 | `pnpm dlx tsx packages/open-agent-kernel/examples/18-workspace-snapshot.ts` |
| `19a-snapshot-write.ts` | workspace snapshot 写入阶段 | `pnpm dlx tsx packages/open-agent-kernel/examples/19a-snapshot-write.ts` |
| `19b-snapshot-read.ts` | workspace snapshot 读取阶段 | `pnpm dlx tsx packages/open-agent-kernel/examples/19b-snapshot-read.ts` |

## 凭证依赖矩阵

| Example | `config.tcbApiKey` | `config.envId` | `config.credentials` | 备注 |
|---------|:---:|:---:|:---:|------|
| 01 / 02 / 03 | ✅ | ✅ | | 模型调用。 |
| 04 | ✅ | ✅ | ✅ | 默认 CloudBase FlexDB session store。 |
| 05 | ✅ | ✅ | CloudBase Storage 模式需要 | `examples.storage=memory` 时不需要平台凭证。 |
| 06 / 07 | ✅ | ✅ | | MCP 工具示例。 |
| 08 / 09 / 10 | ✅ | ✅ | ✅ | sandbox / CloudBase MCP 工具。 |
| 11 / 12 | ✅ | ✅ | | 单进程审批。 |
| 13 | ✅ | ✅ | ✅ | 分布式审批状态写入 CloudBase DB。 |
| 14 | ✅ | ✅ | | 历史查询聚合示例。 |
| 15 | ✅ | ✅ | | Skills 示例。 |
| 16 / 17 | ✅ | ✅ | ✅ | userMemory 需要 CloudBase Storage。 |
| 18 / 19a / 19b | ✅ | ✅ | ✅ | workspace snapshot 需要 sandbox 和 Storage。 |

## 共享工具

`_shared/env.ts` 读取 `config.local.json`，并提供：

- `loadEnv()` / `getEnvId()` / `getModel()`
- `getPlatformCredentials()`
- `getSandboxApiKey()`
- `getResumeConversationId()` / `getExampleStorage()` / `getExampleImagePath()`

示例层从 `config.local.json` 读取配置，再通过 `createAgent({ envId, model, credentials })` 显式传给 SDK。常规 sandbox 示例只写 `sandbox: { enabled: true }`，SDK 会复用 `TCB_API_KEY` 作为默认 AGS 数据面凭证。

## workspace snapshot 验证顺序

`19-workspace-snapshot-distributed.ts` 已废弃，因为同一进程无法真实验证跨节点 restore。正确流程是：

1. 运行 `19a-snapshot-write.ts`，让 Agent 在 sandbox 中写文件并触发 snapshot。
2. 手动停止对应 AGS sandbox instance，确保下次启动会走 COS restore。
3. 运行 `19b-snapshot-read.ts`，观察 `restoreStatus=full` 并验证文件内容。
