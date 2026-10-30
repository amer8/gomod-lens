//go:build js && wasm

package main

import (
	"context"
	"strings"
	"sync"
	"syscall/js"
)

const (
	cacheDBName             = "gomod-lens-cache"
	cacheDBVersion          = 2
	cacheStoreName          = "responses"
	cacheExpiryIndex        = "expiresAt"
	cacheMaxEntries         = 2000
	cacheCleanupBatch       = 100
	cacheCleanupEvery       = 64
	hourMillis        int64 = 60 * 60 * 1000
	dayMillis         int64 = 24 * hourMillis
)

var (
	cacheMu             sync.Mutex
	cacheDB             js.Value
	cacheMaintenanceMu  sync.Mutex
	cacheWrites         int
	cacheCleanupRunning bool
	cacheCleanupPending bool
)

func cachedResponse(ctx context.Context, requestURL string) (string, bool) {
	if cacheTTL(requestURL) <= 0 {
		return "", false
	}

	db, err := openCacheDB(ctx)
	if err != nil {
		return "", false
	}
	store := db.Call("transaction", cacheStoreName, "readonly").Call("objectStore", cacheStoreName)
	result, err := awaitIDBRequest(ctx, store.Call("get", requestURL))
	if err != nil || !result.Truthy() || result.Type() != js.TypeObject {
		return "", false
	}

	expiresAt := int64(result.Get("expiresAt").Float())
	if expiresAt <= nowMillis() {
		deleteCachedResponse(ctx, requestURL)
		return "", false
	}

	body := result.Get("body")
	if body.Type() != js.TypeString {
		return "", false
	}
	return body.String(), true
}

func storeCachedResponse(ctx context.Context, requestURL, body string) {
	ttl := cacheTTL(requestURL)
	if ttl <= 0 {
		return
	}

	db, err := openCacheDB(ctx)
	if err != nil {
		return
	}
	entry := js.Global().Get("Object").New()
	entry.Set("url", requestURL)
	entry.Set("body", body)
	entry.Set("expiresAt", nowMillis()+ttl)

	put := func() bool {
		store := db.Call("transaction", cacheStoreName, "readwrite").Call("objectStore", cacheStoreName)
		request := store.Call("put", entry)
		_, err := awaitIDBRequest(ctx, request)
		if err == nil {
			return true
		}
		if ctx.Err() == nil && request.Get("error").Truthy() && request.Get("error").Get("name").String() == "QuotaExceededError" {
			// Evict some entries even if they are not expired, then retry once.
			cacheMaintenanceMu.Lock()
			_ = cleanupCacheBatch(db, cacheCleanupBatch)
			cacheMaintenanceMu.Unlock()
			store = db.Call("transaction", cacheStoreName, "readwrite").Call("objectStore", cacheStoreName)
			_, err = awaitIDBRequest(ctx, store.Call("put", entry))
			return err == nil
		}
		return false
	}
	if put() {
		cacheMu.Lock()
		cacheWrites++
		due := cacheWrites >= cacheCleanupEvery
		if due {
			cacheWrites = 0
		}
		cacheMu.Unlock()
		if due {
			scheduleCacheCleanup(db)
		}
	}
}

func deleteCachedResponse(ctx context.Context, requestURL string) {
	db, err := openCacheDB(ctx)
	if err != nil {
		return
	}
	store := db.Call("transaction", cacheStoreName, "readwrite").Call("objectStore", cacheStoreName)
	_, _ = awaitIDBRequest(ctx, store.Call("delete", requestURL))
}

func openCacheDB(ctx context.Context) (js.Value, error) {
	cacheMu.Lock()
	if cacheDB.Truthy() {
		db := cacheDB
		cacheMu.Unlock()
		return db, nil
	}
	cacheMu.Unlock()

	indexedDB := js.Global().Get("indexedDB")
	if !indexedDB.Truthy() {
		return js.Undefined(), context.Canceled
	}

	request := indexedDB.Call("open", cacheDBName, cacheDBVersion)
	onUpgrade := js.FuncOf(func(_ js.Value, _ []js.Value) any {
		db := request.Get("result")
		var store js.Value
		if !db.Get("objectStoreNames").Call("contains", cacheStoreName).Bool() {
			options := js.Global().Get("Object").New()
			options.Set("keyPath", "url")
			store = db.Call("createObjectStore", cacheStoreName, options)
		} else {
			store = request.Get("transaction").Call("objectStore", cacheStoreName)
		}
		if !store.Get("indexNames").Call("contains", cacheExpiryIndex).Bool() {
			store.Call("createIndex", cacheExpiryIndex, "expiresAt")
		}
		return nil
	})
	request.Set("onupgradeneeded", onUpgrade)

	db, err := awaitIDBRequest(ctx, request, func() {
		request.Set("onupgradeneeded", js.Null())
		onUpgrade.Release()
	})
	if err != nil {
		return js.Undefined(), err
	}

	cacheMu.Lock()
	cacheDB = db
	cacheMu.Unlock()
	scheduleCacheCleanup(db)
	return db, nil
}

