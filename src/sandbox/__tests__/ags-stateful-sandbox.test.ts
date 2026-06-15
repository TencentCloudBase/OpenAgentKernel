/**
 * AgsStatefulSandbox cosMount addendum 单元测试。
 *
 * 通过 vi.mock 打桩 @cloudbase/manager-node 和 @cloudbase/manager-node/lib/utils,
 * 验证 acquire 流程在不同 cosMount 模式下的行为:
 *   - 'disabled' → 不调 env.getEnvInfo, 不传 StorageMounts/MountOptions
 *   - 'auto' + 自动发现成功 → 注入 StorageMounts + MountOptions(SubPath=userId)+ Env
 *   - 'auto' + 自动发现失败 → silent 不启用
 *   - 'enabled' + 自动发现失败 → ConfigError
 *   - SECRET_MASTER_KEY env 透传
 *   - 旧 tool BucketPath 不一致 → ConfigError
 */

// 必须在 import AgsStatefulSandbox 之前 set:模块加载时这两个常量被读
process.env.OAK_AGS_TOOL_WARMUP_POLL_MS = '1' // 1ms 而非 10s
process.env.OAK_AGS_TOOL_WARMUP_POLL_MAX = '1' // 1 round 而非 6

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ─── manager-node mock(必须在 import AgsStatefulSandbox 之前)───
// 同时打桩两个入口:
//   - '@cloudbase/manager-node'           → CloudBase ctor(其 .env.getEnvInfo / .storage.uploadFile 是测试控制点)
//   - '@cloudbase/manager-node/lib/utils' → CloudService ctor(其 .request 是测试控制点)

const getEnvInfoMock = vi.fn()
const uploadFileMock = vi.fn()
const cloudServiceRequestMock = vi.fn()

vi.mock('@cloudbase/manager-node', () => {
  class CloudBase {
    public env = { getEnvInfo: getEnvInfoMock }
    public storage = { uploadFile: uploadFileMock }
    public context = {}
    constructor(_config: Record<string, unknown>) {}
  }
  return { default: CloudBase }
})

vi.mock('@cloudbase/manager-node/lib/utils', () => {
  class CloudService {
    constructor(_ctx: unknown, _service: string, _version: string) {}
    request(action: string, param: Record<string, unknown>): Promise<Record<string, unknown>> {
      return cloudServiceRequestMock(action, param)
    }
  }
  return { CloudService }
})

import { AgsStatefulSandbox, __clearToolIdCacheForTests } from '../ags-stateful-sandbox.js'

const credentials = { envId: 'test-env', secretId: 'fake-secret-id', secretKey: 'fake-secret-key' }

beforeEach(() => {
  delete process.env.OAK_SECRET_MASTER_KEY

  __clearToolIdCacheForTests() // 防止跨测试 tool cache 污染

  getEnvInfoMock.mockReset()
  uploadFileMock.mockReset()
  cloudServiceRequestMock.mockReset()

  // 默认让 fetch 永远走 200(模拟 /health 立即就绪)
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('ok', { status: 200 })))
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// ─── helpers ────────────────────────────────────────────────────

interface AcquireRequestRecord {
  action: string
  param: Record<string, unknown>
}

function newTestRuntime(options: ConstructorParameters<typeof AgsStatefulSandbox>[0] = {}): AgsStatefulSandbox {
  return new AgsStatefulSandbox({
    apiKey: 'fake-api-key',
    credentials,
    ...options,
  })
}

/**
 * 装配一次 acquire 调用全程的 mock 序列(覆盖 DescribeSandboxToolList → CreateSandboxTool →
 * DescribeSandboxInstanceList → StartSandboxInstance)。
 *
 * @param opts.toolFound  list 时是否返回已有 tool(默认 false)
 * @param opts.toolStorageBucketPath  已有 tool 上 StorageMounts[0].StorageSource.Cos.BucketPath(用于不一致测试)
 * @param opts.envInfoStorages getEnvInfo 返回的 Storages 数组(用于自动发现成功/失败)
 */
