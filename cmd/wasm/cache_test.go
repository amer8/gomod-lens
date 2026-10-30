//go:build js && wasm

package main

import (
	"context"
	"errors"
	"fmt"
	"syscall/js"
	"testing"
)

func TestCanceledCacheOpenKeepsUpgradeCallbackUntilSettlement(t *testing.T) {
	for _, fail := range []bool{false, true} {
		t.Run(fmt.Sprint(fail), func(t *testing.T) {
			cacheMu.Lock()
			oldCache := cacheDB
			cacheDB = js.Undefined()
			cacheMu.Unlock()
			defer func() { cacheMu.Lock(); cacheDB = oldCache; cacheMu.Unlock() }()
			global := js.Global()
			oldIndexedDB := global.Get("indexedDB")
			console := global.Get("console")
			oldError := console.Get("error")
			var diagnostics []string
			capture := js.FuncOf(func(_ js.Value, args []js.Value) any {
				diagnostics = append(diagnostics, args[0].String())
				return nil
			})
			console.Set("error", capture)
			defer func() { console.Set("error", oldError); capture.Release() }()

			db, names := global.Get("Object").New(), global.Get("Object").New()
			store := global.Get("Function").New(`return {indexNames:{contains:()=>false},createIndex:()=>{}}`).Invoke()
			transaction := global.Get("Function").New(`const tx={}; tx.objectStore=()=>({count(){const r={result:0};setTimeout(()=>r.onsuccess(),0);return r},index(){return {openCursor(){const r={result:null};setTimeout(()=>{r.onsuccess();setTimeout(()=>tx.oncomplete(),0)},0);return r}}}}); return tx`)
			db.Set("transaction", transaction)
			stores := 0
			contains := js.FuncOf(func(js.Value, []js.Value) any { return stores > 0 })
			defer contains.Release()
			names.Set("contains", contains)
			db.Set("objectStoreNames", names)
			create := js.FuncOf(func(js.Value, []js.Value) any { stores++; return store })
			defer create.Release()
			db.Set("createObjectStore", create)
			var requests []js.Value
			open := js.FuncOf(func(js.Value, []js.Value) any {
				request := global.Get("Object").New()
				request.Set("result", db)
				requests = append(requests, request)
				if len(requests) > 1 {
					// Subsequent opens behave like a normal asynchronous IDB open.
					var deliver js.Func
					deliver = js.FuncOf(func(js.Value, []js.Value) any {
						defer deliver.Release()
						if stores == 0 {
							request.Get("onupgradeneeded").Invoke()
						}
						request.Get("onsuccess").Invoke()
						return nil
					})
					global.Call("queueMicrotask", deliver)
				}
				return request
			})
			defer open.Release()
			indexedDB := global.Get("Object").New()
			indexedDB.Set("open", open)
			global.Set("indexedDB", indexedDB)
			defer global.Set("indexedDB", oldIndexedDB)

			ctx, cancel := context.WithCancel(context.Background())
			go cancel()
			if _, err := openCacheDB(ctx); !errors.Is(err, context.Canceled) {
				t.Fatalf("canceled open did not return: %v", err)
			}
			request := requests[0]
			upgrade, success, failure := request.Get("onupgradeneeded"), request.Get("onsuccess"), request.Get("onerror")
			if fail {
				request.Set("error", global.Get("Error").New("open failed"))
				failure.Invoke()
			} else {
				upgrade.Invoke()
				success.Invoke()
				if stores != 1 {
					t.Errorf("late upgrade did not create the cache store: %d", stores)
				}
			}
			if _, err := awaitPromise(context.Background(), global.Get("Promise").Call("resolve")); err != nil {
				t.Fatal(err)
			}
			if len(diagnostics) != 0 {
				t.Fatalf("callback released before settlement: %v", diagnostics)
			}
			upgrade.Invoke()
			success.Invoke()
			failure.Invoke()
			if len(diagnostics) != 3 {
				t.Fatalf("settled open retained callbacks: %v", diagnostics)
			}
			for _, diagnostic := range diagnostics {
				if diagnostic != "call to released function" {
					t.Fatalf("unexpected callback error: %s", diagnostic)
				}
			}
			diagnostics = nil
			reopened, err := openCacheDB(context.Background())
			if err != nil || !reopened.Equal(db) || stores != 1 || len(diagnostics) != 0 {
				t.Fatalf("cache could not reopen after cancellation: db=%v err=%v stores=%d diagnostics=%v", reopened, err, stores, diagnostics)
			}
		})
	}
}

