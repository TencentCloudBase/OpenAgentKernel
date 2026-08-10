# open-agent-kernel examples

每个 example 都是端到端可运行脚本，用来验证 SDK 的一个能力点。建议先跑 `01-quickstart.ts`，再按功能选择后续示例。

## 准备

```bash
cd examples
cp config.example.json config.local.json
# 编辑 config.local.json，填入 envId / model / tcbApiKey / credentials
```

在仓库根目录先构建 SDK，再运行示例：

```bash
pnpm build
pnpm dlx tsx examples/01-quickstart.ts
```

`config.local.json` 已被 gitignore，不会被提交。

## `config.local.json` 字段

| 字段 | 用途 |
|------|------|
| `envId` | CloudBase 环境 ID，示例会显式传给 `createAgent({ envId })`。 |
| `model` | 默认模型 ID，示例会显式传给 `createAgent({ model })`。 |
| `tcbApiKey` | CloudBase 服务端 APIKey；helper 会写入 `process.env.CLOUDBASE_APIKEY` 供 SDK 默认模型网关和 sandbox 使用。 |
| `credentials.secretId` / `credentials.secretKey` | CloudBase 平台凭证，示例会显式传给 `createAgent({ credentials })`。 |
| `credentials.sessionToken` | STS 临时凭证，可选。 |
| `examples.resumeConversationId` | example 04 使用；指定上一次输出的 conversationId 做跨进程 resume。 |
| `examples.storage` | example 05 使用；设为 `memory` 时改用 `InMemoryStorage`。 |
| `examples.imagePath` | example 05 使用；指定自定义图片路径。 |
| `examples.visionModel` | example 05 使用；视觉模型 ID（默认 `glm-5v-turbo`，不受顶层 `model` 影响）。 |
| `examples.debug` | 为 `true` 时打开 `OAK_DEBUG` 调试日志。 |

## 运行索引

在仓库根目录运行：

```bash
pnpm dlx tsx examples/01-quickstart.ts
```

| Example | 功能 | 运行命令 |
|---------|------|----------|
| `01-quickstart.ts` | 快速开始 | `pnpm dlx tsx examples/01-quickstart.ts` |
| `02-debug.ts` | 打印调试事件 | `pnpm dlx tsx examples/02-debug.ts` |
| `03-multi-turn.ts` | 进程内多轮对话 | `pnpm dlx tsx examples/03-multi-turn.ts` |
| `04-multi-turn-db.ts` | CloudBase session 持久化 / resume | 第一次跑写入个人信息；把输出的 `conversationId` 填入 `examples.resumeConversationId` 后再跑，验证跨进程回忆 |
| `05-multimodal.ts` | 图片附件 / Storage | `pnpm dlx tsx examples/05-multimodal.ts` |
| `06-mcp-sdk-server.ts` | 进程内 MCP | `pnpm dlx tsx examples/06-mcp-sdk-server.ts` |
| `07-mcp-stdio.ts` | stdio MCP | `pnpm dlx tsx examples/07-mcp-stdio.ts` |
| `08-local-sandbox.ts` | local sandbox 文件系统 / Shell | `pnpm dlx tsx examples/08-local-sandbox.ts` |
| `09-local-sandbox-cloudbase-tools.ts` | local sandbox + 进程内 CloudBase MCP | `pnpm dlx tsx examples/09-local-sandbox-cloudbase-tools.ts` |
| `11-hitl-approval.ts` | 单进程 HITL 审批 | `pnpm dlx tsx examples/11-hitl-approval.ts` |
| `12-hitl-acp-adapter.ts` | 内置 ACP 审批流 | `pnpm dlx tsx examples/12-hitl-acp-adapter.ts` |
| `13-hitl-distributed-cloudbase.ts` | 分布式 HITL 审批 | `pnpm dlx tsx examples/13-hitl-distributed-cloudbase.ts` |
| `14-session-history.ts` | 历史查询 / 聚合验证 | `pnpm dlx tsx examples/14-session-history.ts` |
| `15-skills.ts` | Skills | `pnpm dlx tsx examples/15-skills.ts` |
| `16-user-memory.ts` | userMemory 单进程 | `pnpm dlx tsx examples/16-user-memory.ts` |
| `17-user-memory-distributed.ts` | userMemory 跨节点 | `pnpm dlx tsx examples/17-user-memory-distributed.ts` |
| `20-acp-stream-adapter-fixture.ts` | ACP adapter fixture（不调用真实模型） | `pnpm dlx tsx examples/20-acp-stream-adapter-fixture.ts` |
| `21-default-acp-session-contract.ts` | 默认 session ACP 类型契约 | `pnpm exec tsc --noEmit --target ES2022 --module NodeNext --moduleResolution NodeNext --skipLibCheck examples/21-default-acp-session-contract.ts` |

