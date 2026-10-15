import test from 'node:test'
import assert from 'node:assert/strict'
import { licenseObservation, lookupLicenses } from '../internal/app/web/static/analysis/licenses.js'
import { clearPublicCache } from '../internal/app/web/static/analysis/public-data.js'
const identity={name:'example.org/lib',version:'v1.2.3'}
test('license expressions retain source wording without inventing AND/OR or compatibility',()=>{
 const result=licenseObservation({versionKey:identity,licenses:['MIT OR Apache-2.0','BSD-3-Clause','MIT OR Apache-2.0','']},identity,'source','time')
 assert.deepEqual(result.expressions,['MIT OR Apache-2.0','BSD-3-Clause']);assert.equal(result.status,'observed');assert.equal(result.observedAt,'time')
 assert.equal(licenseObservation({licenses:['non-standard']},identity,'source').status,'nonstandard')
 assert.equal(licenseObservation({},identity,'source').status,'unknown')
 assert.throws(()=>licenseObservation({versionKey:{...identity,version:'v9'}},identity,'source'),/different module/)
})
test('lookup uses replacement version; a failed request remains unknown',async()=>{
 clearPublicCache();const urls=[]
 const graph={nodes:[{id:'a',...identity,replaced:true,replacement:'github.com/acme/fork@v2.0.0'},{id:'b',name:'example.org/offline',version:'v1'}]}
 const result=await lookupLicenses(graph,{fetcher:async url=>{urls.push(url);return url.includes('offline')?{ok:false,status:503}:{ok:true,json:async()=>({licenses:['MIT']})}}})
 assert.ok(urls.some(url=>url.includes('github.com%2Facme%2Ffork/versions/v2.0.0')))
 assert.equal(result.records.get('a').status,'observed');assert.equal(result.records.get('b').status,'unknown')
})
