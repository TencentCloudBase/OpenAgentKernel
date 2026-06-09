import { z } from 'zod'

/** restored 取值,直接对应 tcb-remote-workspace cos-sync.ts:135 SyncStatus */
export const restoredEnum = z.enum(['full', 'partial', 'fresh', 'failed'])
export type Restored = z.infer<typeof restoredEnum>

/** SyncStatus 真实结构,见 cos-sync.ts:135-144 */
export const syncStatusSchema = z.object({
  restored: restoredEnum,
  restoredAt: z.string(),
  restoreMs: z.number().optional(),
  source: z.enum(['cos', 'git', 'none']),
  cosMetaSizeBytes: z.number().optional(),
  cosMetaFileCount: z.number().optional(),
  steps: z.record(z.string(), z.number()).optional(),
  note: z.string().optional(),
})
export type SyncStatus = z.infer<typeof syncStatusSchema>

/**
 * /health 响应的最小子集(我们只关心 restoreStatus)。
 * 见 routes/api.ts:200,bootstrap 序列里 init 后必须 GET /health 拿真实 SyncStatus。
 *
 * 注意:`/health` 在镜像还没 ready 时返回 503 + problem+json,client 层要处理这种情况。
 */
export const healthResponseSchema = z
  .object({
    ok: z.boolean().optional(),
    restoreStatus: syncStatusSchema.nullable().optional(),
  })
  .passthrough()
export type HealthResponse = z.infer<typeof healthResponseSchema>

/**
 * `POST /api/workspace/init` 真实成功响应(见 routes/api.ts:240-300)。
 * 注意:**body 不含 restoreStatus** — 那个只在 `/health` 上读。
 */
export const workspaceInitResponseSchema = z.object({
  success: z.literal(true),
  result: z
    .object({
      workspace: z.string(),
      git: z
        .object({
          enabled: z.boolean(),
          hasGit: z.boolean(),
          branch: z.string().optional(),
        })
        .passthrough(),
      env: z.record(z.string(), z.unknown()),
      set: z.array(z.string()).optional(),
      envSet: z.array(z.string()).optional(),
      ignored: z.array(z.string()).optional(),
      skillsMaterialized: z.number().optional(),
    })
    .passthrough(),
})
export type WorkspaceInitResponse = z.infer<typeof workspaceInitResponseSchema>

/** 镜像约定的 retryable error code(application/problem+json) */
export const RETRYABLE_ERROR_CODES = new Set(['workspace_snapshot_failed'])

/** snapshot 成功响应的外层 wrapper */
export const snapshotSuccessSchema = z.object({
  success: z.literal(true),
  result: z.object({ ms: z.number() }),
})