### Experimental 示例（远程沙箱 / snapshot）

| Example | 功能 |
|---------|------|
| `_08-sandbox.ts` | 远程 AGS sandbox 文件系统 / Shell |
| `_09-sandbox-shared.ts` | shared 远程 sandbox |
| `_10-sandbox-cloudbase-tools.ts` | 远程 sandbox 内 CloudBase MCP |
| `_18-workspace-snapshot.ts` | workspace snapshot 单进程 |
| `_19a-snapshot-write.ts` / `_19b-snapshot-read.ts` | workspace snapshot 跨进程 restore |

## 凭证依赖矩阵

| Example | `config.tcbApiKey` | `config.envId` | `config.credentials` | 备注 |
|---------|:---:|:---:|:---:|------|
| 01 / 02 / 03 | ✅ | ✅ | | 模型调用。 |
| 04 | ✅ | ✅ | ✅ | 默认 CloudBase FlexDB session store。 |
| 05 | ✅ | ✅ | CloudBase Storage 模式需要 | `examples.storage=memory` 时不需要平台凭证。 |
| 06 / 07 | ✅ | ✅ | | MCP 工具示例。 |
| 08-local-sandbox | ✅ | ✅ | 可选 | local sandbox；CAM 缺省/占位符时回退 `tcbApiKey`（accessKey）做 workspacePersist。 |
| 09-local-sandbox-cloudbase-tools | ✅ | ✅ | 可选 | local sandbox + 进程内 `mcp__cloudbase__*`；凭证回退同 08。 |
| 11 / 12 | ✅ | ✅ | | 单进程审批。 |
| 13 | ✅ | ✅ | ✅ | 分布式审批状态写入 CloudBase DB。 |
| 14 | ✅ | ✅ | | 历史查询聚合示例。 |
| 15 | ✅ | ✅ | | Skills 示例。 |
| 16 / 17 | ✅ | ✅ | ✅ | userMemory 需要 CloudBase Storage。 |
| `_08` / `_09` / `_10` / `_18` / `_19*` | ✅ | ✅ | ✅ | 内部远程沙箱 / snapshot。 |

## 共享工具

`_shared/env.ts` 读取 `config.local.json`，并提供：

- `loadEnv()` / `getEnvId()` / `getModel()`
- `getPlatformCredentials()` / `tryGetPlatformCredentials()` / `getPlatformCredentialsOrApiKey()`
- `getSandboxApiKey()`
- `getResumeConversationId()` / `getExampleStorage()` / `getExampleImagePath()`

示例层从 `config.local.json` 读取配置，再通过 `createAgent({ envId, model, credentials })` 显式传给 SDK。公开 local sandbox 示例写 `sandbox: { enabled: true }`（默认 `LocalRuntimeSandbox`）。内部远程沙箱示例通过 `runtime: new AgsStatefulSandbox({ apiKey })` 注入。

## workspace snapshot 验证顺序（内部）

`_19-workspace-snapshot-distributed.ts` 已废弃。正确流程是：

1. 运行 `_19a-snapshot-write.ts`，让 Agent 在远程 sandbox 中写文件并触发 snapshot。
2. 手动停止对应 AGS sandbox instance，确保下次启动会走 COS restore。
3. 运行 `_19b-snapshot-read.ts`，观察 `restoreStatus=full` 并验证文件内容。