function setupMocks(opts: {
  toolFound?: boolean
  toolStorageBucketPath?: string | null
  envInfoStorages?: Array<Record<string, unknown>>
  instanceSet?: Array<Record<string, unknown>>
}): {
  records: AcquireRequestRecord[]
} {
  const records: AcquireRequestRecord[] = []

  getEnvInfoMock.mockResolvedValue({
    EnvInfo: {
      Storages: opts.envInfoStorages ?? [{ Bucket: 'oak-test-1234567890', Region: 'ap-shanghai' }],
    },
  })

  uploadFileMock.mockResolvedValue({})

  cloudServiceRequestMock.mockImplementation(async (action: string, param: Record<string, unknown>) => {
    records.push({ action, param })

    if (action === 'DescribeSandboxToolList') {
      if (opts.toolFound) {
        const storageMounts =
          opts.toolStorageBucketPath !== undefined && opts.toolStorageBucketPath !== null
            ? [
                {
                  Name: 'oak-cos-workspace',
                  StorageSource: { Cos: { BucketPath: opts.toolStorageBucketPath } },
                  MountPath: '/mnt/workspace',
                },
              ]
            : []
        return {
          SandboxToolSet: [
            {
              ToolId: 'sdt-existing',
              ToolName: 'oak-test-env',
              Status: 'ACTIVE',
              StorageMounts: storageMounts,
            },
          ],
          TotalCount: 1,
        }
      }
      return { SandboxToolSet: [], TotalCount: 0 }
    }

    if (action === 'CreateSandboxTool') {
      return { ToolId: 'sdt-new' }
    }

    if (action === 'DescribeSandboxInstanceList') {
      return { InstanceSet: opts.instanceSet ?? [], TotalCount: opts.instanceSet?.length ?? 0 }
    }

    if (action === 'StartSandboxInstance') {
      return { InstanceId: 'inst-123' }
    }

    if (action === 'PauseSandboxInstance' || action === 'StopSandboxInstance') {
      return { RequestId: 'r-1' }
    }

    throw new Error(`unmocked AGS action: ${action}`)
  })

  return { records }
}

function findRequest(records: AcquireRequestRecord[], action: string): Record<string, unknown> | undefined {
  return records.find((r) => r.action === action)?.param
}

// ─── tests ──────────────────────────────────────────────────────

describe('AgsStatefulSandbox cosMount = "disabled"', () => {
  it('does not call env.getEnvInfo and does not inject StorageMounts/MountOptions', async () => {
    const { records } = setupMocks({ toolFound: false })
    const runtime = newTestRuntime({ cosMount: 'disabled' })
    await runtime.acquire({
      envId: 'test-env',
      conversationId: 'conv-1',
      userId: 'alice',
      scope: 'session',
    })

    expect(getEnvInfoMock).not.toHaveBeenCalled()
    expect(uploadFileMock).not.toHaveBeenCalled()

    const create = findRequest(records, 'CreateSandboxTool')
    expect(create).toBeDefined()
    expect(create!.StorageMounts).toBeUndefined()

    const start = findRequest(records, 'StartSandboxInstance')
    expect(start).toBeDefined()
    expect(start!.MountOptions).toBeUndefined()
    expect(start!.CustomConfiguration).toBeUndefined()
  })
})

