import { createServer } from 'node:http'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve, extname } from 'node:path'
import { createRequire } from 'node:module'
import { platform, release, arch } from 'node:os'
import { verifyBrowser } from './verify.mjs'

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright')
const root = resolve(import.meta.dirname, '../..')
const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.wasm': 'application/wasm', '.svg': 'image/svg+xml' }
const server = createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname)
    if (!['/tools/graph-benchmark/', '/internal/app/web/static/', '/dist/'].some(prefix => pathname.startsWith(prefix))) throw new Error('Not found')
    const file = resolve(root, '.' + pathname)
    if (!file.startsWith(root + '/') || pathname.split('/').some(part => part.startsWith('.'))) throw new Error('Not found')
    const body = await readFile(file)
    res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' }); res.end(body)
  } catch { res.writeHead(404); res.end('Not found') }
})
await new Promise((yes, no) => { server.once('error', no); server.listen(0, '127.0.0.1', yes) })
let browser
try {
  browser = await chromium.launch({ headless: process.env.HEADED !== '1', executablePath: process.env.CHROME_PATH || (platform() === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined) })
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 })
  const page = await context.newPage(), errors = []
  const origin = `http://127.0.0.1:${server.address().port}`
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => { if (message.type() === 'error' && !message.text().startsWith('Failed to load resource:')) errors.push(message.text()) })
  page.on('response', response => { if (response.url().startsWith(origin) && response.status() >= 400) errors.push(`${response.status()} ${response.url()}`) })
  await page.goto(`${origin}/tools/graph-benchmark/index.html`)
  await page.waitForFunction(() => window.ready)
  const environment = await page.evaluate(async () => {
    const adapter = await navigator.gpu?.requestAdapter()
    return { userAgent: navigator.userAgent, gpu: !!adapter, fallbackAdapter: adapter?.info?.isFallbackAdapter, adapter: adapter ? { vendor: adapter.info.vendor, architecture: adapter.info.architecture, description: adapter.info.description } : null, devicePixelRatio }
  })
  console.log(JSON.stringify({ environment }))
  if (!environment.gpu) throw new Error('No WebGPU adapter. Do not report software/CPU results as a hardware benchmark.')
  const verify = process.argv.includes('--verify')
  const checks = verify ? await verifyBrowser(page) : undefined
  if (checks) console.log(JSON.stringify({ checks }))
  let livePayload
  const fixtureArg = process.argv.find(arg => arg.startsWith('--fixture='))
  if (fixtureArg) livePayload = JSON.parse(await readFile(resolve(root, fixtureArg.slice('--fixture='.length)), 'utf8')).livePayload
  if (process.argv.includes('--live')) {
    const target = 'github.com/spf13/cobra@latest'
    await page.goto(`${origin}/dist/index.html?renderer=webgpu#target=${encodeURIComponent(target)}`)
    await page.waitForFunction(() => document.getElementById('graph-canvas').dataset.graphRenderer === 'webgpu', null, { timeout: 60000 })
    livePayload = await page.evaluate(target => window.gomodLensResolveGraph(target), target)
    await page.screenshot({ path: '/private/tmp/gomod-lens-webgpu-app.png' })
    console.log(JSON.stringify({ liveTarget: livePayload.meta.target, nodes: livePayload.nodes.length, edges: livePayload.edges.length }))
    await page.goto(`${origin}/tools/graph-benchmark/index.html`); await page.waitForFunction(() => window.ready)
  }
  const layoutOnly = process.argv.includes('--layout')
  const smoke = process.argv.includes('--smoke'), results = [], sizes = verify || layoutOnly ? [] : livePayload ? [livePayload.nodes.length] : smoke ? [35] : [100, 500, 1500]
  const session = await context.newCDPSession(page); await session.send('Performance.enable')
  for (const nodes of sizes) {
    const fixture = await page.evaluate(({ nodes, payload }) => window.benchmark.prepare(nodes, payload), { nodes, payload: livePayload })
    const repetitions = smoke ? 1 : 3
    for (let trial = 0; trial < repetitions; trial++) {
      const modes = ['legacy', 'canvas', 'webgpu']; modes.push(...modes.splice(0, trial % 3))
      for (const mode of modes) {
        const setup = await page.evaluate(m => window.benchmark.setup(m), mode)
        const before = (await session.send('Performance.getMetrics')).metrics
        const timings = await page.evaluate(frames => window.benchmark.run(frames, 30), smoke ? 12 : 90)
        const after = (await session.send('Performance.getMetrics')).metrics
        const delta = name => (after.find(x => x.name === name).value - before.find(x => x.name === name).value) * 1000
        const result = { ...fixture, target: livePayload?.meta.target || 'synthetic', layout300StepsMs: fixture.layoutMs, mode, trial, ...setup, ...timings, taskMs: delta('TaskDuration'), scriptMs: delta('ScriptDuration'), browserLayoutMs: delta('LayoutDuration'), styleMs: delta('RecalcStyleDuration'), totalFrames: timings.frames + 30 }
        results.push(result); console.log(JSON.stringify(result))
        if (smoke && mode === 'webgpu') await page.screenshot({ path: '/private/tmp/gomod-lens-webgpu-smoke.png' })
      }
    }
  }
  if (layoutOnly) for (let trial = 0; trial < 3; trial++) {
    const modes = ['legacy', 'canvas', 'webgpu']; modes.push(...modes.splice(0, trial))
    for (const mode of modes) {
      const before = (await session.send('Performance.getMetrics')).metrics
      const result = await page.evaluate(mode => window.benchmark.liveLayout(mode, 1500), mode)
      const after = (await session.send('Performance.getMetrics')).metrics
      const taskMs = (after.find(x => x.name === 'TaskDuration').value - before.find(x => x.name === 'TaskDuration').value) * 1000
      results.push({ ...result, taskMs, trial }); console.log(JSON.stringify(results.at(-1)))
    }
  }
  if (errors.length) throw new Error(`Browser errors: ${errors.join('\n')}`)
  const output = process.env.BENCHMARK_OUTPUT || '/private/tmp/gomod-lens-webgpu-benchmark.json'
  await writeFile(output, JSON.stringify({ environment: { ...environment, os: platform(), release: release(), arch: arch(), viewport: { width: 1280, height: 800 }, scaleFactor: 2 }, results, checks, livePayload }, null, 2) + '\n')
  console.log(`Saved ${output}`)
} finally { await browser?.close(); server.close() }
