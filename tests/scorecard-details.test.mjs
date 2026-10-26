import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeReport, loadReport } from '../internal/app/web/static/analysis/scorecard.js'

test('Scorecard preserves unavailable checks, explanations, provenance and future check names', () => {
  const result = normalizeReport({scorecard:{overallScore:7.2,date:'2026-10-01',repository:{name:'github.com/acme/repo',commit:'abc'},scorecard:{version:'v5'},checks:[{name:'SAST',score:-1,reason:'Insufficient evidence'},{name:'Future-Check',score:10,details:['Observed configuration'],documentation:{url:'https://example.com/definition'}}]}},'https://api.deps.dev/project','fixed time')
  assert.equal(result.checks[0].score,null)
  assert.equal(result.checks[0].reason,'Insufficient evidence')
  assert.equal(result.checks[1].group,'Other checks')
  assert.equal(result.repository.commit,'abc')
  assert.equal(result.engine.version,'v5')
  assert.equal(result.fetchedAt,'fixed time')
})
test('an aggregate-only report is not silently expanded into invented successful checks', () => {
  assert.deepEqual(normalizeReport({scorecard:{overallScore:8}},'source').checks,[])
  assert.equal(normalizeReport({},'source').missing,true)
  assert.equal(normalizeReport({scorecard:{overallScore:42}},'source').score,null)
})
test('Scorecard lookup uses the resolved source project, not the selected module tag', async () => {
  let called=''
  const result=await loadReport({name:'golang.org/x/net',version:'v0.1.0',lenses:{openssf:{details:{projectId:'github.com/golang/net'}}}},{fetcher:async url=>{called=url;return {ok:true,json:async()=>({scorecard:{overallScore:9,checks:[]}})}}})
  assert.equal(called,'https://api.deps.dev/v3/projects/github.com%2Fgolang%2Fnet')
  assert.equal(result.score,9)
  assert.equal((await loadReport({name:'unknown',version:'v1'})).missing,true)
})
