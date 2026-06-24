# OAK 本地 Runtime 沙箱过渡方案

**Status:** Draft — 待 Phase 0 实施  
**Date:** 2026-06-23  
**Scope:** `@cloudbase/open-agent-kernel`  
**Related:** `AgsStatefulSandbox`、`tcb-remote-workspace` workspace snapshot、Claude Agent SDK 内置工具

---

## 1. 背景

### 1.1 现状

OAK 当前默认沙箱方案基于 **腾讯云 AGS（Agent Sandbox）** 产品：

- 控制面：AGS OpenAPI（CreateSandboxTool / StartSandboxInstance）
- 数据面：TRW 业务镜像 HTTP Gateway（`/api/tools/*`、`/api/workspace/*`）
- 工具暴露：禁用 Claude SDK 内置工具，改注入 `mcp__sandbox__*` MCP server

用户启用沙箱需自行配置：`CLOUDBASE_APIKEY`、`OAK_SANDBOX_IMAGE`、`OAK_SANDBOX_TOOL_ROLE_ARN`、`credentials` 等 AGS 控制面凭证。

### 1.2 问题

1. **AGS 产品化未完成**：云开发用户接入 OAK 仍需自行打通 AGS 链路，接入成本高。
2. **TCB↔AGS 对接排期中**：产品化链路尚未上线，短期无法依赖默认 AGS 路径。
3. **云函数等 Serverless Runtime 已可运行 OAK**：宿主进程本身具备可写目录（如 `/tmp`），具备「本地文件 + bash」的物理条件。

### 1.3 目标

在 AGS 产品化就绪前，提供 **Local Runtime 沙箱** 过渡方案：

- 在 OAK **宿主进程**（HTTP 云函数、CloudRun 等）内直接完成文件读写与 bash
- 在配置的工作目录下，于合适时机完成 **COS 双向同步**（restore + snapshot）
- **保留** 现有 AGS 实现，通过 provider 分支切换，便于产品化后平滑迁移

### 1.4 非目标

- 不替代 TRW 全能力（PTY、preview、in-sandbox agents、mcporter 动态 MCP 等）
- 不提供容器级隔离（接受过渡期的安全风险）
- Phase 0 不要求 CloudBase MCP 在 local 模式立即可用

---

## 2. 设计原则

| 原则 | 说明 |
|------|------|
| **Strategy 分支，不删 AGS** | `SandboxRuntime` 协议不变；新增 `LocalRuntimeSandbox`，保留 `AgsStatefulSandbox` |
| **默认 local，显式 ags** | 新用户 `sandbox: { enabled: true }` 默认 `provider: 'local'`；AGS 用户显式 `provider: 'ags-stateful'` |
| **cwd 由调用方主导** | kernel 不硬编码 `/home/user`；推导规则透明、可覆盖 |
| **COS 格式对齐 TRW** | local 模式 snapshot 使用与 TRW 兼容的 tar.zst + key 布局，便于日后切换 backend |
| **生命周期钩子复用** | send 前 restore、send 后 snapshot 沿用现有 `create-agent.ts` 编排 |

---

## 3. 架构总览

```
createAgent({ sandbox: { provider: 'local' | 'ags-stateful' } })
        │
        ▼
resolveSandboxConfig()
        │
   ┌────┴────┐
   │         │
 local    ags-stateful
   │         │
   ▼         ▼
LocalRuntimeSandbox   AgsStatefulSandbox.acquire()
   │         │
   │         └──► SandboxInstance.request() ──► TRW :9000
   │
   ├──► SDK 内置工具 (Bash/Read/Write/Edit/Glob/Grep)
   │
   └──► LocalWorkspaceSyncEngine ──► COS (restore / snapshot)
```

### 3.1 工具面分支

| 模式 | 文件 / Shell | CloudBase 工具 |
|------|-------------|----------------|
| **local** | Claude SDK **内置工具** | Phase 0 默认关闭；Phase 1+ 进程内 MCP |
| **ags-stateful** | `mcp__sandbox__*`（TRW HTTP） | `mcp__cloudbase__*`（沙箱内 mcporter） |
| **none** | 无（维持现状） | 无 |

`permissionMode: 'bypassPermissions'` + PreToolUse hook **两种模式均保留**。

---

## 4. 配置模型

### 4.1 SandboxConfig 扩展

