import { access, mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const sourceDirectory = 'internal/app/web/static/analysis'
async function requireMissing(path) {
  try {
    await access(path)
  } catch (error) {
    if (error.code === 'ENOENT') return
    throw error
  }
  throw new Error(`Refusing to overwrite ${path}`)
}

export async function createLens(root, id) {
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(id || '')) {
    throw new Error('Choose a lowercase lens ID, for example: make new-lens NAME=module-overview')
  }
  const registryPath = resolve(root, sourceDirectory, 'registry.js')
  const registry = await readFile(registryPath, 'utf8')
  if (new RegExp(`\\b(?:id|key):\\s*['"]${id}['"]`).test(registry)) {
    throw new Error(`A lens with ID or key "${id}" is already registered`)
  }
  const end = registry.lastIndexOf('\n]')
  if (end < 0 || registry.slice(end).trim() !== ']') {
    throw new Error('Cannot find the end of browserLenses in registry.js; no files were changed')
  }
  const sourcePath = resolve(root, sourceDirectory, id + '.js')
  const testPath = resolve(root, 'tests', id + '.test.mjs')
  await Promise.all([sourcePath, testPath].map(requireMissing))
  const title = id.split('-').map(word => word[0].toUpperCase() + word.slice(1)).join(' ')
  const registration = `  {
    id: '${id}', key: '${id}', title: '${title}',
    label: '${title}', description: 'Module and relationship counts in the loaded graph.', icon: '≡',
    importModule: () => import('./${id}.js'),
  },
`
  const source = `// Start here: docs/development/lenses.md#add-a-lens
import { metrics, notice } from './ui.js'

// Data logic can be imported and tested without a browser. Keep the graph unchanged.
export function summarizeGraph(graph) {
  return { moduleCount: graph.nodes.length, relationshipCount: graph.edges.length }
}

/** @type {import('./types.js').BrowserLens<{moduleCount: number, relationshipCount: number}>} */
const lens = {
  scope: 'Modules and relationships in the loaded graph',
  async load(graph, { signal }) {
    signal.throwIfAborted()
    return summarizeGraph(graph)
  },
  render({ host, data }) {
    if ('error' in data) {
      host.append(notice(data.error, 'analysis-empty'))
      return
    }
    host.append(metrics([[data.moduleCount, 'Modules'], [data.relationshipCount, 'Relationships']]))
    host.append(notice('Source: the loaded dependency graph.', 'analysis-provenance'))
  },
}

export default lens
`
  const test = `import test from 'node:test'
import assert from 'node:assert/strict'
import lens from '../${sourceDirectory}/${id}.js'

test('${id} reads the graph without modifying shared data', async () => {
  const graph = Object.freeze({
    nodes: Object.freeze([Object.freeze({ id: 'root' }), Object.freeze({ id: 'dependency' })]),
    edges: Object.freeze([Object.freeze({ source: 'root', target: 'dependency' })]),
  })
  const data = await lens.load(graph, { signal: new AbortController().signal })
  assert.deepEqual(data, { moduleCount: 2, relationshipCount: 1 })
})

test('${id} stops when its graph request is canceled', async () => {
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(lens.load({}, { signal: controller.signal }), { name: 'AbortError' })
})
`
  const created = []
  try {
    await mkdir(resolve(root, 'tests'), { recursive: true })
    for (const [path, body] of [[sourcePath, source], [testPath, test]]) {
      await writeFile(path, body, { flag: 'wx' })
      created.push(path)
    }
    await writeFile(registryPath, registry.slice(0, end + 1) + registration + registry.slice(end + 1))
  } catch (error) {
    await Promise.all(created.map(path => unlink(path)))
    throw error
  }
  return { sourcePath, testPath }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = fileURLToPath(new URL('../', import.meta.url))
  const [command, id, ...extra] = process.argv.slice(2)
  try {
    if (command !== 'new' || extra.length) throw new Error('Usage: node tools/lenses.mjs new <lens-id>')
    const { sourcePath, testPath } = await createLens(root, id)
    console.log(`Created ${sourcePath}\nCreated ${testPath}\nRegistered the lens.`)
    console.log(`Next: make test-js\nOpen: ?lens=${id}#target=github.com%2Fspf13%2Fcobra`)
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