describe('AgsStatefulSandbox cosMount = "auto" with discovered bucket', () => {
  it('injects StorageMounts on CreateSandboxTool with /oak-workspaces BucketPath', async () => {
    const { records } = setupMocks({ toolFound: false })
    const runtime = newTestRuntime({ cosMount: 'auto' })
    await runtime.acquire({ envId: 'test-env', conversationId: 'c', userId: 'alice', scope: 'session' })

    const create = findRequest(records, 'CreateSandboxTool')
    expect(create!.StorageMounts).toEqual([
      {
        Name: 'oak-cos-workspace',
        StorageSource: {
          Cos: {
            Endpoint: 'oak-test-1234567890.cos.ap-shanghai.myqcloud.com',
            BucketName: 'oak-test-1234567890',
            BucketPath: '/oak-workspaces',
          },
        },
        MountPath: '/mnt/workspace',
        ReadOnly: false,
      },
    ])
  })

  it('pre-creates SubPath/.keep with userId (alongside BucketPath/.keep)', async () => {
    setupMocks({ toolFound: false })
    const runtime = newTestRuntime({ cosMount: 'auto' })
    await runtime.acquire({ envId: 'test-env', conversationId: 'c', userId: 'alice', scope: 'session' })

    // tool create 路径:两次 upload(bucket-level + user-level)
    expect(uploadFileMock).toHaveBeenCalledTimes(2)
    expect(uploadFileMock).toHaveBeenCalledWith(
      expect.objectContaining({
        cloudPath: 'oak-workspaces/alice/.keep',
      }),
    )
  })

  it('pre-creates BOTH BucketPath/.keep (tool prerequisite) AND SubPath/.keep (instance prerequisite)', async () => {
    setupMocks({ toolFound: false })
    const runtime = newTestRuntime({ cosMount: 'auto' })
    await runtime.acquire({ envId: 'test-env', conversationId: 'c', userId: 'alice', scope: 'session' })

    expect(uploadFileMock).toHaveBeenCalledTimes(2)
    // 第一次:BucketPath/.keep(在 CreateSandboxTool 之前)
    expect(uploadFileMock).toHaveBeenNthCalledWith(1, expect.objectContaining({ cloudPath: 'oak-workspaces/.keep' }))
    // 第二次:SubPath/.keep(在 StartSandboxInstance 之前)
    expect(uploadFileMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ cloudPath: 'oak-workspaces/alice/.keep' }),
    )
  })

  it('skips BucketPath/.keep when reusing existing tool (only SubPath needed)', async () => {
    setupMocks({ toolFound: true, toolStorageBucketPath: '/oak-workspaces' })
    const runtime = newTestRuntime({ cosMount: 'auto' })
    await runtime.acquire({ envId: 'test-env', conversationId: 'c', userId: 'alice', scope: 'session' })

    // 复用已有 tool,只建 SubPath/.keep,不重建 BucketPath/.keep
    expect(uploadFileMock).toHaveBeenCalledTimes(1)
    expect(uploadFileMock).toHaveBeenCalledWith(expect.objectContaining({ cloudPath: 'oak-workspaces/alice/.keep' }))
  })

  it('falls back to SubPath="default" when ctx.userId is undefined', async () => {
    setupMocks({ toolFound: false })
    const runtime = newTestRuntime({ cosMount: 'auto' })
    await runtime.acquire({ envId: 'test-env', conversationId: 'c', scope: 'session' })

    expect(uploadFileMock).toHaveBeenCalledWith(expect.objectContaining({ cloudPath: 'oak-workspaces/default/.keep' }))
  })

  it('injects MountOptions.SubPath=userId on StartSandboxInstance', async () => {
    const { records } = setupMocks({ toolFound: false })
    const runtime = newTestRuntime({ cosMount: 'auto' })
    await runtime.acquire({ envId: 'test-env', conversationId: 'c', userId: 'bob', scope: 'session' })

    const start = findRequest(records, 'StartSandboxInstance')
    expect(start!.MountOptions).toEqual([{ Name: 'oak-cos-workspace', SubPath: 'bob' }])
  })

  it('reuses shared instance only when the process knows it belongs to the same userId', async () => {
    const instanceSet: Array<Record<string, unknown>> = []
    const { records } = setupMocks({ toolFound: true, toolStorageBucketPath: '/oak-workspaces', instanceSet })
    const runtime = newTestRuntime({ cosMount: 'auto' })

    await runtime.acquire({ envId: 'test-env', conversationId: 'c1', userId: 'alice', scope: 'shared' })
    instanceSet.push({ InstanceId: 'inst-123', Status: 'RUNNING', ToolId: 'sdt-existing' })
    await runtime.acquire({ envId: 'test-env', conversationId: 'c2', userId: 'alice', scope: 'shared' })

    const starts = records.filter((r) => r.action === 'StartSandboxInstance')
    expect(starts).toHaveLength(1)
  })

  it('does not reuse unknown-owner shared instances when cosMount binds SubPath to userId', async () => {
    const { records } = setupMocks({
      toolFound: true,
      toolStorageBucketPath: '/oak-workspaces',
      instanceSet: [{ InstanceId: 'inst-unknown', Status: 'RUNNING', ToolId: 'sdt-existing' }],
    })
    const runtime = newTestRuntime({ cosMount: 'auto' })

    await runtime.acquire({ envId: 'test-env', conversationId: 'c', userId: 'alice', scope: 'shared' })

    const start = findRequest(records, 'StartSandboxInstance')
    const stop = findRequest(records, 'StopSandboxInstance')
    expect(start).toBeDefined()
    expect(stop).toBeUndefined()
  })

  it('injects CustomConfiguration.Env.COS_MOUNT_DIR on StartSandboxInstance', async () => {
    const { records } = setupMocks({ toolFound: false })
    const runtime = newTestRuntime({ cosMount: 'auto' })
    await runtime.acquire({ envId: 'test-env', conversationId: 'c', userId: 'alice', scope: 'session' })

    const start = findRequest(records, 'StartSandboxInstance')
    const env = (start!.CustomConfiguration as { Env: Array<{ Name: string; Value: string }> }).Env
    expect(env).toContainEqual({ Name: 'COS_MOUNT_DIR', Value: '/mnt/workspace' })
  })

  it('passes through OAK_SECRET_MASTER_KEY env to Env.SECRET_MASTER_KEY', async () => {
    process.env.OAK_SECRET_MASTER_KEY = 'super-secret-key'
    const { records } = setupMocks({ toolFound: false })
    const runtime = newTestRuntime({ cosMount: 'auto' })
    await runtime.acquire({ envId: 'test-env', conversationId: 'c', userId: 'alice', scope: 'session' })

    const start = findRequest(records, 'StartSandboxInstance')
    const env = (start!.CustomConfiguration as { Env: Array<{ Name: string; Value: string }> }).Env
    expect(env).toContainEqual({ Name: 'SECRET_MASTER_KEY', Value: 'super-secret-key' })
  })

  it('does NOT inject SECRET_MASTER_KEY when OAK_SECRET_MASTER_KEY unset', async () => {
    const { records } = setupMocks({ toolFound: false })
    const runtime = newTestRuntime({ cosMount: 'auto' })
    await runtime.acquire({ envId: 'test-env', conversationId: 'c', userId: 'alice', scope: 'session' })

    const start = findRequest(records, 'StartSandboxInstance')
    const env = (start!.CustomConfiguration as { Env: Array<{ Name: string; Value: string }> }).Env
    expect(env.find((e) => e.Name === 'SECRET_MASTER_KEY')).toBeUndefined()
    // 但 COS_MOUNT_DIR 仍在
    expect(env.find((e) => e.Name === 'COS_MOUNT_DIR')).toBeDefined()
  })
})

