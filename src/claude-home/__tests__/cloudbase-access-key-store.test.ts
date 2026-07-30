import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CloudBaseAccessKeyClaudeHomeStore } from '../cloudbase-cos-store.js'
import { sha256OfBuffer } from '../dedup.js'

const ctx = { envId: 'env-test', userId: 'alice' }
const prefix = 'oak/users/alice/claude-home/'
const manifestKey = 'oak/users/alice/claude-home-manifest.json'
const manifestFileID = 'cloud://real-bucket/manifest'

interface FakeApp {
  uploadFile: ReturnType<typeof vi.fn>
  getUploadMetadata: ReturnType<typeof vi.fn>
  getTempFileURL: ReturnType<typeof vi.fn>
  deleteFile: ReturnType<typeof vi.fn>
}

function newStore(): CloudBaseAccessKeyClaudeHomeStore {
  return new CloudBaseAccessKeyClaudeHomeStore({ envId: ctx.envId, accessKey: 'test-access-key' })
}

function makeApp(overrides: Partial<FakeApp> = {}): FakeApp {
  return {
    uploadFile: overrides.uploadFile ?? vi.fn().mockResolvedValue({ fileID: 'cloud://real-bucket/uploaded' }),
    getUploadMetadata:
      overrides.getUploadMetadata ??
      vi.fn().mockImplementation(async ({ cloudPath }: { cloudPath: string }) => ({
        data: { fileId: cloudPath === manifestKey ? manifestFileID : `cloud://real-bucket/${cloudPath}` },
      })),
    getTempFileURL:
      overrides.getTempFileURL ??
      vi.fn().mockImplementation(async ({ fileList }: { fileList: Array<{ fileID: string }> }) => ({
        fileList: [{ fileID: fileList[0].fileID, code: 'SUCCESS', tempFileURL: `https://signed/${fileList[0].fileID}` }],
      })),
    deleteFile:
      overrides.deleteFile ??
      vi.fn().mockImplementation(async ({ fileList }: { fileList: string[] }) => ({
        fileList: fileList.map((fileID) => ({ fileID, code: 'SUCCESS' })),
      })),
  }
}

function attachApp(store: CloudBaseAccessKeyClaudeHomeStore, app: FakeApp) {
  const init = vi.fn().mockReturnValue(app)
  vi.spyOn(
    store as unknown as { requireCloudBase: () => Promise<unknown> },
    'requireCloudBase',
  ).mockResolvedValue({ init })
  return init
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200 })
}

