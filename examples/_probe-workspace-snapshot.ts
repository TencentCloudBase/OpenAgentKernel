/**
 * Debug script: probe sandbox HTTP endpoints to verify Spec B prerequisites.
 *
 * 不经过 createAgent / SDK,只走 AgsStatefulSandbox.acquire 拿 inst,
 * 然后直接打 GET /health / POST /api/workspace/init / POST /api/workspace/snapshot,
 * 把响应原样打印。
 *
 * 验证目标:
 *   1. /health body 里 restoreStatus 字段实际是什么(null? SyncStatus?)
 *   2. /health body 里有没有 cosMountDir / cos_mount 等 hint(说明镜像是否挂了 COS)
 *   3. /api/workspace/init 200 body 里 git/env 是什么
 *   4. /api/workspace/snapshot 真的能跑还是 fail("COS not configured" 之类)
 *
 * Run:
 *   pnpm dlx tsx packages/open-agent-kernel/examples/_probe-workspace-snapshot.ts
 */

import { AgsStatefulSandbox } from '../src/sandbox/index.js'
import { getPlatformCredentials, getSandboxApiKey, loadEnv } from './_shared/env.js'

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text()
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function head(label: string): void {
  console.log(`\n──── ${label} ${'─'.repeat(Math.max(0, 70 - label.length))}`)
}

async function main() {
  loadEnv()
  const credentials = getPlatformCredentials()
  const envId = credentials.envId

  const conversationId = `probe-${Date.now()}`
  console.log(`[probe] envId=${envId}  conversationId=${conversationId}  scope=shared`)

  const runtime = new AgsStatefulSandbox({ apiKey: getSandboxApiKey() })
  const inst = await runtime.acquire({
    envId,
    credentials,
    conversationId,
    scope: 'shared',
    onProgress: (m) => console.log(`[probe][acquire] ${m.phase}: ${m.message}`),
  })

  console.log(`\n[probe] instance acquired: id=${inst.id}`)

  // ── 1. GET /health 看完整 body,特别看 restoreStatus / disk / sidecars ──
  head('GET /health(完整 body)')
  try {
    const r = await inst.request('/health', { method: 'GET' })
    console.log(`status=${r.status}`)
    const body = await readBody(r)
    console.log(JSON.stringify(body, null, 2))
  } catch (err) {
    console.error('health failed:', err)
  }

  // ── 2. POST /api/workspace/init body 含 env(不传敏感凭证,只看返回) ──
  head('POST /api/workspace/init(空 env body — 只触发 ensureWorkspace)')
  try {
    const r = await inst.request('/api/workspace/init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    console.log(`status=${r.status}`)
    const body = await readBody(r)
    console.log(JSON.stringify(body, null, 2))
  } catch (err) {
    console.error('init failed:', err)
  }

  // ── 3. 再次 GET /health 看 init 后 restoreStatus 有没有值 ──
  head('GET /health(init 之后)')
  try {
    const r = await inst.request('/health', { method: 'GET' })
    console.log(`status=${r.status}`)
    const body = (await readBody(r)) as Record<string, unknown> | string
    if (typeof body === 'object' && body !== null) {
      const compact: Record<string, unknown> = {
        ok: body.ok,
        status: body.status,
        restoreStatus: body.restoreStatus,
        instance: body.instance,
        // sidecars / system 太长,打出关键字段
        diskMB: (body.system as Record<string, unknown> | undefined)?.disk,
        bootProfile: body.bootProfile,
      }
      console.log(JSON.stringify(compact, null, 2))
    } else {
      console.log(body)
    }
  } catch (err) {
    console.error('health2 failed:', err)
  }

  // ── 4. POST /api/workspace/snapshot — 关键!看是否真的能 snapshot ──
  head('POST /api/workspace/snapshot')
  try {
    const r = await inst.request('/api/workspace/snapshot', { method: 'POST' })
    console.log(`status=${r.status}`)
    const body = await readBody(r)
    console.log(JSON.stringify(body, null, 2))
  } catch (err) {
    console.error('snapshot failed:', err)
  }

  // ── 5. 顺手在 sandbox 里写个文件,看 ls + cat 跟 snapshot 关联 ──
  head('POST /api/tools/bash — ls /home/user(看有没有 cos mount 痕迹)')
  try {
    const r = await inst.request('/api/tools/bash', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        command:
          'ls -la /home/user; echo "---"; mount | grep -i cos || echo "no cos mount"; echo "---"; env | grep -iE "cos|workspace" || echo "no cos env"',
      }),
    })
    console.log(`status=${r.status}`)
    const body = await readBody(r)
    console.log(typeof body === 'string' ? body : JSON.stringify(body, null, 2))
  } catch (err) {
    console.error('bash failed:', err)
  }

  await inst.release()
  console.log('\n[probe] done')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