```typescript
export interface SandboxConfig {
  enabled?: boolean

  /**
   * - 'local'（新默认）：宿主进程本地 FS + SDK 内置工具
   * - 'ags-stateful'：现有 AGS + TRW 远程沙箱
   */
  provider?: 'local' | 'ags-stateful'

  /** local 模式：工作区根目录；未设则按 deriveDefaultWorkspaceRoot 推导 */
  workspaceRoot?: string

  /** ags-stateful 专用 */
  apiKey?: string
  scope?: 'session' | 'shared'
  runtime?: unknown

  cloudbaseTools?: boolean
  userCredentials?: SandboxUserCredentials | (() => Promise<SandboxUserCredentials>)

  workspaceSnapshot?: 'auto' | 'enabled' | 'disabled'
  workspaceSnapshotTimeoutMs?: number
  workspaceInitTimeoutMs?: number

  /** local 模式 COS 配置（Phase 1） */
  cos?: LocalCosConfig
}

interface LocalCosConfig {
  bucket?: string
  region?: string
  /** 对象前缀，默认 `/oak-workspaces/{userId}` */
  prefix?: string
}
```

### 4.2 resolveSandboxConfig 行为

```typescript
function resolveSandboxConfig(config: AgentConfig): AgentConfig['sandbox'] | undefined {
  const sandbox = config.sandbox
  if (!sandbox || sandbox.enabled === false) return undefined
  if (sandbox.runtime) return sandbox // 显式 runtime 优先

  const provider = sandbox.provider ?? 'local'

  if (provider === 'local') {
    return {
      ...sandbox,
      enabled: true,
      provider: 'local',
      runtime: new LocalRuntimeSandbox({ workspaceRoot: sandbox.workspaceRoot }),
    }
  }

  if (provider === 'ags-stateful') {
    // 现有逻辑：apiKey、AgsStatefulSandbox、scope 默认 shared
  }

  throw new InvalidConfigError(`unsupported provider: ${provider}`)
}
```

### 4.3 配置示例

**云函数 / Serverless（过渡默认）：**

```typescript
createAgent({
  envId: 'my-env',
  credentials: { secretId, secretKey },
  model: 'glm-5.1',
  cwd: '/tmp/oak-workspaces/demo', // 或省略，使用自动推导
  sandbox: {
    enabled: true,
    // provider: 'local'  // 可省略
    workspaceSnapshot: 'auto',
    cloudbaseTools: false, // Phase 0
  },
})
```

**AGS 产品化路径（不变）：**

```typescript
createAgent({
  envId: 'my-env',
  credentials: { secretId, secretKey },
  model: 'glm-5.1',
  sandbox: {
    enabled: true,
    provider: 'ags-stateful',
    apiKey: process.env.CLOUDBASE_APIKEY,
    scope: 'shared',
    workspaceSnapshot: 'auto',
  },
})
```

---

## 5. LocalRuntimeSandbox

### 5.1 职责

实现现有 `SandboxRuntime` 协议（`backend = 'local'`）：

- `acquire(ctx)`：创建/确认 workspace 目录，返回轻量 `SandboxInstance`
- `release()`：可选触发最终 snapshot；**不删除**本地目录（COS 为 source of truth）

local 模式 **不暴露 HTTP 数据面**。`SandboxInstance.request()` 若被调用应抛明确错误；snapshot 走 `LocalWorkspaceSyncEngine`，不经过 TRW。

### 5.2 acquire 流程

```
1. resolveWorkspacePath(ctx)
   → config.cwd ?? sandbox.workspaceRoot ?? deriveDefaultWorkspaceRoot(ctx)

2. fs.mkdir(root, { recursive: true })

3. probeWritable(root) — 不可写则 ConfigError（serverless 只读 FS 早 fail）

4. return SandboxInstance { id: `local:${conversationId}`, release }
```

---

## 6. cwd 与工作目录

### 6.1 为何不用 `/home/user` 作为通用默认

| 环境 | 说明 |
|------|------|
| TRW / AGS 容器 | `/home/user` 是镜像约定 ✅ |
| SCF 云函数 | 常见可写路径为 `/tmp`，非 `/home/user` |
| CloudRun | 取决于镜像，不一定存在 `/home/user` |

**OAK 不应假设容器布局**；由调用方或平台 env 指定可写路径。

### 6.2 推导优先级

```
effectiveWorkspaceRoot =
  config.cwd                           // 1. AgentConfig.cwd（同时作为 SDK cwd）
  ?? config.sandbox?.workspaceRoot      // 2. sandbox 级覆盖
  ?? deriveDefaultWorkspaceRoot(ctx)    // 3. 平台推导

deriveDefaultWorkspaceRoot(ctx):
  base = process.env.OAK_WORKSPACE_ROOT ?? path.join(os.tmpdir(), 'oak-workspaces')
  return path.join(base, ctx.envId, ctx.userId, ctx.conversationId)
```

### 6.3 与 Claude SDK 对齐

