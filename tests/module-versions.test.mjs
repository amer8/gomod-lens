import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { compareVersions, fetchModuleVersions, selectedModuleTarget } from '../internal/app/web/static/module-versions.js'

test('Go versions sort numerically, including prereleases and large version numbers', () => {
  const versions = ['v1.9.0', 'v1.10.0-rc.2', 'v1.10.0', 'v1.10.0-rc.10', 'v1.10.0-alpha', 'v1.10.0-alpha.1']
  assert.deepEqual(versions.sort((a, b) => compareVersions(b, a)), ['v1.10.0', 'v1.10.0-rc.10', 'v1.10.0-rc.2', 'v1.10.0-alpha.1', 'v1.10.0-alpha', 'v1.9.0'])
  assert(compareVersions('v9007199254740993.0.0', 'v9007199254740992.0.0') > 0)
  assert.equal(compareVersions('v2.0.0+incompatible', 'v2.0.0'), 0)
})

test('Analyze preserves a selected version only for the same unversioned module', () => {
  const path = 'github.com/google/uuid'
  assert.equal(selectedModuleTarget(path, path, 'v1.5.0'), path + '@v1.5.0')
  assert.equal(selectedModuleTarget(path + '@latest', path, 'v1.5.0'), path + '@latest')
  assert.equal(selectedModuleTarget('github.com/go-chi/chi/v5', path, 'v1.5.0'), 'github.com/go-chi/chi/v5')
  assert.equal(selectedModuleTarget('', path, 'v1.5.0'), '')
})

test('proxy lookup escapes uppercase module paths and retains loaded pseudo-versions', async () => {
  const loaded = 'v1.0.1-20260101000000-abcdefabcdef'
  const data = await fetchModuleVersions('github.com/Azure/pkg', loaded, { fetcher: async (url, options) => {
    assert.match(url, /github.com\/!azure\/pkg\//)
    assert.equal(options.credentials, 'omit')
    return { ok: true, json: async () => ({ Version: 'v1.10.0' }), text: async () => 'v1.9.0\nv1.10.0\nv1.9.0\ninvalid\n' }
  } })
  assert.equal(data.latest, 'v1.10.0')
  assert.deepEqual(data.versions, ['v1.10.0', 'v1.9.0', loaded])
  assert.equal(data.partial, false)
})

test('partial upstream failures leave loaded and known versions selectable', async () => {
  const data = await fetchModuleVersions('github.com/google/uuid', 'v1.5.0', { fetcher: async url =>
    url.endsWith('/@v/list') ? { ok: true, text: async () => 'v1.4.0\nv1.5.0' } : { ok: false, status: 503 }
  })
  assert.deepEqual(data.versions, ['v1.5.0', 'v1.4.0'])
  assert.equal(data.latest, '')
  assert.equal(data.partial, true)
  const malformed = await fetchModuleVersions('github.com/google/uuid', 'v1.5.0', { fetcher: async () => ({ ok: true, text: async () => '', json: async () => ({ Version: '<invalid>' }) }) })
  assert.deepEqual(malformed.versions, ['v1.5.0'])
  assert.equal(malformed.latest, '')
})

test('an aborted lookup cannot return metadata for a superseded module', async () => {
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(fetchModuleVersions('github.com/google/uuid', 'v1.5.0', { signal: controller.signal, fetcher: async () => { throw new DOMException('Aborted', 'AbortError') } }), { name: 'AbortError' })
})

test('server and static deployments ship the same version picker', async () => {
  const server = await readFile(new URL('../internal/app/web/static/module-versions.js', import.meta.url), 'utf8')
  const wasm = await readFile(new URL('../dist/assets/module-versions.js', import.meta.url), 'utf8')
  assert.equal(server, wasm)
})
