import { describe, it, expect, beforeEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { InMemoryClaudeHomeStore } from '../in-memory-store.js'

const ctxA = { envId: 'env-a', userId: 'alice' }
const ctxB = { envId: 'env-a', userId: 'bob' }

describe('InMemoryClaudeHomeStore', () => {
  let store: InMemoryClaudeHomeStore
  let tmpDir: string

  beforeEach(async () => {
    store = new InMemoryClaudeHomeStore()
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oak-claude-home-test-'))
  })

  it('pull on empty namespace returns empty Map and creates no files', async () => {
    const baseline = await store.pull(ctxA, tmpDir)
    expect(baseline.size).toBe(0)
    const entries = await fs.readdir(tmpDir).catch(() => [])
    expect(entries).toEqual([])
  })

  it('put + pull roundtrip writes file content with correct hash', async () => {
    await store.put(ctxA, 'CLAUDE.md', Buffer.from('hello world'))
    const baseline = await store.pull(ctxA, tmpDir)
    expect(baseline.size).toBe(1)
    const content = await fs.readFile(path.join(tmpDir, 'CLAUDE.md'), 'utf8')
    expect(content).toBe('hello world')
    const hash = baseline.get('CLAUDE.md')
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('put creates nested directories on pull', async () => {
    await store.put(ctxA, 'projects/abc/memory/MEMORY.md', Buffer.from('# memory'))
    await store.pull(ctxA, tmpDir)
    const content = await fs.readFile(
      path.join(tmpDir, 'projects', 'abc', 'memory', 'MEMORY.md'),
      'utf8'
    )
    expect(content).toBe('# memory')
  })

  it('delete removes object', async () => {
    await store.put(ctxA, 'CLAUDE.md', Buffer.from('v1'))
    await store.delete(ctxA, 'CLAUDE.md')
    const baseline = await store.pull(ctxA, tmpDir)
    expect(baseline.size).toBe(0)
  })

  it('delete non-existent is silent', async () => {
    await expect(store.delete(ctxA, 'nope.md')).resolves.toBeUndefined()
  })

  it('isolates different users', async () => {
    await store.put(ctxA, 'CLAUDE.md', Buffer.from('alice content'))
    await store.put(ctxB, 'CLAUDE.md', Buffer.from('bob content'))
    const aBaseline = await store.pull(ctxA, tmpDir)
    expect(aBaseline.size).toBe(1)
    const aContent = await fs.readFile(path.join(tmpDir, 'CLAUDE.md'), 'utf8')
    expect(aContent).toBe('alice content')
  })

  it('put overwrites existing key', async () => {
    await store.put(ctxA, 'CLAUDE.md', Buffer.from('v1'))
    await store.put(ctxA, 'CLAUDE.md', Buffer.from('v2'))
    await store.pull(ctxA, tmpDir)
    const content = await fs.readFile(path.join(tmpDir, 'CLAUDE.md'), 'utf8')
    expect(content).toBe('v2')
  })
})