local 模式下 **`AgentConfig.cwd` 必须等于 workspace root**（或与 `sandbox.workspaceRoot` 显式一致）。SDK 内置工具以 `cwd` 为工作目录；COS 同步同一目录树。

若 `config.cwd` 与 `sandbox.workspaceRoot` 冲突 → `ConfigError`。

---

## 7. SDK 内置工具分支

### 7.1 当前行为

`agent-builder.ts` 禁用全部 SDK 内置工具，仅保留 `Skill`（若启用 skills）：

```typescript
tools: config.skills?.enabled !== undefined ? ['Skill'] : [],
```

远程沙箱能力通过 `createSandboxMcpServer(sandboxInstance)` 注入。

### 7.2 改造后

```typescript
function resolveSdkTools(config, sandboxMode: 'local' | 'remote' | 'none') {
  if (sandboxMode === 'local') {
    const tools = ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep']
    if (config.skills?.enabled !== undefined) tools.push('Skill')
    return tools
  }
  if (sandboxMode === 'remote') {
    return config.skills?.enabled !== undefined ? ['Skill'] : []
  }
  return config.skills?.enabled !== undefined ? ['Skill'] : []
}
```

| sandboxMode | 注入 sandbox MCP | SDK tools |
|-------------|------------------|-----------|
| `local` | 否 | Bash, Read, Write, Edit, Glob, Grep (+ Skill) |
| `remote` | 是 (`mcp__sandbox__*`) | Skill only 或 [] |
| `none` | 否 | 维持现状 |

---

## 8. COS 双向同步（Local 模式）

### 8.1 与 AGS 模式对比

| | AGS + TRW | Local |
|--|-----------|-------|
| Restore | `POST /api/workspace/init`（TRW 内 restoreFromCos） | OAK 进程内 `restoreFromCos()` |
| Snapshot | `POST /api/workspace/snapshot` | OAK 进程内 `snapshotToCos()` |
| 格式 | tar.zst | **兼容同一格式** |

### 8.2 模块结构（Phase 1 新增）

```
src/sandbox/local-workspace-sync/
├── cos-client.ts       # CloudBase / COS SDK 上传下载
├── snapshot-pack.ts    # tar + zstd（参考 TRW tests/helpers）
├── restore.ts
├── snapshot.ts
├── excludes.ts         # node_modules、.git 等（对齐 TRW snapshot-excludes）
└── engine.ts           # LocalWorkspaceSyncEngine
```

### 8.3 COS Key 布局（与 TRW 对齐）

```
cos://{bucket}/oak-workspaces/{userId}/.snapshot-{timestamp}.tar.zst
cos://{bucket}/oak-workspaces/{userId}/.snapshot-latest.json
```

### 8.4 触发时机

沿用 `create-agent.ts` / `runClaudeQuery` 现有钩子：

| 时机 | 动作 | 失败策略 |
|------|------|----------|
| 首次 `send()` 前 | `restoreFromCos(workspaceRoot)` | **致命**（与 Spec B 一致） |
| 每次 `send()` finally | `snapshotToCos(workspaceRoot)` | **非致命** warning |
| `session.abort()` | 可选最终 snapshot | best-effort |
| 写操作后 debounced sync | Phase 2 可选 | 非致命 |

### 8.5 resolveSnapshotMode 扩展

```typescript
const supportsSnapshot = backend === 'ags-stateful' || backend === 'local'

// ags-stateful：仍要求 scope === 'shared'（现有约束）
// local：不要求 shared scope；用 conversationId 子目录 + COS userId prefix 隔离
```

---

## 9. CloudBase MCP（local 模式）

当前 `cloudbase-mcp.ts` 依赖 `SandboxInstance.request` + 沙箱内 mcporter bash，**无法在 local 模式直接复用**。

| Phase | 方案 |
|-------|------|
| **P0** | local 默认 `cloudbaseTools: false` |
| **P1** | `createCloudBaseMcpServerInProcess()`：进程内 mcporter 或 TCB Node SDK 封装 |
| **P2** | TCB 产品化 MCP Gateway，统一 local / remote |

---

## 10. Session 编排改造

### 10.1 抽象 sandboxMode

```typescript
type SandboxMode = 'none' | 'local' | 'remote'

async function prepareSandboxSession(...) {
  if (mode === 'local') {
    const workspaceRoot = await localRuntime.prepare(ctx)
    if (syncEngine) await syncEngine.restore(workspaceRoot)
    return { mode: 'local', workspaceRoot }
  }
  if (mode === 'remote') {
    const sandbox = await agsRuntime.acquire(ctx)
    if (syncEngine) await syncEngine.bootstrap(sandbox)
    return { mode: 'remote', sandboxInstance: sandbox }
  }
}
```