describe('AgsStatefulSandbox cosMount = "auto" with NO storage', () => {
  it('silently skips COS injection when env has no Storages', async () => {
    const { records } = setupMocks({ toolFound: false, envInfoStorages: [] })
    const runtime = newTestRuntime({ cosMount: 'auto' })
    await runtime.acquire({ envId: 'test-env', conversationId: 'c', userId: 'alice', scope: 'session' })

    expect(uploadFileMock).not.toHaveBeenCalled()
    const create = findRequest(records, 'CreateSandboxTool')
    expect(create!.StorageMounts).toBeUndefined()
    const start = findRequest(records, 'StartSandboxInstance')
    expect(start!.MountOptions).toBeUndefined()
  })

  it('throws ConfigError on cosMount="enabled" + no Storages', async () => {
    setupMocks({ toolFound: false, envInfoStorages: [] })
    const runtime = newTestRuntime({ cosMount: 'enabled' })
    await expect(
      runtime.acquire({ envId: 'test-env', conversationId: 'c', userId: 'alice', scope: 'session' }),
    ).rejects.toThrow(/no default storage bucket/)
  })
})

describe('AgsStatefulSandbox cosMountOverride', () => {
  it('uses cosMountOverride and skips env.getEnvInfo discovery', async () => {
    const { records } = setupMocks({ toolFound: false })
    const runtime = newTestRuntime({
      cosMountOverride: {
        bucketName: 'ags-trw-shanghai-1253192607',
        region: 'ap-shanghai',
        bucketPath: '/test-sync-out',
      },
    })
    await runtime.acquire({ envId: 'test-env', conversationId: 'c', userId: 'alice', scope: 'session' })

    // 不调 env.getEnvInfo(走 override 短路)
    expect(getEnvInfoMock).not.toHaveBeenCalled()

    const create = findRequest(records, 'CreateSandboxTool')
    expect(create!.StorageMounts).toEqual([
      {
        Name: 'oak-cos-workspace',
        StorageSource: {
          Cos: {
            Endpoint: 'ags-trw-shanghai-1253192607.cos.ap-shanghai.myqcloud.com',
            BucketName: 'ags-trw-shanghai-1253192607',
            BucketPath: '/test-sync-out',
          },
        },
        MountPath: '/mnt/workspace',
        ReadOnly: false,
      },
    ])
  })

  it('cosMountOverride defaults bucketPath to /oak-workspaces when not provided', async () => {
    const { records } = setupMocks({ toolFound: false })
    const runtime = newTestRuntime({
      cosMountOverride: {
        bucketName: 'my-bucket-1253192607',
        region: 'ap-guangzhou',
      },
    })
    await runtime.acquire({ envId: 'test-env', conversationId: 'c', userId: 'alice', scope: 'session' })

    const create = findRequest(records, 'CreateSandboxTool')
    const cos = (create!.StorageMounts as Array<Record<string, Record<string, Record<string, unknown>>>>)[0]
      .StorageSource.Cos
    expect(cos.BucketPath).toBe('/oak-workspaces')
    expect(cos.Endpoint).toBe('my-bucket-1253192607.cos.ap-guangzhou.myqcloud.com')
  })

  it('cosMountOverride respects cosMount="disabled" (override ignored)', async () => {
    const { records } = setupMocks({ toolFound: false })
    const runtime = newTestRuntime({
      cosMount: 'disabled',
      cosMountOverride: {
        bucketName: 'should-be-ignored',
        region: 'ap-shanghai',
      },
    })
    await runtime.acquire({ envId: 'test-env', conversationId: 'c', userId: 'alice', scope: 'session' })

    const create = findRequest(records, 'CreateSandboxTool')
    expect(create!.StorageMounts).toBeUndefined()
  })
})

