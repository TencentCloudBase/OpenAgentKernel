/**
 * cloudbase-cos-store.test.ts
 *
 * 锁住 CloudBaseCosClaudeHomeStore 的关键 invariant:
 *   - 凭证缺失时构造抛 ResourceError
 *   - getManager() 对 @cloudbase/manager-node 的 CJS / ESM 导出形态都能适配
 *   - manager 实例缓存(只 init 一次)
 *   - pull 把 walkCloudDir 列举结果走 getTemporaryUrl + fetch 落到本地 + 返回 baseline
 *   - put 把 Buffer 经过 tmp 文件桥接传给 storage.uploadFile,事后清理
 *   - delete 对"文件不存在"幂等(STORAGE.FileNotFound / STORAGE_FILE_NONEXIST / NoSuchKey / 404)
 *
 * 不测真实 COS — 模块加载层用 vi.spyOn(store, 'requireManagerNode') 替换。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { CloudBaseCosClaudeHomeStore } from '../cloudbase-cos-store.js'

const ctx = { envId: 'env-test', userId: 'alice' }
const PREFIX = 'oak/users/alice/claude-home/'
const credentials = { envId: 'env-test', secretId: 'sid', secretKey: 'sk' }

afterEach(() => {
  vi.restoreAllMocks()
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

function spyManagerCtor(store: CloudBaseCosClaudeHomeStore, instance: unknown, shape: 'cjs' | 'esm' = 'cjs') {
  const Ctor = vi.fn().mockReturnValue(instance) as unknown as new (...args: unknown[]) => unknown
  // CJS shape: mod.default 是 ctor; ESM shape: mod 直接是 ctor(实际 manager-node 是 CJS,
  // 但我们的代码 fallback `mod.default ?? mod` 应同时支持)
  const mod = shape === 'cjs' ? { default: Ctor } : Ctor
  vi.spyOn(store as unknown as { requireManagerNode: () => Promise<unknown> }, 'requireManagerNode').mockResolvedValue(
    mod,
  )
  return Ctor as unknown as ReturnType<typeof vi.fn>
}

// ── 凭证 ───────────────────────────────────────────────────────
describe('CloudBaseCosClaudeHomeStore — credential validation', () => {
  it('throws InvalidConfigError when credentials missing', () => {
    expect(() => new CloudBaseCosClaudeHomeStore()).toThrow(/requires platform credentials/)
  })

  it('accepts programmatic credentials', () => {
    expect(
      () => new CloudBaseCosClaudeHomeStore({ credentials: { envId: 'e', secretId: 's', secretKey: 'k' } }),
    ).not.toThrow()
  })
})

// ── 模块加载形态 ───────────────────────────────────────────────
describe('CloudBaseCosClaudeHomeStore — getManager() module shape adaptation', () => {
  it('propagates the failure when @cloudbase/manager-node is not installed', async () => {
    const store = newStore()
    // 在 requireManagerNode 这一层拦截 = 模拟"包加载失败被业务层捕获后包装的 ResourceError"
    // (生产代码 try/catch 会把任何 dynamicImport 失败包成 ResourceError;这里直接 mock
    // 抛 ResourceError 文案,验证其能向上传播)
    vi.spyOn(
      store as unknown as { requireManagerNode: () => Promise<unknown> },
      'requireManagerNode',
    ).mockRejectedValueOnce(new Error('CloudBaseCosClaudeHomeStore requires @cloudbase/manager-node'))

    await expect(store.put(ctx, 'CLAUDE.md', Buffer.from('x'))).rejects.toThrow(/manager-node/)
  })

  it('uses mod.default when SDK exports CJS shape (default-wrapped)', async () => {
    const store = newStore()
    const fake = makeFakeManager()
    const Ctor = spyManagerCtor(store, fake, 'cjs')

    await store.put(ctx, 'CLAUDE.md', Buffer.from('hello'))

    expect(Ctor).toHaveBeenCalledWith(expect.objectContaining({ envId: 'env-test', secretId: 'sid', secretKey: 'sk' }))
    expect(fake.storage.uploadFile).toHaveBeenCalledTimes(1)
    expect(fake.storage.uploadFile.mock.calls[0]![0]).toEqual(
      expect.objectContaining({ cloudPath: PREFIX + 'CLAUDE.md' }),
    )
  })

  it('uses mod directly when SDK exports ESM shape (no default wrapper)', async () => {
    const store = newStore()
    const fake = makeFakeManager()
    const Ctor = spyManagerCtor(store, fake, 'esm')

    await store.put(ctx, 'CLAUDE.md', Buffer.from('hi'))
    expect(Ctor).toHaveBeenCalled()
  })

  it('throws ResourceError when SDK loaded but default is not a constructor', async () => {
    const store = newStore()
    vi.spyOn(
      store as unknown as { requireManagerNode: () => Promise<unknown> },
      'requireManagerNode',
    ).mockResolvedValue({ somethingElse: () => {} })

    await expect(store.put(ctx, 'CLAUDE.md', Buffer.from('x'))).rejects.toThrow(/not a constructor/)
  })

  it('caches manager between calls (constructor only invoked once)', async () => {
    const store = newStore()
    const fake = makeFakeManager({ deleteFile: vi.fn().mockResolvedValue({}) })
    const Ctor = spyManagerCtor(store, fake, 'cjs')

    await store.put(ctx, 'CLAUDE.md', Buffer.from('a'))
    await store.put(ctx, 'CLAUDE.md', Buffer.from('b'))
    await store.delete(ctx, 'CLAUDE.md')

    expect(Ctor).toHaveBeenCalledTimes(1)
  })
})

// ── pull(): walkCloudDir → getTemporaryUrl → fetch → 写本地 ──────
describe('CloudBaseCosClaudeHomeStore — pull()', () => {
  let tmpRoot: string
  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join((await import('node:os')).tmpdir(), 'oak-pull-test-'))
  })
  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {})
  })

  it('returns empty baseline when COS namespace is empty', async () => {
    const store = newStore()
    const fake = makeFakeManager({ walkCloudDir: vi.fn().mockResolvedValue([]) })
    spyManagerCtor(store, fake, 'cjs')

    const baseline = await store.pull(ctx, tmpRoot)

    expect(baseline.size).toBe(0)
    expect(fake.storage.walkCloudDir).toHaveBeenCalledWith(PREFIX)
  })

  it('downloads files via temporary URL and returns hashed baseline', async () => {
    const store = newStore()
    const fileKey = PREFIX + 'CLAUDE.md'
    const fake = makeFakeManager({
      walkCloudDir: vi.fn().mockResolvedValue([{ Key: fileKey, Size: '13' }]),
      getTemporaryUrl: vi.fn().mockResolvedValue([{ fileId: fileKey, url: 'https://signed/CLAUDE.md' }]),
    })
    spyManagerCtor(store, fake, 'cjs')

    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      // 用 Uint8Array.buffer 而不是 Buffer.from(...).buffer:Node 的 Buffer 共享一个内部
      // pool ArrayBuffer,直接拿 .buffer 会带上整个 pool 的脏数据。
      arrayBuffer: async () => new TextEncoder().encode('hello, world!').buffer,
    } as Response)

    const baseline = await store.pull(ctx, tmpRoot)

    expect(fetchMock).toHaveBeenCalledWith('https://signed/CLAUDE.md')
    expect(baseline.size).toBe(1)
    expect(baseline.has('CLAUDE.md')).toBe(true)
    const written = await fs.readFile(path.join(tmpRoot, 'CLAUDE.md'), 'utf-8')
    expect(written).toBe('hello, world!')
  })

  it('skips directory placeholders (key ending with /) and zero-size entries', async () => {
    const store = newStore()
    const fake = makeFakeManager({
      walkCloudDir: vi.fn().mockResolvedValue([
        { Key: PREFIX + 'memory/', Size: 0 },
        { Key: PREFIX + 'placeholder.md', Size: '0' },
      ]),
    })
    spyManagerCtor(store, fake, 'cjs')

    const baseline = await store.pull(ctx, tmpRoot)

    expect(baseline.size).toBe(0)
    expect(fake.storage.getTemporaryUrl).not.toHaveBeenCalled()
  })

  it('throws when temp URL fetch fails (so caller can decide retry vs fail-open)', async () => {
    const store = newStore()
    const fileKey = PREFIX + 'CLAUDE.md'
    const fake = makeFakeManager({
      walkCloudDir: vi.fn().mockResolvedValue([{ Key: fileKey, Size: '5' }]),
      getTemporaryUrl: vi.fn().mockResolvedValue([{ fileId: fileKey, url: 'https://signed' }]),
    })
    spyManagerCtor(store, fake, 'cjs')

    vi.spyOn(global, 'fetch').mockResolvedValue({ ok: false, status: 500 } as Response)

    await expect(store.pull(ctx, tmpRoot)).rejects.toThrow(/pull failed/)
  })
})

// ── put(): Buffer → tmp file → uploadFile → cleanup ────────────
describe('CloudBaseCosClaudeHomeStore — put()', () => {
  it('writes buffer to a tmp file, uploads it, then cleans up the tmp dir', async () => {
    const store = newStore()
    let capturedLocalPath: string | undefined
    const fake = makeFakeManager({
      uploadFile: vi.fn().mockImplementation(async (args: { localPath: string; cloudPath: string }) => {
        capturedLocalPath = args.localPath
        // 在 cleanup 之前确认文件确实存在并且内容正确
        const buf = await fs.readFile(args.localPath)
        expect(buf.toString()).toBe('the-content')
      }),
    })
    spyManagerCtor(store, fake, 'cjs')

    await store.put(ctx, 'CLAUDE.md', Buffer.from('the-content'))

    expect(fake.storage.uploadFile).toHaveBeenCalledWith(
      expect.objectContaining({ cloudPath: PREFIX + 'CLAUDE.md', localPath: expect.any(String) }),
    )
    // tmp 目录应该被清理
    expect(capturedLocalPath).toBeDefined()
    await expect(fs.access(capturedLocalPath!)).rejects.toThrow()
  })

  it('still cleans up tmp dir if uploadFile throws', async () => {
    const store = newStore()
    let capturedLocalPath: string | undefined
    const fake = makeFakeManager({
      uploadFile: vi.fn().mockImplementation(async (args: { localPath: string }) => {
        capturedLocalPath = args.localPath
        throw new Error('upload boom')
      }),
    })
    spyManagerCtor(store, fake, 'cjs')

    await expect(store.put(ctx, 'CLAUDE.md', Buffer.from('x'))).rejects.toThrow(/upload boom/)
    expect(capturedLocalPath).toBeDefined()
    await expect(fs.access(capturedLocalPath!)).rejects.toThrow()
  })
})

// ── delete(): 幂等(文件不存在视为成功)─────────────────────────
describe('CloudBaseCosClaudeHomeStore — delete()', () => {
  it('calls deleteFile with full COS key', async () => {
    const store = newStore()
    const fake = makeFakeManager()
    spyManagerCtor(store, fake, 'cjs')

    await store.delete(ctx, 'CLAUDE.md')

    expect(fake.storage.deleteFile).toHaveBeenCalledWith([PREFIX + 'CLAUDE.md'])
  })

  for (const code of ['STORAGE.FileNotFound', 'STORAGE_FILE_NONEXIST', 'NoSuchKey']) {
    it(`treats ${code} as success (idempotent delete)`, async () => {
      const store = newStore()
      const fake = makeFakeManager({
        deleteFile: vi.fn().mockRejectedValue(Object.assign(new Error('not found'), { code })),
      })
      spyManagerCtor(store, fake, 'cjs')

      await expect(store.delete(ctx, 'CLAUDE.md')).resolves.toBeUndefined()
    })
  }

  it('treats HTTP 404 as success', async () => {
    const store = newStore()
    const fake = makeFakeManager({
      deleteFile: vi.fn().mockRejectedValue(Object.assign(new Error('not found'), { statusCode: 404 })),
    })
    spyManagerCtor(store, fake, 'cjs')

    await expect(store.delete(ctx, 'CLAUDE.md')).resolves.toBeUndefined()
  })

  it('rethrows on real errors (e.g. permission)', async () => {
    const store = newStore()
    const fake = makeFakeManager({
      deleteFile: vi
        .fn()
        .mockRejectedValue(Object.assign(new Error('AccessDenied'), { code: 'AccessDenied', statusCode: 403 })),
    })
    spyManagerCtor(store, fake, 'cjs')

    await expect(store.delete(ctx, 'CLAUDE.md')).rejects.toThrow(/AccessDenied/)
  })
})
