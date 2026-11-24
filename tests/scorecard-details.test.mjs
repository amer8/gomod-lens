import test from 'node:test'
import assert from 'node:assert/strict'
import { Element } from './helpers/element.mjs'
import lens, { normalizeReport, loadReport } from '../internal/app/web/static/analysis/scorecard.js'

test('Scorecard preserves unavailable checks, explanations, provenance and future check names', () => {
  const result = normalizeReport(
    {
      scorecard: {
        overallScore: 7.2,
        date: '2026-10-01',
        repository: { name: 'github.com/acme/repo', commit: 'abc' },
        scorecard: { version: 'v5' },
        checks: [
          { name: 'SAST', score: -1, reason: 'Insufficient evidence' },
          {
            name: 'Future-Check',
            score: 10,
            details: ['Observed configuration'],
            documentation: { url: 'https://example.com/definition' },
          },
        ],
      },
    },
    'https://api.deps.dev/project',
    'fixed time',
  )
  assert.equal(result.checks[0].score, null)
  assert.equal(result.checks[0].reason, 'Insufficient evidence')
  assert.equal(result.checks[1].group, 'Other checks')
  assert.equal(result.repository.commit, 'abc')
  assert.equal(result.engine.version, 'v5')
  assert.equal(result.fetchedAt, 'fixed time')
})
test('an aggregate-only report is not silently expanded into invented successful checks', () => {
  assert.deepEqual(normalizeReport({ scorecard: { overallScore: 8 } }, 'source').checks, [])
  assert.equal(normalizeReport({}, 'source').missing, true)
  assert.equal(normalizeReport({ scorecard: { overallScore: 42 } }, 'source').score, null)
  assert.throws(
    () => normalizeReport({ scorecard: { checks: [null] } }, 'source'),
    /Invalid Scorecard check/,
  )
})
test('Scorecard lookup uses the resolved source project, not the selected module tag', async () => {
  let called = ''
  const result = await loadReport(
    {
      name: 'golang.org/x/net',
      version: 'v0.1.0',
      lenses: { openssf: { details: { projectId: 'github.com/golang/net' } } },
    },
    {
      fetcher: async (url) => {
        called = url
        return { ok: true, json: async () => ({ scorecard: { overallScore: 9, checks: [] } }) }
      },
    },
  )
  assert.equal(called, 'https://api.deps.dev/v3/projects/github.com%2Fgolang%2Fnet')
  assert.equal(result.score, 9)
  assert.equal((await loadReport({ name: 'unknown', version: 'v1' })).missing, true)
})

test('Scorecard distinguishes project lookup outcomes', async () => {
  const node = (status, message) => ({ lenses: { openssf: { status, message } } })
  assert.match((await loadReport(node('no_scorecard'))).message, /no published/i)
  assert.match(
    (await loadReport(node('skipped', 'local replacement'))).message,
    /skipped.*local replacement/i,
  )
  assert.match((await loadReport(node('no_project'))).message, /no source repository mapping/i)
  await assert.rejects(loadReport(node('error', 'HTTP 429')), /HTTP 429/)
})

test('a missing mapped project shows an absent report and transient errors remain retryable', async () => {
  const node = { lenses: { openssf: { details: { projectId: 'github.com/acme/missing' } } } }
  const fetcher = (status) => async () => ({ ok: false, status })
  assert.equal((await loadReport(node, { fetcher: fetcher(404) })).missing, true)
  await assert.rejects(loadReport(node, { fetcher: fetcher(503) }), /503/)
})

test('replacement report displays the resolved module and version in the snapshot caveat', (t) => {
  const old = globalThis.document
  globalThis.document = { createElement: (tag) => new Element(tag) }
  t.after(() => (old ? (globalThis.document = old) : delete globalThis.document))
  const host = new Element()
  lens.render({
    host,
    node: {
      name: 'example.org/original',
      version: 'v1.0.0',
      replaced: true,
      replacement: 'example.org/fork@v1.2.0',
      lenses: { openssf: { details: { module: 'example.org/fork', version: 'v1.2.0' } } },
    },
    data: normalizeReport({ scorecard: { overallScore: 8 } }, 'https://example.org/report'),
  })
  const notices = host.querySelectorAll('p').map((p) => p.textContent)
  assert.ok(notices.includes('Resolved replacement: example.org/fork@v1.2.0'))
  assert.ok(notices.some((text) => text.includes('snapshot') && text.includes('v1.2.0')))
})
