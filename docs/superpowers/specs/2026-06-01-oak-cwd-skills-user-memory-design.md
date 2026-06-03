# Spec A:`cwd` + `skills` + `userMemory` 设计

> 文档编号:Spec A(v3)
> 创建日期:2026-06-01(v3 修订:2026-06-03)
> 分支:`feat/support-open-agent-kernel`
> 状态:待 review
> 关联后续:Spec B(沙箱工作区快照)
>
> **v3 变更**:推翻 v1/v2 的"工具型 MemoryStore + MCP 工具"方案,改为"基于 SDK 原生 `.claude/` 目录的同步方案"。详见 §8 与 §11。

## 1. 背景与动机

### 1.1 现状问题

OAK SDK 当前(commit `8205190`)在 `agent-builder.ts:167` 硬编码 `settingSources: []`,目的是切断对宿主机 `~/.claude/` 配置的依赖,实现"云服务不依赖本机配置"的部署语义。

这个决策的代价是:
1. **Skills 能力被堵死** — Claude Agent SDK 的 `skills` 选项依赖 `settingSources` 含 `'project'` 才能扫描 SKILL.md(证据:`@anthropic-ai/claude-agent-sdk/sdk.d.ts:1742-1764, 2815-2817`)。
2. **SDK 原生长期记忆机制完全失效** — Claude SDK 自带 auto-memory(`autoMemoryEnabled`,默认开启)、auto-dream(`autoDreamEnabled`,后台合成段落)、用户级 CLAUDE.md、subagent memory 等机制,**全部依赖 `~/.claude/` 文件系统**。OAK 当前完全无法利用。
3. **类型层有"幽灵 API"** — `SandboxCapabilities` 接口已声明 `skills` / `memory` / `compaction` 字段(`public/types.ts:130-138`),但 `agent-builder.ts` 完全不读取,用户配置无效但不报错。

### 1.2 用户需求

业务方需要:
- **平台级 Skills**:在 SDK 上层业务服务里管理一份 SKILL.md 集合,所有节点共享同一套(如 SkillHub 安装到固定路径)。
- **用户级长期记忆**:跨 conversation 沉淀的"对这个用户的认知",必须分布式可用(任何节点接到该用户都能拿到)。**且应该利用 SDK 原生的 auto-memory + dream 智能能力,不是自己造工具型 KV 简化版**。
- **保持多租户隔离**:云服务部署的 SDK 不能引入跨租户串扰。

### 1.3 核心心智(v3)

OAK 选 Claude Agent SDK 的核心理由是 SDK 在 memory / dream / plan / skills / agent 等维度的领先能力。**OAK 不应自创"代理层"重新实现这些**,而应该:

1. 让 SDK 的 `.claude/` 文件系统机制完整工作(打开 `settingSources`、不堵 auto-memory)
2. 通过 `CLAUDE_CONFIG_DIR` 环境变量 per-user 重定向,解决多租户隔离问题
3. 把 SDK 自动写入的 `.claude/` 子集作为同步对象,落到该 envId 对应的 CloudBase COS
4. 跨节点访问同 user 时,先从 COS 拉到本地副本,SDK 像在本地一样工作

→ **SDK 是真理层,COS 是分布式持久化层,本地 `<CLAUDE_CONFIG_DIR>` 是工作副本**(类比 git origin / 本地仓库)。

### 1.4 不在本 Spec 范围内

- 沙箱工作区快照 / 持久化 → Spec B(完全独立)
- 项目级 CLAUDE.md / settings.json / skills 文件 → 视作"平台资产",由业务方在镜像/cwd 中管理,**不同步**
- `compaction` 能力 → SDK 自带且默认开启,本 Spec 不动
- Plan 持久化 → 当前 SDK 原生 plan mode 不写文件(GitHub `anthropics/claude-code#14866` 跟踪),plan 内容已在 transcript 内,通过既有 `CloudBaseSessionStore` 跨节点 resume

## 2. 设计原则

1. **SDK 原生机制优先** — 不重新发明 SDK 已有的 memory / dream / agent-memory,只做"让它在分布式云端工作"的基础设施。
2. **CLAUDE_CONFIG_DIR per-user** — 这是 SDK 官方支持的隔离开关,直接利用,不绕过。
3. **同步而非代理** — 节点本地 `.claude/` 是工作副本,真理在 COS;不让 OAK 介入 SDK 与文件之间。
4. **零隐式行为开关** — 同步默认关闭(`userMemory.enabled = false`),开启后行为完全透明可观测。
5. **平台资产 vs 用户私产分离** — Skills / 项目级 CLAUDE.md 走业务方自管(cwd);用户私产走 COS 同步。两者载体不同,职责不同。

