import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { createLens, syncLenses } from '../tools/lenses.mjs'

const run = promisify(execFile)
const source = 'internal/app/web/static/analysis'
const mirror = 'dist/assets/analysis'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'gomod-lens-contributor-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await cp(new URL('../' + source, import.meta.url), join(root, source), { recursive: true })
  await writeFile(join(root, 'package.json'), '{"type":"module"}\n')
  await syncLenses(root)
  return root
}

test('scaffolding produces a discoverable lens and runnable tests in both deployments', async t => {
  const root = await fixture(t)
  const { testPath } = await createLens(root, 'module-overview')
  const registry = await import(pathToFileURL(join(root, source, 'registry.js')))
  const registration = registry.browserLenses.find(lens => lens.id === 'module-overview')
  assert.equal(registration.key, 'module-overview')
  const { default: lens } = await registration.importModule()
  assert.equal(typeof lens.render, 'function')
  assert.deepEqual(await lens.load({ nodes: [], edges: [] }, { signal: new AbortController().signal }), { moduleCount: 0, relationshipCount: 0 })
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  const { stdout } = await run(process.execPath, ['--test', '--test-reporter=tap', testPath], { env })
  assert.match(stdout, /# pass 2/)
  const names = await readdir(join(root, source))
  assert.deepEqual(names, await readdir(join(root, mirror)))
  for (const name of names) assert.equal(await readFile(join(root, source, name), 'utf8'), await readFile(join(root, mirror, name), 'utf8'), name)
})

test('scaffolding rejects IDs, state keys and existing files without changing the registry', async t => {
  const root = await fixture(t)
  const registryPath = join(root, source, 'registry.js')
  const before = await readFile(registryPath, 'utf8')
  for (const id of ['../outside', 'New Lens', 'openssf', 'scorecard', 'ui']) {
    await assert.rejects(createLens(root, id))
    assert.equal(await readFile(registryPath, 'utf8'), before)
  }
  await createLens(root, 'my-lens')
  const registered = await readFile(registryPath, 'utf8')
  const files = await readdir(join(root, source))
  await assert.rejects(createLens(root, 'my-lens'))
  assert.equal(await readFile(registryPath, 'utf8'), registered)
  assert.deepEqual(await readdir(join(root, source)), files)
})

test('an existing contribution test is never overwritten or partially scaffolded', async t => {
  const root = await fixture(t)
  const { mkdir } = await import('node:fs/promises')
  await mkdir(join(root, 'tests'))
  await writeFile(join(root, 'tests/existing.test.mjs'), 'existing contribution\n')
  const before = await readFile(join(root, source, 'registry.js'), 'utf8')
  await assert.rejects(createLens(root, 'existing'), /Refusing to overwrite/)
  assert.equal(await readFile(join(root, 'tests/existing.test.mjs'), 'utf8'), 'existing contribution\n')
  assert.equal(await readFile(join(root, source, 'registry.js'), 'utf8'), before)
  assert.equal((await readdir(join(root, source))).includes('existing.js'), false)
})

test('sync updates edited lens assets while leaving the static app entrypoint alone', async t => {
  const root = await fixture(t)
  await writeFile(join(root, 'dist/assets/app-static.js'), 'static entrypoint\n')
  await writeFile(join(root, source, 'analysis.css'), '/* edited styles */\n')
  await syncLenses(root)
  assert.equal(await readFile(join(root, mirror, 'analysis.css'), 'utf8'), '/* edited styles */\n')
  assert.equal(await readFile(join(root, 'dist/assets/app-static.js'), 'utf8'), 'static entrypoint\n')
})
