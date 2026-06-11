# Sandbox 模块现状速查表

输出日期：2026-06-08 | 用途：Spec B（沙箱工作区快照）输入文档

## 1. 公开 API

**索引点**：`src/sandbox/index.ts:16-27`
- 重导出：`SandboxRuntime`, `SandboxInstance`, `SandboxAcquireContext` (types)
- 重导出：`AgsStatefulSandbox` (核心类)
- 重导出：`createSandboxMcpServer` (工具导出)
- 重导出：CloudBase MCP 工具族

**业务配置入口**：`src/public/types.ts:59-112` (SandboxConfig)
- `runtime?: unknown` — 用户传 `new AgsStatefulSandbox()` 启用沙箱
- `scope?: 'session' | 'shared'` — 实例粒度（默认 'session'）
- `ttl?: number` — 生命周期秒数
- `cloudbaseTools?: boolean` — 是否自动暴露云端工具（默认 true）
- `userCredentials?` — 用户租户凭证（可异步）

**启用沙箱**：`createAgent({sandbox: {runtime: new AgsStatefulSandbox()}})`

---

## 2. AgsStatefulSandbox 角色

**文件**：`src/sandbox/ags-stateful-sandbox.ts`

**State 维度**：**Agent/EnvId 维度**
- 进程内 toolIdCache（L501-527）**per-envId** 缓存 ToolId（避免重复 DescribeSandboxToolList）
- 每个 session 独立 instanceId（L602-669 acquire 逻辑）
- Session 级：session 结束调 `release()` → PauseSandboxInstance（L656-667）

**与 cloudbase-mcp 协作**：
- `acquire()` 返回 SandboxInstance → 传给 `createSandboxMcpServer()`
- 后者暴露 bash/read/write/edit/glob/grep 工具
- 若启用 `cloudbaseTools: true`，kernel 在 acquire 之后额外调 mcporter + cloudbase-mcp（见 src/public/types.ts L85-95 描述）

**工作区落地**：**不做持久化**
- ags-stateful-sandbox.ts L10-13：明确注释"不做显式 snapshot"
- 沙箱镜像内约定：按 conversationId 派生子目录（/home/user/{conversationId}/），由镜像负责
- SDK 不感知、不落地这个目录

---

## 3. sandbox-tools.ts 角色

**文件**：`src/sandbox/sandbox-tools.ts:1-28`

**暴露工具**（注入后名为 `mcp__sandbox__*`）：
- `bash` — 执行 shell 命令（cwd 由 TRW 服务端決定 = 沙箱镜像根目录 /home/user/{conversationId}）
- `read` / `write` / `edit` — 文件读写编辑（L161-240）
- `glob` / `grep` — 文件检索（L242-308）

**cwd 决定**：
- TRW 镜像内置 `/api/tools/{name}` 端点处理所有工具
- 工具都相对沙箱 workspace root 执行（镜像约定：/home/user/{conversationId}/）
- SDK 不显式指定 cwd，信任镜像

---

## 4. Examples 对标

| 文件 | 演示内容 |
|------|--------|
| **08-sandbox.ts** | isolated 模式：单 session 写/读/列文件 + bash（L40-43）|
| **09-sandbox-shared.ts** | shared 模式：两个 userId 的 session 共享同一 AGS 实例，A 写的文件 B 能读到（L56-60）；**关键**：无工作区隔离，直接共享 /home/user/{conversationId}/ |
| **10-sandbox-cloudbase-tools.ts** | cloudbaseTools 自动注入（L48-51）：agent 同时可用 sandbox + cloudbase 工具 |

---

## 5. 快照/持久化机制

**grep 结果**：仅 L13 注释出现一次 "snapshot"
- `ags-stateful-sandbox.ts:13` — 明确说 PR #6A "不做显式 snapshot / 端口路由 / preview proxy"
- **当前状态**：无快照机制，仅 session 级释放（PauseSandboxInstance）

---

## 6. 与 Spec A 边界

**File**：`src/claude-home/path-derivation.ts:36-42`

**路径派生**：
```
CLAUDE_CONFIG_DIR = os.tmpdir()/oak/{safeEnvId}/{safeUserId}/.claude
```

**两层独立**：
- **claude-home**：同步用户级偏好 (~/.claude/)，per-user per-envId
- **sandbox**：应同步工作区（workspace/），per-session per-conversationId
- **现状**：两个根完全独立，生产里应该是 `/tmp/oak/{envId}/{userId}/` 下既有 `.claude/` 又有 `workspace/`（但工作区落地还没实现）

---

## 关键发现

### 🔴 当前缺口（Spec B 需补齐）

1. **Workspace 根目录约定** 
   - 需在 SandboxAcquireContext 里明确 workspacePath 派生规则
   - 建议：`/tmp/oak/{envId}/{userId}/workspace/{conversationId}/`（对标 claude-home 路径结构）

2. **持久化/恢复接口** 
   - snapshot() / restore() 方法 + 后端存储（COS/本地/DB）
   - 当前 release() 只做 PauseSandboxInstance，无数据落地

3. **共享模式下的物理隔离** 
   - shared 实例中多 session 如何隔离工作目录
   - 当前无物理隔离：两个 session 直接共享 /home/user/{conversationId}/
   - 需决策：继续共享（简单）还是按 userId/sessionId 派生子目录（隔离）

### ✅ 已有基础

- AgsStatefulSandbox 完整实现了 acquire/release 生命周期
- sandbox-tools 暴露了完整工具集（bash/read/write/edit/glob/grep）
- 镜像内已约定 /home/user/{conversationId}/ 作为 workspace root
- cloudbase-mcp 工具自动注入、凭证管理成熟

