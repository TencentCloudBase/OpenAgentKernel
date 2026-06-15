import { getPlatformCredentials, getSandboxApiKey } from './_shared/env.js'
import { AgsStatefulSandbox } from '@cloudbase/open-agent-kernel'

async function main(): Promise<void> {
  const credentials = getPlatformCredentials()
  const runtime = new AgsStatefulSandbox({ apiKey: getSandboxApiKey() })
  const sandbox = await runtime.acquire({
    envId: credentials.envId,
    credentials,
    conversationId: 'probe5',
    scope: 'session',
  })

  // 写文件
  await sandbox.request('/api/tools/bash', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      command: 'mcporter list cloudbase --schema --output json > .oak-cb-schema.json 2>&1',
      timeout: 30_000,
    }),
  })

  // 分块读
  const PAGE = 1500
  let offset = 1
  let totalLines: number | undefined
  const lines: string[] = []
  for (let p = 0; p < 50; p++) {
    const res = await sandbox.request('/api/tools/read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '.oak-cb-schema.json', offset, limit: PAGE }),
    })
    const data = (await res.json()) as { result?: { content?: string; totalLines?: number; truncated?: boolean } }
    const r = data.result ?? {}
    const content = String(r.content ?? '')
    if (!content) break
    const pageLines = content.split('\n')
    console.log(`page ${p}: offset=${offset} got ${pageLines.length} lines`)
    console.log(`  first line raw: ${JSON.stringify(pageLines[0]?.slice(0, 100))}`)
    console.log(`  last  line raw: ${JSON.stringify(pageLines[pageLines.length - 1]?.slice(0, 100))}`)
    lines.push(
      ...pageLines.map((l) => {
        const m = /^\d+:\s?(.*)$/.exec(l)
        return m ? m[1] : l
      }),
    )
    if (typeof r.totalLines === 'number') totalLines = r.totalLines
    if (!r.truncated) break
    offset += pageLines.length
    if (totalLines !== undefined && offset > totalLines) break
  }

  const raw = lines.join('\n').trim()
  console.log('\n=== assembled length:', raw.length)

  // 看 91400-91500 的位置
  console.log('=== around offset 91400-91500:')
  console.log(JSON.stringify(raw.slice(91400, 91500)))
  // 也看一下 \n vs \\n 的混用
  const ctrlIdx = raw.search(/[\x00-\x08\x0b-\x1f]/)
  console.log('=== first bare control char at:', ctrlIdx)
  if (ctrlIdx >= 0) {
    console.log('=== context:', JSON.stringify(raw.slice(Math.max(0, ctrlIdx - 50), ctrlIdx + 50)))
    console.log('=== char code:', raw.charCodeAt(ctrlIdx))
  }

  try {
    const parsed = JSON.parse(raw) as { tools?: unknown[] }
    console.log('PARSE OK, tools.length =', parsed.tools?.length)
  } catch (e) {
    console.log('PARSE ERROR:', (e as Error).message)
  }

  await sandbox.release()
}
main().catch((e) => {
  console.error(e)
  process.exit(1)
})