// Cleanup transactions are serialized, and each deletes at most one batch.
// Recount between batches so concurrent writes cannot cause over-eviction.
func scheduleCacheCleanup(db js.Value) {
	cacheMu.Lock()
	cacheCleanupPending = true
	if cacheCleanupRunning {
		cacheMu.Unlock()
		return
	}
	cacheCleanupRunning = true
	cacheMu.Unlock()
	go func() {
		for {
			cacheMu.Lock()
			cacheCleanupPending = false
			cacheMu.Unlock()
			cacheMaintenanceMu.Lock()
			for cleanupCacheBatch(db, 0) == cacheCleanupBatch {
			}
			cacheMaintenanceMu.Unlock()
			cacheMu.Lock()
			if !cacheCleanupPending {
				cacheCleanupRunning = false
				cacheMu.Unlock()
				return
			}
			cacheMu.Unlock()
		}
	}()
}

// All cursor operations occur in IndexedDB callbacks while the transaction is
// active. minDelete is used only to make room after a quota failure.
func cleanupCacheBatch(db js.Value, minDelete int) (removed int) {
	// IndexedDB may be unavailable or closed; maintenance is always best-effort.
	defer func() {
		if recover() != nil {
			removed = 0
		}
	}()
	result := make(chan int, 1)
	tx := db.Call("transaction", cacheStoreName, "readwrite")
	store := tx.Call("objectStore", cacheStoreName)
	count := store.Call("count")
	var onCount, onCursor, onComplete, onAbort js.Func
	hasCursor := false
	deleted, excess := 0, minDelete
	onCount = js.FuncOf(func(_ js.Value, _ []js.Value) any {
		if n := count.Get("result").Int() - cacheMaxEntries; n > excess {
			excess = n
		}
		cursor := store.Call("index", cacheExpiryIndex).Call("openCursor")
		onCursor = js.FuncOf(func(_ js.Value, _ []js.Value) any {
			item := cursor.Get("result")
			if item.Truthy() && deleted < cacheCleanupBatch && (deleted < excess || item.Get("key").Float() <= float64(nowMillis())) {
				item.Call("delete")
				deleted++
				item.Call("continue")
			}
			return nil
		})
		hasCursor = true
		cursor.Set("onsuccess", onCursor)
		return nil
	})
	onComplete = js.FuncOf(func(_ js.Value, _ []js.Value) any { result <- deleted; return nil })
	onAbort = js.FuncOf(func(_ js.Value, _ []js.Value) any { result <- 0; return nil })
	count.Set("onsuccess", onCount)
	tx.Set("oncomplete", onComplete)
	tx.Set("onabort", onAbort)
	n := <-result
	onCount.Release()
	if hasCursor {
		onCursor.Release()
	}
	onComplete.Release()
	onAbort.Release()
	return n
}

func awaitIDBRequest(ctx context.Context, request js.Value, onSettled ...func()) (js.Value, error) {
	executor := js.FuncOf(func(_ js.Value, args []js.Value) any {
		resolve := args[0]
		reject := args[1]
		var success js.Func
		var failure js.Func

		release := func() {
			request.Set("onsuccess", js.Null())
			request.Set("onerror", js.Null())
			success.Release()
			failure.Release()
			// A canceled waiter can return before the IDB request completes.
			// Keep all event handlers alive until its eventual success or error.
			for _, cleanup := range onSettled {
				cleanup()
			}
		}
		success = js.FuncOf(func(_ js.Value, _ []js.Value) any {
			resolve.Invoke(request.Get("result"))
			release()
			return nil
		})
		failure = js.FuncOf(func(_ js.Value, _ []js.Value) any {
			reject.Invoke(request.Get("error"))
			release()
			return nil
		})
		request.Set("onsuccess", success)
		request.Set("onerror", failure)
		return nil
	})
	promise := js.Global().Get("Promise").New(executor)
	executor.Release()
	return awaitPromise(ctx, promise)
}

func cacheTTL(requestURL string) int64 {
	switch {
	case strings.HasPrefix(requestURL, "https://proxy.golang.org/"):
		if strings.Contains(requestURL, "/@latest") || strings.HasSuffix(requestURL, "/@v/list") {
			return hourMillis
		}
		return 30 * dayMillis
	case strings.HasPrefix(requestURL, "https://api.deps.dev/"):
		return dayMillis
	case strings.HasPrefix(requestURL, "https://api.github.com/search/repositories"):
		return hourMillis
	default:
		return 0
	}
}

func nowMillis() int64 {
	return int64(js.Global().Get("Date").Call("now").Float())
}
