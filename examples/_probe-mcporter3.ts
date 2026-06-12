import { getPlatformCredentials, getSandboxApiKey } from './_shared/env.js'
import { AgsStatefulSandbox } from '@cloudbase/open-agent-kernel'

async function main(): Promise<void> {
  const credentials = getPlatformCredentials()
  const runtime = new AgsStatefulSandbox({ apiKey: getSandboxApiKey() })
  const sandbox = await runtime.acquire({
    envId: credentials.envId,
    credentials,
    conversationId: 'probe3',
    scope: 'session',
  })

  // Step 1: write schema to file
  const writeRes = await sandbox.request('/api/tools/bash', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      command: 'mcporter list cloudbase --schema --output json > /tmp/sch.json 2>&1 && wc -c /tmp/sch.json',
      timeout: 30_000,
    }),
  })
  const writeData = (await writeRes.json()) as { result?: { stdout?: string } }
  console.log('write step stdout:', writeData.result?.stdout)

  // Step 2: read via /api/tools/read
  const readRes = await sandbox.request('/api/tools/read', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: '/tmp/sch.json' }),
  })
  const readData = (await readRes.json()) as { success: boolean; result: unknown; error?: string }
  console.log('read response success:', readData.success)
  console.log('read result type:', typeof readData.result)
  if (typeof readData.result === 'object' && readData.result !== null) {
    console.log('read result keys:', Object.keys(readData.result))
  }
  const content = (readData.result as { content?: string })?.content
  console.log('content length:', content?.length)
  console.log('first 300 chars:', content?.slice(0, 300))
  console.log('last 300 chars:', content?.slice(-300))

  // 试试 cat via base64 拿完整文件（避开行号注入）
  const catRes = await sandbox.request('/api/tools/bash', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      command: 'base64 -w0 /tmp/sch.json',
      timeout: 30_000,
    }),
  })
  const catData = (await catRes.json()) as { result?: { stdout?: string } }
  const b64 = catData.result?.stdout?.trim() ?? ''
  console.log('base64 stdout length:', b64.length)
  if (b64) {
    const decoded = Buffer.from(b64, 'base64').toString('utf-8')
    console.log('decoded length:', decoded.length)
    try {
      const parsed = JSON.parse(decoded) as { tools?: unknown[] }
      console.log('parsed OK, tools.length =', parsed.tools?.length)
    } catch (e) {
      console.log('still parse error:', (e as Error).message)
    }
  }

  await sandbox.release()
}
main().catch((e) => {
  console.error(e)
  process.exit(1)
})
