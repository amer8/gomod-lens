import test from 'node:test'
import assert from 'node:assert/strict'
import { publicJSON, clearPublicCache, publicIdentity, mapModules } from '../internal/app/web/static/analysis/public-data.js'
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
test('upstream failures stay unknown without discarding successful modules; concurrency is bounded',async()=>{
  let running=0,max=0,completed=0
  const records=await mapModules(Array.from({length:12},(_,id)=>({id})),async node=>{
    max=Math.max(max,++running); await new Promise(resolve=>setTimeout(resolve,1)); running--
    if(node.id===3)throw new Error('offline');return {status:'observed'}
  },{progress:done=>{completed=done}})
  assert.equal(records.size,12);assert.equal(records.get(3).status,'unknown');assert.equal(records.get(4).status,'observed');assert.equal(completed,12);assert.ok(max<=4)
})

test('server and WebAssembly deployments ship identical analysis assets',async()=>{
 const { readdir,readFile }=await import('node:fs/promises')
 const server=new URL('../internal/app/web/static/analysis/',import.meta.url),staticDir=new URL('../dist/assets/analysis/',import.meta.url)
 const names=await readdir(server);assert.deepEqual(names,await readdir(staticDir))
 for(const name of names)assert.equal(await readFile(new URL(name,server),'utf8'),await readFile(new URL(name,staticDir),'utf8'),name)
})