describe('CloudBaseAccessKeyClaudeHomeStore', () => {
  let tmpRoot: string

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'oak-access-key-store-'))
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {})
  })

  it('initializes node-sdk with only env and accessKey', async () => {
    const store = newStore()
    const app = makeApp()
    const init = attachApp(store, app)
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response('', { status: 404 }))

    await store.pull(ctx, tmpRoot)

    expect(init).toHaveBeenCalledTimes(1)
    expect(init).toHaveBeenCalledWith({ env: 'env-test', accessKey: 'test-access-key' })
  })

  it('reads an existing manifest and writes the uploaded real fileID in deterministic path order', async () => {
    const store = newStore()
    const oldContent = Buffer.from('old')
    const existingManifest = {
      version: 1,
      files: [
        {
          path: 'projects/z/memory/MEMORY.md',
          fileID: 'cloud://real-bucket/old',
          sha256: sha256OfBuffer(oldContent),
          mtimeMs: 10,
        },
      ],
    }
    const uploadedFileID = 'cloud://7979-env-test/oak/users/alice/claude-home/CLAUDE.md'
    const uploadedManifests: Buffer[] = []
    const app = makeApp({
      uploadFile: vi.fn().mockImplementation(async ({ cloudPath, fileContent }) => {
        if (cloudPath === manifestKey) {
          uploadedManifests.push(Buffer.from(fileContent))
          return { fileID: manifestFileID }
        }
        return { fileID: uploadedFileID }
      }),
    })
    attachApp(store, app)
    vi.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (url.includes(manifestFileID)) return jsonResponse(existingManifest)
      return new Response('', { status: 404 })
    })

    await store.put(ctx, 'CLAUDE.md', Buffer.from('new instruction'))

    expect(app.uploadFile.mock.calls[0][0]).toMatchObject({
      cloudPath: prefix + 'CLAUDE.md',
      fileContent: Buffer.from('new instruction'),
    })
    expect(uploadedManifests).toHaveLength(1)
    const written = JSON.parse(uploadedManifests[0].toString('utf8'))
    expect(written.version).toBe(1)
    expect(written.files.map((entry: { path: string }) => entry.path)).toEqual([
      'CLAUDE.md',
      'projects/z/memory/MEMORY.md',
    ])
    expect(written.files[0]).toMatchObject({
      path: 'CLAUDE.md',
      fileID: uploadedFileID,
      sha256: sha256OfBuffer(Buffer.from('new instruction')),
    })
    expect(app.getUploadMetadata).toHaveBeenCalledWith({ cloudPath: manifestKey })
  })

  it('binds pull to entry.path, ignores a malicious manifest fileID, and repairs the cache', async () => {
    const store = newStore()
    const content = Buffer.from('actual content')
    const dataFileID = 'cloud://real-bucket/data-id'
    const attackerFileID = 'cloud://attacker-bucket/secret'
    const manifest = {
      version: 1,
      files: [{ path: 'CLAUDE.md', fileID: attackerFileID, sha256: '0'.repeat(64), mtimeMs: 10 }],
    }
    let repairedManifest: Buffer | undefined
    const app = makeApp({
      getUploadMetadata: vi.fn().mockImplementation(async ({ cloudPath }: { cloudPath: string }) => ({
        data: { fileId: cloudPath === manifestKey ? manifestFileID : dataFileID },
      })),
      uploadFile: vi.fn().mockImplementation(async ({ cloudPath, fileContent }) => {
        if (cloudPath === manifestKey) repairedManifest = Buffer.from(fileContent)
        return { fileID: cloudPath === manifestKey ? manifestFileID : dataFileID }
      }),
    })
    attachApp(store, app)
    vi.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (url.includes(manifestFileID)) return jsonResponse(manifest)
      if (url.includes(dataFileID)) return new Response(content, { status: 200 })
      return new Response('', { status: 404 })
    })
    vi.spyOn(Date, 'now').mockReturnValue(1234)

    const baseline = await store.pull(ctx, tmpRoot)

    expect(await fs.readFile(path.join(tmpRoot, 'CLAUDE.md'), 'utf8')).toBe('actual content')
    expect(baseline.get('CLAUDE.md')).toBe(sha256OfBuffer(content))
    expect(app.getTempFileURL).toHaveBeenCalledWith({ fileList: [{ fileID: dataFileID, maxAge: 600 }] })
    expect(app.getTempFileURL).not.toHaveBeenCalledWith({ fileList: [{ fileID: attackerFileID, maxAge: 600 }] })
    expect(JSON.parse(repairedManifest!.toString('utf8')).files[0]).toMatchObject({
      fileID: dataFileID,
      sha256: sha256OfBuffer(content),
      mtimeMs: 1234,
    })
  })

  it('recovers legacy CLAUDE.md when no manifest exists and seeds a manifest with its real fileID', async () => {
    const store = newStore()
    const legacyContent = Buffer.from('legacy memory')
    const legacyFileID = 'cloud://7979-env-test/oak/users/alice/claude-home/CLAUDE.md'
    let seededManifest: Buffer | undefined
    const app = makeApp({
      getUploadMetadata: vi.fn().mockImplementation(async ({ cloudPath }: { cloudPath: string }) => ({
        data: { fileId: cloudPath === manifestKey ? manifestFileID : legacyFileID },
      })),
      uploadFile: vi.fn().mockImplementation(async ({ cloudPath, fileContent }) => {
        if (cloudPath === manifestKey) seededManifest = Buffer.from(fileContent)
        return { fileID: manifestFileID }
      }),
    })
    attachApp(store, app)
    vi.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (url.includes(manifestFileID)) return new Response('', { status: 404 })
      if (url.includes(legacyFileID)) return new Response(legacyContent, { status: 200 })
      return new Response('', { status: 404 })
    })

    const baseline = await store.pull(ctx, tmpRoot)

    expect(baseline.get('CLAUDE.md')).toBe(sha256OfBuffer(legacyContent))
    expect(await fs.readFile(path.join(tmpRoot, 'CLAUDE.md'), 'utf8')).toBe('legacy memory')
    expect(JSON.parse(seededManifest!.toString('utf8')).files).toEqual([
      expect.objectContaining({
        path: 'CLAUDE.md',
        fileID: legacyFileID,
        sha256: sha256OfBuffer(legacyContent),
      }),
    ])
    expect(app.getUploadMetadata).toHaveBeenCalledWith({ cloudPath: prefix + 'CLAUDE.md' })
  })

  it('adds CLAUDE.md written later by the CAM path to an already-existing manifest', async () => {
    const store = newStore()
    const projectContent = Buffer.from('project memory')
    const legacyContent = Buffer.from('CAM added this later')
    const projectPath = 'projects/z/memory/MEMORY.md'
    const projectFileID = 'cloud://real-bucket/project-memory'
    const legacyFileID = 'cloud://real-bucket/late-CLAUDE.md'
    const existingManifest = {
      version: 1,
      files: [
        {
          path: projectPath,
          fileID: projectFileID,
          sha256: sha256OfBuffer(projectContent),
          mtimeMs: 10,
        },
      ],
    }
    let reconciledManifest: Buffer | undefined
    const app = makeApp({
      getUploadMetadata: vi.fn().mockImplementation(async ({ cloudPath }: { cloudPath: string }) => ({
        data: {
          fileId:
            cloudPath === manifestKey
              ? manifestFileID
              : cloudPath === prefix + 'CLAUDE.md'
                ? legacyFileID
                : projectFileID,
        },
      })),
      uploadFile: vi.fn().mockImplementation(async ({ cloudPath, fileContent }) => {
        if (cloudPath === manifestKey) reconciledManifest = Buffer.from(fileContent)
        return { fileID: manifestFileID }
      }),
    })
    attachApp(store, app)
    vi.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (url.includes(manifestFileID)) return jsonResponse(existingManifest)
      if (url.includes(legacyFileID)) return new Response(legacyContent, { status: 200 })
      if (url.includes(projectFileID)) return new Response(projectContent, { status: 200 })
      return new Response('', { status: 404 })
    })

    const baseline = await store.pull(ctx, tmpRoot)

    expect([...baseline.keys()].sort()).toEqual(['CLAUDE.md', projectPath])
    expect(JSON.parse(reconciledManifest!.toString('utf8')).files).toEqual([
      expect.objectContaining({ path: 'CLAUDE.md', fileID: legacyFileID }),
      expect.objectContaining({ path: projectPath, fileID: projectFileID }),
    ])
  })

  it('returns an empty baseline when neither manifest nor fixed legacy CLAUDE.md exists', async () => {
    const store = newStore()
    const app = makeApp()
    attachApp(store, app)
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response('', { status: 404 }))

    const baseline = await store.pull(ctx, tmpRoot)

    expect(baseline.size).toBe(0)
    expect(app.uploadFile).not.toHaveBeenCalled()
    expect(app.getUploadMetadata).toHaveBeenCalledTimes(2)
    expect(app.getUploadMetadata).not.toHaveBeenCalledWith(
      expect.objectContaining({ cloudPath: expect.stringContaining('projects/') }),
    )
  })

  it('binds delete to relPath and never deletes a malicious manifest fileID', async () => {
    const store = newStore()
    const dataFileID = 'cloud://real-bucket/data-id'
    const attackerFileID = 'cloud://attacker-bucket/secret'
    const manifest = {
      version: 1,
      files: [
        {
          path: 'CLAUDE.md',
          fileID: attackerFileID,
          sha256: sha256OfBuffer(Buffer.from('memory')),
          mtimeMs: 10,
        },
      ],
    }
    const app = makeApp({
      getUploadMetadata: vi.fn().mockImplementation(async ({ cloudPath }: { cloudPath: string }) => ({
        data: { fileId: cloudPath === manifestKey ? manifestFileID : dataFileID },
      })),
    })
    attachApp(store, app)
    vi.spyOn(global, 'fetch').mockImplementation(async (input) =>
      String(input).includes(manifestFileID) ? jsonResponse(manifest) : new Response('', { status: 404 }),
    )

    await store.delete(ctx, 'CLAUDE.md')

    expect(app.deleteFile).toHaveBeenNthCalledWith(1, { fileList: [dataFileID] })
    expect(app.deleteFile).toHaveBeenNthCalledWith(2, { fileList: [manifestFileID] })
    expect(app.deleteFile).not.toHaveBeenCalledWith({ fileList: [attackerFileID] })
    expect(app.uploadFile).not.toHaveBeenCalled()
  })

  it('serializes concurrent manifest mutations on one store instance', async () => {
    const store = newStore()
    let currentManifest: {
      version: number
      files: Array<{ path: string; fileID: string; sha256: string; mtimeMs: number }>
    } = { version: 1, files: [] }
    let releaseFirst!: () => void
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const calls: string[] = []
    let dataUploadCount = 0
    const app = makeApp({
      uploadFile: vi.fn().mockImplementation(async ({ cloudPath, fileContent }) => {
        calls.push(cloudPath)
        if (cloudPath === manifestKey) {
          currentManifest = JSON.parse(Buffer.from(fileContent).toString('utf8'))
          return { fileID: manifestFileID }
        }
        dataUploadCount += 1
        const fileID = `cloud://real-bucket/data-${dataUploadCount}`
        if (dataUploadCount === 1) await firstBlocked
        return { fileID }
      }),
    })
    attachApp(store, app)
    vi.spyOn(global, 'fetch').mockImplementation(async (input) =>
      String(input).includes(manifestFileID)
        ? jsonResponse(currentManifest)
        : new Response('', { status: 404 }),
    )

    const firstPath = 'agent-memory/a/MEMORY.md'
    const secondPath = 'projects/b/memory/MEMORY.md'
    const first = store.put(ctx, firstPath, Buffer.from('one'))
    await vi.waitFor(() => expect(calls).toEqual([prefix + firstPath]))
    const second = store.put(ctx, secondPath, Buffer.from('two'))
    await Promise.resolve()
    expect(calls).toEqual([prefix + firstPath])

    releaseFirst()
    await Promise.all([first, second])

    expect(calls).toEqual([
      prefix + firstPath,
      manifestKey,
      prefix + secondPath,
      manifestKey,
    ])
    expect(currentManifest.files).toEqual([
      expect.objectContaining({ path: firstPath, fileID: 'cloud://real-bucket/data-1' }),
      expect.objectContaining({ path: secondPath, fileID: 'cloud://real-bucket/data-2' }),
    ])
  })
})
