import { describe, it, expect, beforeEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { InMemoryClaudeHomeStore } from '../in-memory-store.js'
import { ClaudeHomeSyncEngine } from '../sync-engine.js'

async function readFile(localDir: string, relPath: string): Promise<string> {
  return fs.readFile(path.join(localDir, relPath), 'utf8')
}

async function writeFile(localDir: string, relPath: string, content: string): Promise<void> {
  const abs = path.join(localDir, relPath)
  await fs.mkdir(path.dirname(abs), { recursive: true })
  await fs.writeFile(abs, content)
}

describe('ClaudeHomeSyncEngine', () => {
  let store: InMemoryClaudeHomeStore
  let localDir: string
  let engine: ClaudeHomeSyncEngine

  beforeEach(async () => {
    store = new InMemoryClaudeHomeStore()
    localDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oak-sync-test-'))
    engine = new ClaudeHomeSyncEngine({
      store,
      ctx: { envId: 'env-1', userId: 'alice' },
      localDir,
    })
  })

  it('pullOnSendStart with empty COS does not fail', async () => {
    await engine.pullOnSendStart()
    expect(engine.baselineSnapshot().size).toBe(0)
  })

  it('pullOnSendStart materializes remote files into localDir', async () => {
    await store.put({ envId: 'env-1', userId: 'alice' }, 'CLAUDE.md', Buffer.from('seeded'))
    await engine.pullOnSendStart()
    expect(await readFile(localDir, 'CLAUDE.md')).toBe('seeded')
  })

  it('pushOnSendEnd uploads new files', async () => {
    await engine.pullOnSendStart()
    await writeFile(localDir, 'CLAUDE.md', 'new content')
    await engine.pushOnSendEnd()

    // 重新 pull 验证 COS 上有内容
    const fresh = new ClaudeHomeSyncEngine({
      store,
      ctx: { envId: 'env-1', userId: 'alice' },
      localDir: await fs.mkdtemp(path.join(os.tmpdir(), 'oak-sync-fresh-')),
    })
    await fresh.pullOnSendStart()
    expect(fresh.baselineSnapshot().has('CLAUDE.md')).toBe(true)
  })

  it('pushOnSendEnd skips unchanged files (hash short-circuit)', async () => {
    await store.put({ envId: 'env-1', userId: 'alice' }, 'CLAUDE.md', Buffer.from('v1'))
    await engine.pullOnSendStart()
    // 不修改本地,直接 push
    await engine.pushOnSendEnd()
    // baselineSnapshot 仍然只有 CLAUDE.md,且 hash 不变
    expect(engine.baselineSnapshot().size).toBe(1)
  })

  it('pushOnSendEnd uploads changed files', async () => {
    await store.put({ envId: 'env-1', userId: 'alice' }, 'CLAUDE.md', Buffer.from('v1'))
    await engine.pullOnSendStart()
    await writeFile(localDir, 'CLAUDE.md', 'v2')
    await engine.pushOnSendEnd()

    // 起一个新 engine 验证远端
    const fresh = new ClaudeHomeSyncEngine({
      store,
      ctx: { envId: 'env-1', userId: 'alice' },
      localDir: await fs.mkdtemp(path.join(os.tmpdir(), 'oak-sync-fresh2-')),
    })
    await fresh.pullOnSendStart()
    expect(await readFile(fresh.opts.localDir, 'CLAUDE.md')).toBe('v2')
  })

  it('pushOnSendEnd does reverse deletion (baseline has, currentMap missing)', async () => {
    await store.put({ envId: 'env-1', userId: 'alice' }, 'CLAUDE.md', Buffer.from('to-be-deleted'))
    await engine.pullOnSendStart()
    // 本地删除文件
    await fs.unlink(path.join(localDir, 'CLAUDE.md'))
    await engine.pushOnSendEnd()

    // 新 engine pull 应得到空
    const fresh = new ClaudeHomeSyncEngine({
      store,
      ctx: { envId: 'env-1', userId: 'alice' },
      localDir: await fs.mkdtemp(path.join(os.tmpdir(), 'oak-sync-fresh3-')),
    })
    await fresh.pullOnSendStart()
    expect(fresh.baselineSnapshot().size).toBe(0)
  })

  it('pushOnSendEnd ignores non-SYNC_INCLUDES files', async () => {
    await engine.pullOnSendStart()
    await writeFile(localDir, 'settings.json', '{}')
    await writeFile(localDir, '.claude.json', '{"oauth":"token"}')
    await engine.pushOnSendEnd()

    // 远端不应有这些 key
    const fresh = new ClaudeHomeSyncEngine({
      store,
      ctx: { envId: 'env-1', userId: 'alice' },
      localDir: await fs.mkdtemp(path.join(os.tmpdir(), 'oak-sync-fresh4-')),
    })
    await fresh.pullOnSendStart()
    expect(fresh.baselineSnapshot().has('settings.json')).toBe(false)
    expect(fresh.baselineSnapshot().has('.claude.json')).toBe(false)
  })

  it('baseline updates after push for next-cycle diff', async () => {
    await engine.pullOnSendStart()
    await writeFile(localDir, 'CLAUDE.md', 'v1')
    await engine.pushOnSendEnd()
    const baselineAfterFirst = new Map(engine.baselineSnapshot())

    // 第二轮:本地不变,push 应不上传任何东西(短路)
    await engine.pushOnSendEnd()
    const baselineAfterSecond = new Map(engine.baselineSnapshot())
    expect(baselineAfterSecond).toEqual(baselineAfterFirst)
  })

  it('writes default settings.json with autoMemoryEnabled=true after pullOnSendStart (when missing)', async () => {
    await engine.pullOnSendStart()
    const settingsPath = path.join(localDir, 'settings.json')
    const content = await fs.readFile(settingsPath, 'utf8')
    const parsed = JSON.parse(content)
    expect(parsed.autoMemoryEnabled).toBe(true)
  })

  it('preserves existing settings.json (only fills missing autoMemoryEnabled)', async () => {
    // pre-populate COS with a custom settings.json (missing autoMemoryEnabled)
    await store.put(
      { envId: 'env-1', userId: 'alice' },
      'settings.json',
      Buffer.from(JSON.stringify({ theme: 'dark' })),
    )
    await engine.pullOnSendStart()
    const content = await fs.readFile(path.join(localDir, 'settings.json'), 'utf8')
    const parsed = JSON.parse(content)
    expect(parsed.autoMemoryEnabled).toBe(true)
    expect(parsed.theme).toBe('dark')
  })

  it('does not modify settings.json that already has autoMemoryEnabled', async () => {
    await store.put(
      { envId: 'env-1', userId: 'alice' },
      'settings.json',
      Buffer.from(JSON.stringify({ autoMemoryEnabled: false, foo: 'bar' })),
    )
    await engine.pullOnSendStart()
    const content = await fs.readFile(path.join(localDir, 'settings.json'), 'utf8')
    const parsed = JSON.parse(content)
    expect(parsed).toEqual({ autoMemoryEnabled: false, foo: 'bar' })
  })

  it('handles deeply nested paths', async () => {
    await engine.pullOnSendStart()
    await writeFile(localDir, 'projects/abc/memory/MEMORY.md', '# index')
    await writeFile(localDir, 'projects/abc/memory/debugging.md', '# debug notes')
    await engine.pushOnSendEnd()

    const fresh = new ClaudeHomeSyncEngine({
      store,
      ctx: { envId: 'env-1', userId: 'alice' },
      localDir: await fs.mkdtemp(path.join(os.tmpdir(), 'oak-sync-fresh5-')),
    })
    await fresh.pullOnSendStart()
    expect(fresh.baselineSnapshot().has('projects/abc/memory/MEMORY.md')).toBe(true)
    expect(fresh.baselineSnapshot().has('projects/abc/memory/debugging.md')).toBe(true)
  })

  it('handles partial-failure: upload succeeds, delete fails preserves baseline entry', async () => {
    // setup: store 中有 CLAUDE.md 和 obsolete agent-memory file
    await store.put({ envId: 'env-1', userId: 'alice' }, 'CLAUDE.md', Buffer.from('keep'))
    await store.put({ envId: 'env-1', userId: 'alice' }, 'agent-memory/foo/MEMORY.md', Buffer.from('to-delete'))
    await engine.pullOnSendStart()

    // 删除 agent-memory/foo/MEMORY.md(本地)→ 应触发反向删除
    await fs.unlink(path.join(localDir, 'agent-memory/foo/MEMORY.md'))

    // 让 store.delete 抛错(用 spy)
    let deleteCalled = false
    store.delete = async (_ctx, _relPath) => {
      deleteCalled = true
      throw new Error('simulated COS delete failure')
    }

    // pushOnSendEnd 应不抛(graceful degrade),但 baseline 应保留 obsolete 项以便下次重试
    await expect(engine.pushOnSendEnd()).resolves.toBeUndefined()
    expect(deleteCalled).toBe(true)
    expect(engine.baselineSnapshot().has('agent-memory/foo/MEMORY.md')).toBe(true)
  })
})