// This small IndexedDB double preserves asynchronous request and transaction
// callbacks so the WASM tests exercise the cursor and quota-retry paths.
const cacheTestDB = `
const state = {entries: [], quotaFailures: 0, puts: 0};
const db = { transaction() {
  const tx = {};
  tx.objectStore = () => ({
    count() {
      const request = {};
      queueMicrotask(() => { request.result = state.entries.length; request.onsuccess(); });
      return request;
    },
    index() { return { openCursor() {
      const request = {};
      const sorted = [...state.entries].sort((a,b) => a.expiresAt-b.expiresAt);
      let i = 0;
      function next() {
        let advanced = false;
        const entry = sorted[i++];
        request.result = entry ? {key:entry.expiresAt, delete(){state.entries.splice(state.entries.indexOf(entry),1)}, continue(){advanced=true;queueMicrotask(next)}} : null;
        request.onsuccess();
        if (!advanced) queueMicrotask(() => tx.oncomplete());
      }
      queueMicrotask(next);
      return request;
    }}},
    put(entry) {
      const request = {};
      queueMicrotask(() => {
        state.puts++;
        if (state.quotaFailures > 0) { state.quotaFailures--; request.error={name:'QuotaExceededError',message:'quota'}; request.onerror(); return; }
        state.entries = state.entries.filter(e => e.url !== entry.url);
        state.entries.push(entry); request.result=entry.url; request.onsuccess();
      });
      return request;
    }
  });
  return tx;
}};
return {db,state};`

func TestCacheCleanupAndQuotaRetry(t *testing.T) {
	fixture := js.Global().Get("Function").New(cacheTestDB).Invoke()
	db, state := fixture.Get("db"), fixture.Get("state")
	entries := state.Get("entries")
	add := func(url string, expires int64) {
		entry := js.Global().Get("Object").New()
		entry.Set("url", url)
		entry.Set("expiresAt", expires)
		entries.Call("push", entry)
	}
	now := nowMillis()
	for i := 0; i < 150; i++ {
		add(fmt.Sprint("expired", i), now-1)
	}
	add("fresh", now+dayMillis)
	if n := cleanupCacheBatch(db, 0); n != 100 {
		t.Fatalf("first expired batch removed %d", n)
	}
	if n := cleanupCacheBatch(db, 0); n != 50 {
		t.Fatalf("second expired batch removed %d", n)
	}
	if entries.Length() != 1 || entries.Index(0).Get("url").String() != "fresh" {
		t.Fatal("cleanup did not preserve fresh entry")
	}
	for i := 0; i < cacheMaxEntries; i++ {
		add(fmt.Sprint("fresh", i), now+dayMillis+int64(i))
	}
	if n := cleanupCacheBatch(db, 0); n != 1 {
		t.Fatalf("entry limit removed %d, want 1", n)
	}
	if entries.Length() != cacheMaxEntries {
		t.Fatalf("got %d entries", entries.Length())
	}

	cacheMu.Lock()
	oldDB, oldWrites := cacheDB, cacheWrites
	cacheDB, cacheWrites = db, 0
	cacheMu.Unlock()
	defer func() { cacheMu.Lock(); cacheDB, cacheWrites = oldDB, oldWrites; cacheMu.Unlock() }()
	state.Set("quotaFailures", 1)
	storeCachedResponse(context.Background(), "https://proxy.golang.org/example/@v/v1.0.0.mod", "module example")
	if state.Get("puts").Int() != 2 {
		t.Fatalf("quota failure did not retry exactly once: %d", state.Get("puts").Int())
	}
	if state.Get("entries").Length() != cacheMaxEntries-cacheCleanupBatch+1 {
		t.Fatalf("quota recovery did not evict a batch and retain response")
	}
	state.Set("quotaFailures", 2)
	storeCachedResponse(context.Background(), "https://proxy.golang.org/example/@v/v1.0.1.mod", "module example")
	if state.Get("puts").Int() != 4 {
		t.Fatalf("persistent quota failure was not limited to one retry: %d", state.Get("puts").Int())
	}
}

func TestCacheUpgradeIndexesExistingStore(t *testing.T) {
	global := js.Global()
	oldIndexedDB := global.Get("indexedDB")
	cacheMu.Lock()
	oldDB := cacheDB
	cacheDB = js.Undefined()
	cacheMu.Unlock()
	defer func() { global.Set("indexedDB", oldIndexedDB); cacheMu.Lock(); cacheDB = oldDB; cacheMu.Unlock() }()
	fixture := global.Get("Function").New(cacheTestDB).Invoke()
	db := fixture.Get("db")
	state := global.Get("Object").New()
	state.Set("created", 0)
	store := global.Get("Function").New("state", `return {indexNames:{contains:()=>false},createIndex(name,key){if(name===key && name==='expiresAt') state.created++}}`).Invoke(state)
	names := global.Get("Function").New(`return {contains:()=>true}`).Invoke()
	db.Set("objectStoreNames", names)
	open := global.Get("Function").New("db", "store", `return function(name, version){
      if(version!==2) throw Error('wrong version');
      const request={result:db,transaction:{objectStore:()=>store}};
      queueMicrotask(()=>{request.onupgradeneeded();request.onsuccess()});return request;
    }`).Invoke(db, store)
	indexedDB := global.Get("Object").New()
	indexedDB.Set("open", open)
	global.Set("indexedDB", indexedDB)
	if _, err := openCacheDB(context.Background()); err != nil {
		t.Fatal(err)
	}
	if state.Get("created").Int() != 1 {
		t.Fatal("upgrade did not index the existing store")
	}
}
