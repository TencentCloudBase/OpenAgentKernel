import { describe, it, expect, beforeEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { InMemoryClaudeHomeStore } from '../in-memory-store.js'
import { WorkspaceCwdArchiveEngine, createWorkspaceCwdArchiveEngine } from '../workspace-cwd-archive-engine.js'
import type { ClaudeHomeContext } from '../types.js'

async function write(dir: string, rel: string, content: string): Promise<void> {
  const abs = path.join(dir, rel)
  await fs.mkdir(path.dirname(abs), { recursive: true })
  await fs.writeFile(abs, content)
}

async function readOrNull(dir: string, rel: string): Promise<string | null> {
  try {
    return await fs.readFile(path.join(dir, rel), 'utf8')
  } catch {
    return null
  }
}

const ctx: ClaudeHomeContext = { envId: 'env-1', userId: 'alice', sessionId: 'sess-1' }

describe('WorkspaceCwdArchiveEngine', () => {
  let store: InMemoryClaudeHomeStore
  let cwd: string

  function makeEngine(maxFileBytes?: number): WorkspaceCwdArchiveEngine {
    return new WorkspaceCwdArchiveEngine({
      store,
      ctx,
      cwd,
      ...(maxFileBytes !== undefined ? { maxFileBytes } : {}),
    })
  }

  beforeEach(async () => {
    store = new InMemoryClaudeHomeStore()
    cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'oak-archive-test-'))
  })

  it('pull on empty COS (first run) → no-op, cwd stays empty', async () => {
    const engine = makeEngine()
    await engine.pullOnSendStart()
    // cwd exists but empty
    const entries = await fs.readdir(cwd)
    expect(entries.length).toBe(0)
  })

  it('push → pull round-trip restores files', async () => {
    await write(cwd, 'src/index.ts', 'console.log(1)')
    await write(cwd, 'README.md', '# hi')
    await write(cwd, 'a/b/c.txt', 'deep')

    // push to store
    await makeEngine().pushOnSendEnd()

    // fresh cwd, pull, expect files restored
    const cwd2 = await fs.mkdtemp(path.join(os.tmpdir(), 'oak-archive-test2-'))
    const engine2 = new WorkspaceCwdArchiveEngine({ store, ctx, cwd: cwd2 })
    await engine2.pullOnSendStart()

    expect(await readOrNull(cwd2, 'src/index.ts')).toBe('console.log(1)')
    expect(await readOrNull(cwd2, 'README.md')).toBe('# hi')
    expect(await readOrNull(cwd2, 'a/b/c.txt')).toBe('deep')
  })

  it('excludes node_modules / .git / .oak from the archive', async () => {
    await write(cwd, 'src/index.ts', 'ok')
    await write(cwd, 'node_modules/foo/index.js', 'junk')
    await write(cwd, '.git/config', 'junk')
    await write(cwd, '.oak/agent/.claude/settings.json', '{}')

    await makeEngine().pushOnSendEnd()

    const cwd2 = await fs.mkdtemp(path.join(os.tmpdir(), 'oak-archive-excl-'))
    const engine2 = new WorkspaceCwdArchiveEngine({ store, ctx, cwd: cwd2 })
    await engine2.pullOnSendStart()

    expect(await readOrNull(cwd2, 'src/index.ts')).toBe('ok')
    expect(await readOrNull(cwd2, 'node_modules/foo/index.js')).toBeNull()
    expect(await readOrNull(cwd2, '.git/config')).toBeNull()
    expect(await readOrNull(cwd2, '.oak/agent/.claude/settings.json')).toBeNull()
  })

  it('skips files larger than maxFileBytes', async () => {
    await write(cwd, 'small.txt', 'x')
    await write(cwd, 'big.bin', 'x'.repeat(2000))

    await makeEngine(1000).pushOnSendEnd()

    const cwd2 = await fs.mkdtemp(path.join(os.tmpdir(), 'oak-archive-big-'))
    const engine2 = new WorkspaceCwdArchiveEngine({ store, ctx, cwd: cwd2 })
    await engine2.pullOnSendStart()

    expect(await readOrNull(cwd2, 'small.txt')).toBe('x')
    expect(await readOrNull(cwd2, 'big.bin')).toBeNull()
  })

  it('push overwrites previous archive (no duplication)', async () => {
    await write(cwd, 'a.txt', 'v1')
    await makeEngine().pushOnSendEnd()

    await write(cwd, 'a.txt', 'v2')
    await write(cwd, 'b.txt', 'new')
    await makeEngine().pushOnSendEnd()

    const cwd2 = await fs.mkdtemp(path.join(os.tmpdir(), 'oak-archive-ow-'))
    const engine2 = new WorkspaceCwdArchiveEngine({ store, ctx, cwd: cwd2 })
    await engine2.pullOnSendStart()

    expect(await readOrNull(cwd2, 'a.txt')).toBe('v2')
    expect(await readOrNull(cwd2, 'b.txt')).toBe('new')
  })
})

describe('createWorkspaceCwdArchiveEngine validation', () => {
  it('throws when sessionId is missing', () => {
    expect(() =>
      createWorkspaceCwdArchiveEngine({
        credentials: { envId: 'e', secretId: 's', secretKey: 'k' },
        envId: 'e',
        userId: 'u',
        sessionId: '',
        cwd: '/tmp/x',
      }),
    ).toThrow()
  })
})