describe('AgsStatefulSandbox cosMountOverride', () => {
  it('uses cosMountOverride and skips env.getEnvInfo discovery', async () => {
    const { records } = setupMocks({ toolFound: false })
    const runtime = newTestRuntime({
      cosMountOverride: {
        bucketName: 'ags-trw-shanghai-1253192607',
        region: 'ap-shanghai',
        bucketPath: '/test-sync-out',
      },
    })
    await runtime.acquire({ envId: 'test-env', conversationId: 'c', userId: 'alice', scope: 'session' })

    // 不调 env.getEnvInfo(走 override 短路)
    expect(getEnvInfoMock).not.toHaveBeenCalled()

    const create = findRequest(records, 'CreateSandboxTool')
    expect(create!.StorageMounts).toEqual([
      {
        Name: 'oak-cos-workspace',
        StorageSource: {
          Cos: {
            Endpoint: 'ags-trw-shanghai-1253192607.cos.ap-shanghai.myqcloud.com',
            BucketName: 'ags-trw-shanghai-1253192607',
            BucketPath: '/test-sync-out',
          },
        },
        MountPath: '/mnt/workspace',
        ReadOnly: false,
      },
    ])
  })

  it('cosMountOverride defaults bucketPath to /oak-workspaces when not provided', async () => {
    const { records } = setupMocks({ toolFound: false })
    const runtime = newTestRuntime({
      cosMountOverride: {
        bucketName: 'my-bucket-1253192607',
        region: 'ap-guangzhou',
      },
    })
    await runtime.acquire({ envId: 'test-env', conversationId: 'c', userId: 'alice', scope: 'session' })

    const create = findRequest(records, 'CreateSandboxTool')
    const cos = (create!.StorageMounts as Array<Record<string, Record<string, Record<string, unknown>>>>)[0]
      .StorageSource.Cos
    expect(cos.BucketPath).toBe('/oak-workspaces')
    expect(cos.Endpoint).toBe('my-bucket-1253192607.cos.ap-guangzhou.myqcloud.com')
  })

  it('cosMountOverride respects cosMount="disabled" (override ignored)', async () => {
    const { records } = setupMocks({ toolFound: false })
    const runtime = newTestRuntime({
      cosMount: 'disabled',
      cosMountOverride: {
        bucketName: 'should-be-ignored',
        region: 'ap-shanghai',
      },
    })
    await runtime.acquire({ envId: 'test-env', conversationId: 'c', userId: 'alice', scope: 'session' })

    const create = findRequest(records, 'CreateSandboxTool')
    expect(create!.StorageMounts).toBeUndefined()
  })
})

