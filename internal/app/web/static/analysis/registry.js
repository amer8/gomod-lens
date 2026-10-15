// Browser lens registration is shared by the toolbar, module loader and URLs.
// Go graph enrichment is registered separately in graph.NewAnalyzer.
export const defaultLensID = 'openssf'

/** @type {import('./types.js').BrowserLensRegistration[]} */
export const browserLenses = [
  {
    id: 'openssf', key: 'scorecard', title: 'Scorecard details',
    label: 'OpenSSF Scorecard', icon: '◒',
    importModule: () => import('./scorecard.js'),
  },
  {
    id: 'release-freshness', key: 'freshness', title: 'Release Freshness',
    label: 'Release Freshness', icon: '◔',
    importModule: () => import('./freshness.js'),
  },
  {
    id: 'vulnerabilities', key: 'vulnerabilities', title: 'Vulnerability exposure',
    label: 'Vulnerability exposure', icon: '!',
    importModule: () => import('./vulnerabilities.js'),
  },
  {
    id: 'licenses', key: 'licenses', title: 'License evidence',
    label: 'License evidence', icon: '§',
    importModule: () => import('./licenses.js'),
  },
]
