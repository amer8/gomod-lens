// Browser lens registration is shared by the toolbar, module loader and URLs.
// Go graph enrichment is registered separately in graph.NewAnalyzer.
// Contributor entry point: docs/development/lenses.md. Use make new-lens NAME=...
// to scaffold a view; edit canonical files here, then run make wasm.
export const defaultLensID = 'openssf'

/** @type {import('./types.js').BrowserLensRegistration[]} */
export const browserLenses = [
  {
    id: 'openssf', key: 'scorecard', title: 'Scorecard details',
    label: 'OpenSSF Scorecard', description: 'Repository security practices and published check results.', icon: '◒',
    importModule: () => import('./scorecard.js'),
  },
  {
    id: 'release-freshness', key: 'freshness', title: 'Release Freshness',
    label: 'Release Freshness', description: 'Loaded module versions compared with the latest observed releases.', icon: '◔',
    importModule: () => import('./freshness.js'),
  },
  {
    id: 'vulnerabilities', key: 'vulnerabilities', title: 'Vulnerability exposure',
    label: 'Vulnerability exposure', description: 'Known advisory matches for resolved module versions; not function reachability.', icon: '!',
    importModule: () => import('./vulnerabilities.js'),
  },
  {
    id: 'licenses', key: 'licenses', title: 'License evidence',
    label: 'License evidence', description: 'Recorded license expressions for exact module versions; not compatibility approval.', icon: '§',
    importModule: () => import('./licenses.js'),
  },
  {
    id: 'go-requirements', key: 'go-requirements', title: 'Go requirements',
    label: 'Go requirements', description: 'Declared minimum Go versions compared with a chosen target toolchain; not module maintenance or security scores.', icon: 'Go',
    importModule: () => import('./go-requirements.js'),
  },
]