## 3. 公共 API 增量

### 3.1 顶层 `AgentConfig` 新增字段

```typescript
interface AgentConfig {
  // ────── 既有字段(零改动)──────
  envId: string
  model: string | ModelSpec
  systemPrompt?: string
  sandbox?: SandboxConfig            // 完全不动
  session?: SessionConfig
  permissions?: PermissionConfig
  mcpServers?: Record<string, McpServerConfig>
  storage?: StorageProvider
  hooks?: AgentHooks
  
  // ────── 新增 1:平台资产层(宿主机 cwd)──────
  /**
   * SDK 加载本机文件型资产的根目录。
   * 影响:Skills 扫描根、项目级 CLAUDE.md 查找根、SDK 子进程 spawn cwd。
   * 默认:OAK 自管的纯净 ephemeral 目录(无 skills、无 CLAUDE.md,等价当前 v0 行为)。
   * 业务方通常传镜像内的固定路径(如 '/app/skills-bundle')。
   *
   * ⚠️ 安全:OAK 内部强制 settingSources 仅含 'project',永远不读 'user'(宿主机 ~/.claude)。
   */
  cwd?: string
  
  /**
   * 启用 Claude Agent SDK 的 skills 能力。
   * SDK 在 cwd/.claude/skills/ 下扫描 SKILL.md,按 enabled 过滤后注入到 system prompt。
   * 不传或 enabled 未配 → skills 关闭(等价 v0 行为)。
   */
  skills?: {
    enabled?: 'all' | string[]
  }
  
  // ────── 新增 2:用户级长期记忆(SDK 原生 .claude/ 同步)──────
  /**
   * 用户级长期记忆。启用后:
   *   1. SDK 子进程的 CLAUDE_CONFIG_DIR 自动按 (envId, userId) 派生到独立目录
   *   2. session 启动时从该 envId 对应的 CloudBase COS 拉取该 user 的 .claude/ 内容
   *   3. 运行期 30s 周期增量推送变更回 COS
   *   4. session 结束时全量推送兜底
   *
   * 同步范围:仅 SDK 自动写入的"用户私产"
   *   - <CLAUDE_CONFIG_DIR>/CLAUDE.md(用户级偏好)
   *   - <CLAUDE_CONFIG_DIR>/projects/*/memory/(主会话 auto-memory + dream 产物)
   *   - <CLAUDE_CONFIG_DIR>/agent-memory/(用户级 subagent memory)
   *   - <cwd>/.claude/agent-memory/(项目级 subagent memory,若 cwd 在受控目录)
   *
   * 不同步:settings.json / skills / commands / rules / agents 这些"平台资产"。
   *
   * 默认:disabled(等价 v0 行为,无任何同步)。
   *
   * 依赖:启用时该 envId 必须开通 CloudBase COS。COS 不可达时记 warning,
   * 不阻塞 session 启动(graceful degrade — agent 仍可工作,只是不同步)。
   *
   * 这不是工具型 KV memory,是基于 SDK 原生文件系统机制的分布式同步。
   * 详细驳回理由见 §8.1。
   */
  userMemory?: {
    enabled?: boolean
  }
}
```

### 3.2 沙箱配置 — 零改动

```typescript
sandbox: {
  runtime: SandboxRuntime,
  scope?: 'session' | 'shared',     // 既有,语义不变(AGS 实例粒度)
  cloudbaseTools?: boolean,
  userCredentials?: ...,
}
```

不引入 `workspaceRoot` / `workspaceLayout`,工作区目录派生由沙箱镜像负责(`STATEFUL_WORKSPACE_ROOT='/home/user'` + 镜像内按 conversationId 分子目录,见 server `feature/stateful-infra:packages/server/src/sandbox/git-archive.ts:150` 注释)。

### 3.3 注释术语对齐(顺手改)

`public/types.ts:70-74` 对 `scope` 的注释补充与 server `sandboxMode` 的对应:

```typescript
/**
 * - 'session'(默认):每个 startSession 一个独立 AGS 实例
 *   (对应 server feature/stateful-infra 的 sandboxMode: 'isolated')
 * - 'shared':同 envId 多个 session 共享一个 AGS 实例
 *   (对应 server feature/stateful-infra 的 sandboxMode: 'shared')
 *
 * 注意:这两个 scope 是 AGS 实例粒度,与"沙箱内工作区目录"是两层正交关系。
 * 工作区目录派生由沙箱镜像负责(/home/user/{conversationId}/ 约定),SDK 不感知。
 */
scope?: 'session' | 'shared'
```

### 3.4 同步范围(精确清单)

仅同步以下 **SDK 自动写入** 的路径(基于官方文档 https://code.claude.com/docs/en/claude-directory):

| 同步? | 路径 pattern | 谁写 | 用途 |
|---|---|---|---|
| ✅ | `<CONFIG_DIR>/CLAUDE.md` | 用户(`/memory` 命令辅助) | 用户级偏好 |
| ✅ | `<CONFIG_DIR>/projects/<project-hash>/memory/MEMORY.md` | **SDK auto** | 主会话自动记忆索引 |
| ✅ | `<CONFIG_DIR>/projects/<project-hash>/memory/*.md` | **SDK auto + dream** | 自动记忆主题展开 + dream 合成 |
| ✅ | `<CONFIG_DIR>/agent-memory/<agent>/MEMORY.md` | **SDK auto** | 用户级 subagent memory(`memory: user`) |
| ✅ | `<cwd>/.claude/agent-memory/<agent>/MEMORY.md` | **SDK auto** | 项目级 subagent memory(`memory: project`,前提 cwd 是 OAK 派生的受控目录) |
| ❌ | `<CONFIG_DIR>/settings.json` | 用户 | 平台配置,不同步 |
| ❌ | `<CONFIG_DIR>/skills/`、`commands/`、`rules/`、`agents/` | 用户 | 平台资产,业务方在镜像/cwd 管理 |
| ❌ | `<CONFIG_DIR>/themes/`、`keybindings.json`、`output-styles/` | 用户 | UI 偏好,与服务端 agent 无关 |
| ❌ | `<CONFIG_DIR>/.claude.json` | SDK | 含 OAuth session、IDE 状态等本机偏好,不应跨节点 |
| ❌ | `<CONFIG_DIR>/projects/<hash>/transcripts/` | SDK | 已被 `CloudBaseSessionStore` 覆盖,避免重复持久化 |

**同步规则用通配符表达**:

```typescript
const SYNC_INCLUDES = [
  'CLAUDE.md',
  'projects/*/memory/**',
  'agent-memory/**/MEMORY.md',
] as const

// 项目级 subagent memory 在 cwd/.claude/agent-memory/ 下,
// 由 OAK 派生的受控 ephemeral cwd 时一起同步;业务方传的 cwd 不在此列(那是平台资产)
```

## 4. 内部实现要点

### 4.1 `agent-builder.ts` 改动概览

```typescript
// 1) 用户传了 cwd:走"受控 settingSources"路径
//    - 透传 SDK 的 cwd option
//    - settingSources 设为 ['project']
// 2) 用户没传 cwd:走"isolation mode"路径(等价 v0)
//    - SDK 用 OAK 派生的 ephemeral 目录作 cwd
//    - settingSources 设为 []

// 3) userMemory.enabled = true:
//    - 派生 per-user CLAUDE_CONFIG_DIR = /tmp/oak/{envId}/{userId}/.claude/
//    - 注入 env.CLAUDE_CONFIG_DIR
//    - 启动 sync engine(acquire pull → 30s push → release final push)
// 4) userMemory.enabled = false(默认):
//    - 不设置 CLAUDE_CONFIG_DIR(SDK 用默认 ~/.claude/),但 settingSources=[] 让 SDK 不读它
//    - 维持当前 v0 isolation 行为
```

### 4.2 per-user `CLAUDE_CONFIG_DIR` 派生

```typescript
function deriveClaudeConfigDir(envId: string, userId: string): string {
  // 安全:envId / userId 走 sanitize,避免目录穿越
  const safeEnv = sanitizePathSegment(envId)
  const safeUser = sanitizePathSegment(userId)
  return path.join(os.tmpdir(), 'oak', safeEnv, safeUser, '.claude')
}

function sanitizePathSegment(s: string): string {
  // 只允许 [a-zA-Z0-9._-],其余字符替换为 _
  return s.replace(/[^a-zA-Z0-9._-]/g, '_')
}
```

**安全约束**:
- envId / userId 必须 sanitize,防止 `../` 注入
- 派生路径必须以 `os.tmpdir()` 开头(运行时 assert)
- 永远不接受用户直接传 `CLAUDE_CONFIG_DIR`(业务侧无此 API)

### 4.3 同步引擎(`sync-engine.ts`)

```typescript
class ClaudeHomeSyncEngine {
  // session 启动时调用
  async pullOnAcquire(envId: string, userId: string, localDir: string): Promise<void>
  
  // 内部周期任务(每 30s),session 期间运行
  private async pushPeriodic(envId: string, userId: string, localDir: string): Promise<void>
  
  // session abort 时调用(兜底全量推 + 停周期任务)
  async pushOnRelease(envId: string, userId: string, localDir: string): Promise<void>
}
```

**周期推送的实现**:
- 用 `chokidar` 或 mtime polling 检测变化(优先 chokidar — Node 文件 watcher 现成稳定)
- 维护 in-memory dirty set,每 30s flush
- COS 上传走 multi-part(支持大文件),按文件粒度 PUT

**冲突策略(MVP:LastWriteWins)**:
- 同一 user 同时在两个节点活跃 → 后写盖前写
- MVP 接受这种行为(同 user 多节点改 CLAUDE.md 概率极低)
- V2 评估 ETag + 后台 merge 方案

### 4.4 `ClaudeHomeSyncStore` 抽象(internal,不公开 export)

虽然不在公共 API 暴露,内部仍保留抽象层用于:
- 单元测试可替换为 `InMemoryClaudeHomeStore`
- 未来若要换后端(OSS / S3)零成本

```typescript
// src/claude-home/types.ts (internal)
interface ClaudeHomeSyncStore {
  /**
   * 把 COS 上 (envId, userId) 命名空间下的全部对象拉到 localDir。
   * 不存在时静默(首次访问的用户)。
   */
  pull(ctx: ClaudeHomeContext, localDir: string): Promise<void>
  
  /**
   * 把 localDir 下符合 SYNC_INCLUDES 的文件推到 COS。
   * `since` 不为空时只推 mtime > since 的文件(增量)。
   */
  push(ctx: ClaudeHomeContext, localDir: string, since?: number): Promise<void>
}

interface ClaudeHomeContext {
  envId: string
  userId: string
}
```

### 4.5 默认实现:`CloudBaseCosClaudeHomeStore`(internal)

- 复用现有的 `userCredentials` 派生链(同 `cloudbase-mcp.ts`)
- COS key pattern: `oak/users/{userId}/claude-home/<relative-path>`
- 桶名走该 envId 默认 COS 桶(从 `@cloudbase/node-sdk` 的环境配置派生)

```typescript
class CloudBaseCosClaudeHomeStore implements ClaudeHomeSyncStore {
  async pull(ctx, localDir) {
    // 1. ListObjects with prefix `oak/users/{userId}/claude-home/`
    // 2. 并发 GetObject,落到 localDir/<relative-path>
    // 3. 维护一个 mtime snapshot 作为下次 push 的 since 起点
  }
  
  async push(ctx, localDir, since) {
    // 1. walk localDir,过滤 SYNC_INCLUDES,过滤 mtime <= since
    // 2. 并发 PutObject
    // 3. 错误聚合:单文件失败不阻塞其他,记 warning
  }
}
```

**graceful degrade**:任一阶段网络/凭证错误 → 记 warning + 上报 metric,**绝不阻塞 session 启动**(agent 仍可工作,只是不同步)。

### 4.6 `agent-builder.ts` 中 userMemory 的接入

```typescript
function buildClaudeQueryOptions(config, extra) {
  // ...既有逻辑...
  
  let claudeConfigDir: string | undefined
  let syncEngine: ClaudeHomeSyncEngine | undefined
  
  if (config.userMemory?.enabled && extra.userId) {
    claudeConfigDir = deriveClaudeConfigDir(config.envId, extra.userId)
    syncEngine = new ClaudeHomeSyncEngine({
      store: new CloudBaseCosClaudeHomeStore(/* 复用 cred */),
      envId: config.envId,
      userId: extra.userId,
      localDir: claudeConfigDir,
    })
    // pull 在 session.send 前异步执行,等待完成再继续
  }
  
  const env = {
    ...process.env,
    ANTHROPIC_BASE_URL: credential.baseUrl,
    ANTHROPIC_AUTH_TOKEN: credential.apiKey,
    // ...
    ...(claudeConfigDir ? { CLAUDE_CONFIG_DIR: claudeConfigDir } : {}),
  }
  
  // sync engine 的生命周期挂在 session 上,session abort 时调 pushOnRelease
  return { options, credential, syncEngine }
}
```

### 4.7 新增模块结构

```
packages/open-agent-kernel/src/claude-home/   (internal,不在 src/index.ts public export)
  ├─ types.ts                       # ClaudeHomeSyncStore / ClaudeHomeContext (internal)
  ├─ in-memory-store.ts             # InMemoryClaudeHomeStore(测试用)
  ├─ cloudbase-cos-store.ts         # CloudBaseCosClaudeHomeStore(唯一生产实现)
  ├─ sync-engine.ts                 # ClaudeHomeSyncEngine(pull / periodic push / final push)
  ├─ path-derivation.ts             # deriveClaudeConfigDir + sanitizePathSegment
  ├─ sync-rules.ts                  # SYNC_INCLUDES 通配符列表 + matcher
  ├─ __tests__/
  │   ├─ path-derivation.test.ts
  │   ├─ sync-rules.test.ts
  │   ├─ in-memory-store.test.ts
  │   └─ sync-engine.test.ts
  └─ index.ts                       # 内部 facade(不被 src/index.ts re-export)
```

`src/index.ts` 增量 export:**无新增 public 类型**(API 表面积更小 — 只多了 `userMemory` 一个对象字段)。

### 4.8 删除"幽灵 API"

`public/types.ts:124-139` 的 `SandboxCapabilities` 接口里 `skills` / `memory` / `compaction` 三个字段:
- `skills` → 删除(取代为顶层 `skills`)
- `memory` → 删除(取代为顶层 `userMemory`)
- `compaction` → 删除(SDK 自带,无需暴露)

`SandboxCapabilities` 仅保留 `filesystem` / `shell`(这两个 SDK 工具层面有意义)。这是**破坏性改动**,但因为这些字段从未真正生效,实际无业务方依赖,接受。

## 5. 边界与约束

### 5.1 安全约束

| 约束 | 位置 | 实现策略 |
|---|---|---|
| 永远不打开 `settingSources: 'user'` | `agent-builder.ts` | 内部硬编码 settingSources 派生只产出 `[]` 或 `['project']`,不接受用户传入完整 SettingSource 数组 |
| 永远不打开 `settingSources: 'local'` | 同上 | 同上 |
| 用户传的 `cwd` 安全检查 | 运行时 validate | 拒绝以下值:`~/.claude` / `~/.claude/...` / `/Users/.../.claude` / 任何包含 `.claude` 段且指向 `os.homedir()` 子树的路径 |
| `CLAUDE_CONFIG_DIR` 仅由 OAK 派生 | `agent-builder.ts` | 业务侧无 API 设置;内部派生路径必须以 `os.tmpdir()` 开头 + envId/userId sanitize |
| COS key pattern 强约束 | `cloudbase-cos-store.ts` | 写 key 前必须以 `oak/users/{userId}/claude-home/` 开头,assert 防越权 |
| 同步范围按白名单(不是黑名单) | `sync-rules.ts` | SYNC_INCLUDES 是 allow-list,不在列表内的文件不上传(避免误传 `.claude.json` OAuth token 等) |

### 5.2 兼容性

- 三个新字段全为 optional,默认值与 v0 行为完全一致
- 现有用户零迁移成本
- 唯一破坏性改动:`SandboxCapabilities` 删 3 个未生效字段(可接受)

### 5.3 不解决的问题

- **沙箱工作区文件持久化** → Spec B
- **跨节点同 user 的"工作区"复用** → Spec B(快照 + 恢复)
- **同一 user 多节点并发写冲突** → MVP 用 LastWriteWins,V2 评估 ETag 乐观锁 / 后台 merge
- **大文件 / 二进制 memory** → MVP 不限制大小但建议每文件 < 10MB,V2 评估分片
- **COS 不可用降级** → MVP 仅 warning + 继续运行(不同步),V2 评估本地缓存兜底
- **SDK 文件格式演进** → 同步是文件级的,SDK 加了 `~/.claude/insights/` 等新目录时,只需更新 SYNC_INCLUDES 即可,不影响 API

### 5.4 容量与清理

MVP **不实现**自动清理。schema 上无 TTL 字段(同步对象就是 SDK 自己写的 .md,SDK 会自管)。

容量上限:依赖 COS 的存储计费,业务方自管。SDK 维护的 memory 文件通常每 user 不超过 1MB(主 MEMORY.md 25KB 上限 + 几十个主题文件)。

## 6. 测试策略

### 6.1 单元测试

| 测试对象 | 关键场景 |
|---|---|
| `deriveClaudeConfigDir` | envId/userId 含特殊字符 → sanitize 正确 / 派生路径必在 tmpdir 内 / 跨 user 完全隔离 |
| `sanitizePathSegment` | `../` / 绝对路径 / unicode / 空字符串边界 |
| `sync-rules` matcher | SYNC_INCLUDES 命中正确 / 排除项被忽略 / 边界路径(空、单文件、深嵌套) |
| `InMemoryClaudeHomeStore` | pull 后 localDir 内容正确 / push 增量基于 since / 不存在的 namespace 静默 |
| `CloudBaseCosClaudeHomeStore` | mock COS SDK,验证 key pattern / 错误聚合 / 凭证派生 |
| `ClaudeHomeSyncEngine` | acquire pull → file change → 30s 后 push 触发 / release final push 兜底 |
| `agent-builder.ts` cwd 分支 | 用户传 cwd → settingSources=['project'];未传 → settingSources=[] |
| `agent-builder.ts` skills 透传 | skills.enabled=string[] / 'all' 都正确透传 |
| `agent-builder.ts` userMemory 接入 | enabled=true 时 CLAUDE_CONFIG_DIR 注入 + 派生路径在 tmpdir / disabled 时无注入 |
| 多租户隔离 | 同 envId 不同 userId → COS key 完全隔离 / 不同 envId 同 userId 字符串 → 完全隔离 |

### 6.2 集成示例(examples/)

新增 3 个 example:
- `15-skills.ts`:演示业务方在 `cwd: '/path/to/skills-bundle'` 下放 `.claude/skills/foo/SKILL.md`,启用 `skills: { enabled: 'all' }`,agent 自动用上 skill
- `16-user-memory.ts`:演示开启 `userMemory.enabled = true` 后,首轮对话告诉 agent 一个事实 → 第二个 conversation(同 userId)里 agent 通过 SDK auto-memory 主动想起这个事实
- `17-user-memory-distributed.ts`:演示 memory 跨节点 — 节点 A 跑一段对话 release,节点 B 同 userId 启动,验证记忆完整恢复

### 6.3 多租户隔离验证

example 16 / 17 必须显式验证:
- 同 envId 不同 userId → COS key + 本地 dir 完全隔离
- 不同 envId(同 userId 字符串)→ 完全隔离
- 同 envId 同 userId 不同 conversation → 共享 memory(这就是长期记忆的目的)

## 7. 实施阶段拆分(给 writing-plans 的提示)

| 阶段 | 内容 | 可独立合并 |
|---|---|---|
| **A1** | `path-derivation.ts` + `sync-rules.ts` + 单元测试(纯函数,无依赖) | ✅ |
| **A2** | `ClaudeHomeSyncStore` 接口 + `InMemoryClaudeHomeStore` + 单元测试 | ✅ |
| **A3** | `CloudBaseCosClaudeHomeStore` + 错误处理 + 集成测试(mock COS) | ✅ |
| **A4** | `ClaudeHomeSyncEngine` 三阶段流程(pull / periodic / final) + 测试 | ✅ |
| **A5** | cwd / skills 透传到 SDK + settingSources 受控解封 + 安全 validate | ✅ |
| **A6** | userMemory 接入 `agent-builder.ts`(CLAUDE_CONFIG_DIR 注入 + sync engine 挂载到 session 生命周期) | ⚠️ 依赖 A1-A5 |
| **A7** | 删除 `SandboxCapabilities` 的 3 个幽灵字段 + sandbox scope 注释术语对齐 | ✅(破坏性,minor 版本) |
| **A8** | examples 15/16/17 + README 章节(平台资产 vs 用户私产 + 两层粒度 + userMemory 同步说明) | ✅ |

推荐顺序:A1 → A2 → A3 → A4 / A5(并行)→ A6 → A7 → A8。

## 8. 已驳回的方案与理由

### 8.1 ❌ 工具型 MemoryStore + `mcp__oak_memory__*`(v1/v2 方案)

**驳回理由**:
1. **违背选 SDK 的初衷**:OAK 选 Claude Agent SDK 的核心理由就是它领先的 memory + dream 机制。自建 KV 工具等于放弃 SDK 智能,变成"用 SDK 当模型调用层"。
2. **无法利用 dream 智能召回**:SDK 的 supervisor 用额外 LLM pass 做语义召回 + dream 合成段落,工具型 KV 做不到。
3. **数据形态绑死自建 schema**:工具型 KV 的 content/tags/importance 是 OAK 自创,SDK 演进不带来红利。
4. **业务方需在 systemPrompt 引导 agent 主动调用工具** → 模型大概率不调,实际效果差(LangMem 也踩过这个坑)。

### 8.2 ❌ 用户级 CLAUDE.md 走文件物化(v1 短暂考虑)

**驳回理由**:Claude Agent SDK 不支持"per-user CLAUDE.md"概念。但 v3 通过 `CLAUDE_CONFIG_DIR` per-user 派生 + COS 同步把这个能力补上了 — `<CONFIG_DIR>/CLAUDE.md` 就是用户级偏好,SDK 原生支持。

### 8.3 ❌ 暴露 `sandbox.workspaceLayout`

**驳回理由**:工作区目录派生由沙箱镜像负责(stateful-infra 既定语义),SDK 在这一层做配置只会增加用户理解成本,不解决任何问题。

### 8.4 ❌ scope 默认改为 'shared'(对齐 server)

**驳回理由**:虽然 server feature/stateful-infra 默认 'shared',但 OAK SDK 的目标用户场景更广泛(包含纯 stateless API 网关型用法),保持 'session' 作为默认更安全。注释说明对应关系即可,不强制对齐默认值。

### 8.5 ❌ 把 `userMemory.store` / `syncInterval` 暴露给业务方

**驳回理由**:业务方不需要也不应该理解 store 抽象 / 同步频率细节。`userMemory.enabled = true` 一个开关足够。
- 未来若有客户提"换 OSS 后端",SDK 内部抽象已经在(internal),加公共字段成本是 0
- `syncInterval` 业务方多半想不清楚怎么填,30s 是工程经验值

### 8.6 ❌ 暴露 SDK 的 `autoMemoryEnabled` / `autoMemoryDirectory` 给业务方

**驳回理由**:
- `autoMemoryEnabled` SDK 默认开启,OAK 不动它(继承默认行为)
- `autoMemoryDirectory` 默认指向 `~/.claude/projects/<sanitized-cwd>/memory/`,在 OAK 派生的 `CLAUDE_CONFIG_DIR` 下自然变为安全路径,**不需要业务方配**
- 业务方真要关闭 auto-memory,可在自己的 systemPrompt 里 instruct,或等未来按需开放

## 9. 引用证据

### 9.1 SDK 与 OAK 内部代码

- Claude Agent SDK 类型(本机路径):
  `packages/open-agent-kernel/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:1265,1267,1739,1742-1764,2815-2817,5265-5273,5316-5318,5413`
  (`autoMemoryEnabled` 默认开启 / `autoMemoryDirectory` 默认 `~/.claude/projects/<sanitized-cwd>/memory/` / `claudeMd` 仅 managed)
- OAK 当前实现:
  `packages/open-agent-kernel/src/runtime/agent-builder.ts:42-46,167,189`
  `packages/open-agent-kernel/src/public/types.ts:70-74,124-139`
  `packages/open-agent-kernel/src/sandbox/ags-stateful-sandbox.ts:605-657`
- Server feature/stateful-infra(同仓库其他分支):
  `packages/server/src/lib/sandbox-config.ts:13`(STATEFUL_WORKSPACE_ROOT)
  `packages/server/src/sandbox/provider/stateful-provider.ts:480-516`(prepare)
  `packages/server/src/agent/cloudbase-agent.service.ts:880`(workspaceHint 写死)
  `packages/server/src/sandbox/git-archive.ts:150`("同一分支上有多个 conversation 目录")

### 9.2 Claude `.claude/` 目录文档

- 官方 `.claude/` 目录全貌:https://code.claude.com/docs/en/claude-directory
  - 项目级 vs 全局级目录划分 / SDK 自动写入(autogen)的子集 / committed vs gitignored vs local 标签
- `CLAUDE_CONFIG_DIR` 行为(社区 + GitHub Issue):https://github.com/anthropics/claude-code/issues/4739
- Plan mode 不持久化文件(确认 plan 不在同步范围内):https://github.com/anthropics/claude-code/issues/14866

## 10. 后续 Spec 关联

- **Spec B(沙箱工作区快照)**:本 spec 完成后的下一份。基于 SandboxInstance 增加 `snapshot()` / `restore()` API,后端走 envId 对应租户 COS。Spec B 与本 spec 在公共 API 上**完全解耦**,实施可并行。
- **Spec C(可选,V2)**:若客户提出"换 OSS / 自建 S3 后端",将 internal `ClaudeHomeSyncStore` 升级为 public 类型,加 `userMemory.store` 字段。

## 11. 与"工具型方案"(已驳回)的对比

留存这一节供未来回顾,避免类似讨论循环出现。

| 维度 | 工具型(v1/v2 方案,已驳回) | `.claude/` 同步(v3 方案) |
|---|---|---|
| 利用 SDK auto-memory + dream | ❌ 完全放弃 | ✅ 完整保留 |
| Agent 主动管理记忆 | ❌ 必须通过工具 + prompt 引导 | ✅ SDK supervisor 自动判定 |
| 数据形态 | KV(自创 schema) | SDK 原生 .md(随 SDK 演进) |
| 多节点 | DB 真理源 | COS 真理源 + 本地副本 |
| 复杂度 | 自己造 store + 4 工具 + dedup + 引导文案 | 只做"目录 ↔ COS"同步 |
| 跨 SDK 可移植 | 高(KV 通用) | 低(绑 Claude SDK 文件格式) |
| 与 SDK 演进同步 | 要追 SDK 新能力 | 自动跟随(SDK 加新目录时只更新 SYNC_INCLUDES) |
| 业务方理解成本 | 中(要懂 KV / 工具引导 / dedup) | 低(`enabled: true` 一行) |

**核心论点**:OAK 选 Claude SDK 的价值是 SDK 在 memory / dream / agent 等维度领先。同步方案保留这个领先性,工具型方案放弃这个领先性。

## 12. RAG 边界声明

OAK 的 userMemory 是 **SDK 主导的用户级长期记忆**(基于文件系统的 auto-memory + dream),**不是 RAG 知识库**:

| 维度 | RAG | OAK userMemory |
|---|---|---|
| 数据来源 | 业务方/管理员预先准备的外部知识 | SDK auto + dream 自己写出来的 |
| 写入者 | 系统(离线 ingest pipeline) | SDK supervisor(在线自动判定) |
| 关于谁 | 关于世界 / 产品 / 文档 | 关于这个 user |
| 数据粒度 | 文档 chunk(几百~几千 token) | 单条事实 / 一段反思摘要 |
| OAK 推荐方案 | 走外部 MCP server(如 mem0 / Pinecone / 自建) | **本 spec 范围** |

**业务方常见误用 + 推荐路径**:

- ❌ 把产品手册 / 公司文档 ingest 到 `userMemory` 同步范围 → 错误,这是 RAG
  → ✅ 走外部 MCP server,与 OAK 的 `mcpServers` 字段对接
- ✅ 用户级 CLAUDE.md 写"我喜欢简洁回答" → 正确,这是个人偏好
- ✅ SDK auto-memory 自动记录"上次提到要写邮件,主题是项目延期" → 正确,episodic 记忆

OAK 主包不内置 RAG 抽象。Spec A 之后如果要补 RAG 能力,会作为完全独立的扩展。

## 13. 未来扩展(不在本 spec 范围)

### 13.1 同一 user 多节点并发写的强一致性

MVP 用 LastWriteWins。V2 评估方案:
- ETag 乐观锁(COS 原生支持 If-Match):写冲突时返回 412 → 重新拉 → 合并 → 重写
- 后台 merge worker:LLM 蒸馏冲突版本

### 13.2 SYNC_INCLUDES 业务方自定义

V2 可加 `userMemory.syncIncludes?: string[]` 让业务方扩展同步范围(比如某个自定义 SDK 子目录),但**不开放业务方 exclude SDK 自动写的子集**(保持 SDK 行为完整性)。

### 13.3 Store 后端可替换

internal `ClaudeHomeSyncStore` 抽象已就位。V2 若客户需要 OSS / 自建 S3,直接将抽象提升为 public,加 `userMemory.store?` 字段,无需重构。

### 13.4 增量同步优化

MVP 周期推用 mtime 对比。V2 可加:
- 文件级 hash 比对(避免 mtime 假阳性)
- COS 端 inventory API 减少 list 调用
- 大文件 multipart resumable

### 13.5 离线缓存

V2 评估:COS 不可达时,本地 ephemeral dir 内容保留 N 小时(而非立即丢弃),次次 acquire 时优先用本地缓存,等 COS 恢复后异步回填。
