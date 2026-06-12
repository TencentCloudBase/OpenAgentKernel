import { getPlatformCredentials, getSandboxApiKey } from './_shared/env.js'
import { AgsStatefulSandbox } from '@cloudbase/open-agent-kernel'

async function main(): Promise<void> {
  console.log('acquiring sandbox...')
  const credentials = getPlatformCredentials()
  const runtime = new AgsStatefulSandbox({ apiKey: getSandboxApiKey() })
  const sandbox = await runtime.acquire({
    envId: credentials.envId,
    credentials,
    conversationId: 'probe4',
    scope: 'session',
    onProgress: (m) => console.log('[probe]', m.phase, m.message),
  })
  console.log('sandbox.id =', sandbox.id)

  // Step 1: write schema to file
  console.log('\n--- bash: mcporter list ... > .oak-cb-schema.json ---')
  const writeRes = await sandbox.request('/api/tools/bash', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      command: 'mcporter list cloudbase --schema --output json > .oak-cb-schema.json 2>&1; wc -c .oak-cb-schema.json',
      timeout: 30_000,
    }),
  })
  console.log('write http status:', writeRes.status)
  const writeText = await writeRes.text()
  console.log('write raw body:', writeText.slice(0, 500))

  // Step 2: read via /api/tools/read
  console.log('\n--- read: .oak-cb-schema.json ---')
  const readRes = await sandbox.request('/api/tools/read', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: '.oak-cb-schema.json' }),
  })
  console.log('read http status:', readRes.status)
  const readBody = await readRes.text()
  console.log('read raw body length:', readBody.length)
  console.log('read raw first 800:', readBody.slice(0, 800))
  console.log('read raw last 400:', readBody.slice(-400))

  await sandbox.release()
}
main().catch((e) => {
  console.error(e)
  process.exit(1)
})
