import test from 'node:test'
import assert from 'node:assert/strict'
import { publicJSON, publicText, clearPublicCache, publicIdentity, mapModules } from '../internal/app/web/static/analysis/public-data.js'
test('successful public responses are cloned and Refresh invalidates the cache', async () => {
  clearPublicCache(); let calls=0
  const fetcher=async()=>({ok:true,json:async()=>({value:++calls})})
  const first=await publicJSON('https://example.test/cache',{fetcher}); first.value=99
  assert.equal((await publicJSON('https://example.test/cache',{fetcher})).value,1)
  clearPublicCache()
  assert.equal((await publicJSON('https://example.test/cache',{fetcher})).value,2)
  const controller=new AbortController(); controller.abort()
  await assert.rejects(publicJSON('https://example.test/cache',{fetcher,signal:controller.signal}),{name:'AbortError'})
})
test('replacement lookups use resolved identities; local replacements stay unknown',()=>{
  assert.deepEqual(publicIdentity({name:'original.org/lib',version:'v1',replaced:true,replacement:'github.com/acme/fork@v2'}),{name:'github.com/acme/fork',version:'v2'})
  assert.equal(publicIdentity({name:'original.org/lib',version:'v1',replaced:true,replacement:'../lib'}),null)
  assert.equal(publicIdentity({name:'original.org/lib'}),null)
})
test('text requests share bounded fetching but never confuse JSON cache entries', async () => {
  clearPublicCache()
  const url = 'https://example.test/metadata'
  let calls = 0
  const fetcher = async (url, options) => {
    calls++
    assert.equal(options.credentials, 'omit')
    assert(options.signal)
    return { ok: true, text: async () => 'module example.org/a\ngo 1.26', json: async () => ({ format: 'json' }) }
  }
  assert.match(await publicText(url, { fetcher }), /go 1.26/)
  assert.deepEqual(await publicJSON(url, { fetcher }), { format: 'json' })
  assert.match(await publicText(url, { fetcher }), /go 1.26/)
  assert.equal(calls, 2)
  clearPublicCache()
  await publicText(url, { fetcher })
  assert.equal(calls, 3)
  await assert.rejects(publicText(url, { signal: AbortSignal.abort(), fetcher }), { name: 'AbortError' })
  await assert.rejects(publicText(url + '/failed', { fetcher: async () => ({ ok: false, status: 503 }) }), /503/)
})
test('upstream failures stay unknown without discarding successful modules; concurrency is bounded',async()=>{
  let running=0,max=0,completed=0
  const records=await mapModules(Array.from({length:12},(_,id)=>({id})),async node=>{
    max=Math.max(max,++running); await new Promise(resolve=>setTimeout(resolve,1)); running--
    if(node.id===3)throw new Error('offline');return {status:'observed'}
  },{progress:done=>{completed=done}})
  assert.equal(records.size,12);assert.equal(records.get(3).status,'unknown');assert.equal(records.get(4).status,'observed');assert.equal(completed,12);assert.ok(max<=4)
})