describe('AgsStatefulSandbox existing tool BucketPath mismatch', () => {
  it('throws ConfigError when existing tool has different BucketPath', async () => {
    setupMocks({ toolFound: true, toolStorageBucketPath: '/legacy-path' })
    const runtime = newTestRuntime({ cosMount: 'auto' })
    await expect(
      runtime.acquire({ envId: 'test-env', conversationId: 'c', userId: 'alice', scope: 'session' }),
    ).rejects.toThrow(/BucketPath=\/legacy-path.*resolves to \/oak-workspaces/s)
  })

  it('throws ConfigError when existing tool has NO StorageMounts but cosMount auto resolved', async () => {
    setupMocks({ toolFound: true, toolStorageBucketPath: null })
    const runtime = newTestRuntime({ cosMount: 'auto' })
    await expect(
      runtime.acquire({ envId: 'test-env', conversationId: 'c', userId: 'alice', scope: 'session' }),
    ).rejects.toThrow(/BucketPath=\(none\).*resolves to \/oak-workspaces/s)
  })

  it('reuses existing tool when BucketPath matches', async () => {
    const { records } = setupMocks({ toolFound: true, toolStorageBucketPath: '/oak-workspaces' })
    const runtime = newTestRuntime({ cosMount: 'auto' })
    await runtime.acquire({ envId: 'test-env', conversationId: 'c', userId: 'alice', scope: 'session' })

    // 不该再调 CreateSandboxTool
    expect(records.find((r) => r.action === 'CreateSandboxTool')).toBeUndefined()
    // 但仍应进 StartSandboxInstance
    expect(records.find((r) => r.action === 'StartSandboxInstance')).toBeDefined()
  })

  it('reuses existing tool with no StorageMounts when cosMount=disabled', async () => {
    const { records } = setupMocks({ toolFound: true, toolStorageBucketPath: null })
    const runtime = newTestRuntime({ cosMount: 'disabled' })
    await runtime.acquire({ envId: 'test-env', conversationId: 'c', userId: 'alice', scope: 'session' })

    // disabled 时期望也是 null,匹配
    expect(records.find((r) => r.action === 'CreateSandboxTool')).toBeUndefined()
  })
})

describe('AgsStatefulSandbox env-driven defaults (deferred read)', () => {
  // 回归测试:DEFAULT_SANDBOX_IMAGE / DEFAULT_TOOL_ROLE_ARN 必须保持函数式,
  // 不能退化回模块加载期 const —— examples / SDK 调用方常 import 后再 dotenv.config(),
  // 模块加载期固化会让 .env.local 永远拿不到。

  it('reads OAK_SANDBOX_IMAGE set AFTER module import', async () => {
    const lateValue = 'ccr.example.com/some-org/late-bound:test-tag'
    process.env.OAK_SANDBOX_IMAGE = lateValue

    try {
      const { records } = setupMocks({ toolFound: false })
      const runtime = newTestRuntime({ cosMount: 'disabled' })
      await runtime.acquire({ envId: 'test-env', conversationId: 'c', userId: 'alice', scope: 'session' })

      const create = findRequest(records, 'CreateSandboxTool')
      expect(create).toBeDefined()
      const customConfig = create!.CustomConfiguration as { Image?: string }
      expect(customConfig.Image).toBe(lateValue)
    } finally {
      delete process.env.OAK_SANDBOX_IMAGE
    }
  })

  it('reads OAK_SANDBOX_TOOL_ROLE_ARN set AFTER module import', async () => {
    const lateRole = 'qcs::cam::uin/999999999:roleName/late-bound-role'
    process.env.OAK_SANDBOX_TOOL_ROLE_ARN = lateRole

    try {
      const { records } = setupMocks({ toolFound: false })
      const runtime = newTestRuntime({ cosMount: 'disabled' })
      await runtime.acquire({ envId: 'test-env', conversationId: 'c', userId: 'alice', scope: 'session' })

      const create = findRequest(records, 'CreateSandboxTool')
      expect(create).toBeDefined()
      expect(create!.RoleArn).toBe(lateRole)
    } finally {
      delete process.env.OAK_SANDBOX_TOOL_ROLE_ARN
    }
  })

  it('opts.image overrides OAK_SANDBOX_IMAGE env', async () => {
    process.env.OAK_SANDBOX_IMAGE = 'ccr.example.com/env/value:tag'

    try {
      const { records } = setupMocks({ toolFound: false })
      const runtime = newTestRuntime({
        cosMount: 'disabled',
        image: 'ccr.example.com/explicit/option:tag',
      })
      await runtime.acquire({ envId: 'test-env', conversationId: 'c', userId: 'alice', scope: 'session' })

      const create = findRequest(records, 'CreateSandboxTool')
      const customConfig = create!.CustomConfiguration as { Image?: string }
      expect(customConfig.Image).toBe('ccr.example.com/explicit/option:tag')
    } finally {
      delete process.env.OAK_SANDBOX_IMAGE
    }
  })
})