### 10.2 buildClaudeQueryOptions 入参

```typescript
buildClaudeQueryOptions(config, {
  sandboxMode: 'local' | 'remote' | 'none',
  sandboxInstance?: SandboxInstance,  // remote only
  workspaceRoot?: string,             // local only
  ...
})
```

---

## 11. 安全与风险

local 模式为 **临时过渡**，必须在文档与运行时 warning 中明确：

| 风险 | 说明 | 缓解 |
|------|------|------|
| 无容器隔离 | agent bash 与 OAK 同进程/同 VM | 仅 trusted 场景；生产加 network policy |
| 路径逃逸 | 内置工具可能访问 cwd 外 | Phase 2：workspaceRoot path guard |
| 多租户 | 同实例多 user | 必须 userId + conversationId 子目录 + COS prefix |
| 凭证泄露 | bash 可读进程 env | 延续 AGENTS.md 日志静态字符串规则 |
| 并发 snapshot | 云函数多并发同 conversation | Phase 2：COS 乐观锁 / 版本号 |

**启动 warning（每 session 一次）：**

```
[oak][sandbox] provider=local is transitional — no container isolation.
Use provider='ags-stateful' when TCB sandbox product is available.
```

---

## 12. 实施分期

### Phase 0 — 最小可用

- [ ] `LocalRuntimeSandbox` + `provider: 'local'` 默认
- [ ] `resolveSdkTools`：local 启用 SDK builtin
- [ ] `workspaceRoot` / `cwd` 推导与可写性检查
- [ ] `workspaceSnapshot: 'disabled'` 为 local 默认（先验证工具链）
- [ ] 示例 `examples/08-local-sandbox.ts`
- [ ] AGS 路径零行为变化（显式 `provider: 'ags-stateful'`）

### Phase 1 — COS 持久化

- [ ] `local-workspace-sync` 模块（restore + snapshot）
- [ ] `resolveSnapshotMode` 支持 `backend = 'local'`
- [ ] send 前 restore / send 后 snapshot
- [ ] E2E：写文件 → 新 session 读回

### Phase 2 — 体验与安全

- [ ] workspaceRoot path guard
- [ ] debounced snapshot、并发锁
- [ ] CloudBase in-process MCP
- [ ] OpenVibeCoding server 默认切 local provider

### Phase 3 — 产品化切换

- [ ] TCB↔AGS 上线后：`provider` 默认改 `ags-stateful` 或 `auto`（平台能力探测）
- [ ] local 标记 `@deprecated`，保留供本地 dev / 单测

---

## 13. 文件改动清单（预估）

| 文件 | 改动 |
|------|------|
| `src/public/types.ts` | `provider`、`workspaceRoot`、`cos` |
| `src/public/create-agent.ts` | `resolveSandboxConfig` 默认 local；session 编排 |
| `src/sandbox/local-runtime-sandbox.ts` | **新增** |
| `src/sandbox/local-workspace-sync/*` | **新增**（Phase 1） |
| `src/runtime/agent-builder.ts` | `resolveSdkTools`、snapshot mode、MCP 分支 |
| `src/sandbox/workspace-snapshot/*` | 抽象 sync backend（HTTP vs local） |
| `src/sandbox/ags-stateful-sandbox.ts` | 保留，无删改 |
| `examples/08-local-sandbox.ts` | **新增** |
| `README.md` | 过渡方案说明 |

---

## 14. 决策记录

| 决策 | 选择 | 理由 |
|------|------|------|
| 是否删除 AGS 实现 | **否** | 产品化排期中，避免重复建设 |
| 默认 provider | **local** | 降低云开发用户接入门槛 |
| cwd 默认值 | **不硬编码 /home/user** | Serverless 环境差异大 |
| local 工具来源 | **SDK 内置** | 无需 TRW HTTP，与 remote MCP 对称分支 |
| COS 格式 | **对齐 TRW tar.zst** | 便于 backend 切换与数据迁移 |
| CloudBase MCP P0 | **默认关闭** | 依赖沙箱 bash，需独立 Phase |

---

## 15. 参考

- `packages/open-agent-kernel/src/sandbox/ags-stateful-sandbox.ts` — AGS 控制面/数据面
- `packages/open-agent-kernel/docs/superpowers/specs/2026-06-08-oak-workspace-snapshot.md` — Spec B 快照
- `tcb-remote-workspace/src/cos-sync.ts` — TRW COS rsync / tar.zst 实现
- `tcb-remote-workspace/src/routes/api.ts` — TRW HTTP 路由
- `packages/open-agent-kernel/src/runtime/agent-builder.ts` — SDK tools / cwd 逻辑
