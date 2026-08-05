/**
 * cloudbase-cos-store.test.ts
 *
 * 锁住 CloudBaseCosClaudeHomeStore 的关键 invariant:
 *   - 凭证缺失时构造抛 InvalidConfigError
 *   - manager 实例缓存(只 init 一次)
 *   - pull 把 walkCloudDir 列举结果走 getTemporaryUrl + fetch 落到本地 + 返回 baseline
 *   - put 把 Buffer 经过 tmp 文件桥接传给 storage.uploadFile,事后清理
 *   - delete 对"文件不存在"幂等(STORAGE.FileNotFound / STORAGE_FILE_NONEXIST / NoSuchKey / 404)
 *
 * 不测真实 COS — 用 vi.mock('@cloudbase/manager-node') 替换整个模块。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

// ── Mock @cloudbase/manager-node ──────────────────────────────
// 静态 import 后,不能用 vi.spyOn 实例方法了。改用 module-level mock。
// 每个 test 通过 mockManagerCtor 重新设置 mock 实现。

const mockCtor = vi.fn()

vi.mock('@cloudbase/manager-node', () => ({
  default: mockCtor,
}))

// 必须在 mock 之后 import 被测模块
const { CloudBaseCosClaudeHomeStore } = await import('../cloudbase-cos-store.js')

const ctx = { envId: 'env-test', userId: 'alice' }
const PREFIX = 'oak/users/alice/claude-home/'
const credentials = { envId: 'env-test', secretId: 'sid', secretKey: 'sk' }

afterEach(() => {
  vi.restoreAllMocks()
  mockCtor.mockReset()
})

function newStore(): CloudBaseCosClaudeHomeStore {
  return new CloudBaseCosClaudeHomeStore({ credentials })
}

// ── 测试辅助:构造一个 fake CloudBaseManager 实例 ──────────────
function makeFakeManager(
  overrides: Partial<{
    uploadFile: ReturnType<typeof vi.fn>
    walkCloudDir: ReturnType<typeof vi.fn>
    getTemporaryUrl: ReturnType<typeof vi.fn>
    deleteFile: ReturnType<typeof vi.fn>
  }> = {},
) {
  return {
    storage: {
      uploadFile: overrides.uploadFile ?? vi.fn().mockResolvedValue({}),
      walkCloudDir: overrides.walkCloudDir ?? vi.fn().mockResolvedValue([]),
      getTemporaryUrl: overrides.getTemporaryUrl ?? vi.fn().mockResolvedValue([{ fileId: '', url: '' }]),
      deleteFile: overrides.deleteFile ?? vi.fn().mockResolvedValue({}),
    },
  }
}

function mockManagerCtor(instance: unknown) {
  mockCtor.mockReturnValue(instance)
}

// ── 凭证 ───────────────────────────────────────────────────────
describe('CloudBaseCosClaudeHomeStore — credential validation', () => {
  it('throws InvalidConfigError when credentials missing', () => {
    expect(() => new CloudBaseCosClaudeHomeStore()).toThrow(/requires credentials|requires envId/)
  })

  it('accepts programmatic credentials', () => {
    expect(
      () => new CloudBaseCosClaudeHomeStore({ credentials: { envId: 'e', secretId: 's', secretKey: 'k' } }),
    ).not.toThrow()
  })
})

// ── manager 实例管理 ───────────────────────────────────────────
describe('CloudBaseCosClaudeHomeStore — getManager()', () => {
  it('constructs CloudBaseManager with credentials', async () => {
    const store = newStore()
    const fake = makeFakeManager()
    mockManagerCtor(fake)

    await store.put(ctx, 'CLAUDE.md', Buffer.from('hello'))

    expect(mockCtor).toHaveBeenCalledWith(
      expect.objectContaining({ envId: 'env-test', secretId: 'sid', secretKey: 'sk' }),
    )
    expect(fake.storage.uploadFile).toHaveBeenCalledTimes(1)
    expect(fake.storage.uploadFile.mock.calls[0]![0]).toEqual(
      expect.objectContaining({ cloudPath: PREFIX + 'CLAUDE.md' }),
    )
  })

  it('caches manager between calls (constructor only invoked once)', async () => {
    const store = newStore()
    const fake = makeFakeManager({ deleteFile: vi.fn().mockResolvedValue({}) })
    mockManagerCtor(fake)

    await store.put(ctx, 'CLAUDE.md', Buffer.from('a'))
    await store.put(ctx, 'CLAUDE.md', Buffer.from('b'))
    await store.delete(ctx, 'CLAUDE.md')

    expect(mockCtor).toHaveBeenCalledTimes(1)
  })
})
