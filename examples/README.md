# open-agent-kernel examples

每个 example 都是端到端可运行的脚本，演示 SDK 的一个能力点。

## 准备

```bash
cd packages/open-agent-kernel/examples
cp .env.example .env.local
# 编辑 .env.local 填入凭证
```

`.env.local` 已被根 `.gitignore` 排除（规则 `.env*` + `!.env.example`），不会被提交。

## 运行

```bash
# 在仓库根目录
pnpm dlx tsx packages/open-agent-kernel/examples/01-quickstart.ts
pnpm dlx tsx packages/open-agent-kernel/examples/02-debug.ts
pnpm dlx tsx packages/open-agent-kernel/examples/03-multi-turn.ts
pnpm dlx tsx packages/open-agent-kernel/examples/04-multi-turn-db.ts
pnpm dlx tsx packages/open-agent-kernel/examples/05-multimodal.ts
pnpm dlx tsx packages/open-agent-kernel/examples/06-mcp-sdk-server.ts
pnpm dlx tsx packages/open-agent-kernel/examples/07-mcp-stdio.ts
pnpm dlx tsx packages/open-agent-kernel/examples/08-sandbox.ts
pnpm dlx tsx packages/open-agent-kernel/examples/09-sandbox-shared.ts
pnpm dlx tsx packages/open-agent-kernel/examples/10-sandbox-cloudbase-tools.ts
pnpm dlx tsx packages/open-agent-kernel/examples/11-hitl-approval.ts
pnpm dlx tsx packages/open-agent-kernel/examples/12-hitl-acp-adapter.ts
pnpm dlx tsx packages/open-agent-kernel/examples/13-hitl-distributed-cloudbase.ts
pnpm dlx tsx packages/open-agent-kernel/examples/14-session-history.ts
```

## 凭证依赖矩阵

| Example | TCB_API_KEY | TCB_ENV_ID | TENCENTCLOUD_SECRETID/KEY |
|---------|:---:|:---:|:---:|
| 01-quickstart | ✅ | | |
| 02-debug | ✅ | | |
| 03-multi-turn | ✅ | | |
| 04-multi-turn-db | ✅ | ✅ | ✅ |
| 05-multimodal（默认 InMemoryStorage） | ✅ | | |
| 05-multimodal（`OAK_STORAGE=cloudbase`） | ✅ | ✅ | ✅ |
| 06-mcp-sdk-server | ✅ | | |
| 07-mcp-stdio | ✅ | | |
| 08-sandbox | ✅ | ✅ | ✅ |
| 09-sandbox-shared | ✅ | ✅ | ✅ |
| 10-sandbox-cloudbase-tools | ✅ | ✅ | ✅ |
| 11-hitl-approval | ✅ | | |
| 12-hitl-acp-adapter | ✅ | | |
| 13-hitl-distributed-cloudbase | ✅ | ✅ | ✅ |
| 14-session-history | ✅ | | |

## 共享工具

`_shared/env.ts` 在 import 时调 `dotenv.config()` 加载 `.env.local`，并提供 `getEnvId()`、`getPlatformCredentials()`、`getSandboxApiKey()`。示例层负责从环境变量读取凭证，再通过 `createAgent({ credentials })` 显式传给 SDK。`TCB_API_KEY` 会用于 CloudBase AI gateway；常规 sandbox 示例使用 `sandbox: { enabled: true }`，SDK 会复用 `TCB_API_KEY` 作为默认 AGS 数据面凭证，必要时也可用 `OAK_SANDBOX_API_KEY` 单独覆盖；只有 probe 脚本会直接构造 sandbox runtime。
