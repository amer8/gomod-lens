//go:build js && wasm

package main

import (
	"context"
	"strings"
	"sync"
	"syscall/js"
)

const (
	cacheDBName          = "gomod-lens-cache"
	cacheDBVersion       = 1
	cacheStoreName       = "responses"
	hourMillis     int64 = 60 * 60 * 1000
	dayMillis      int64 = 24 * hourMillis
)

var (
	cacheMu sync.Mutex
	cacheDB js.Value
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

	store := db.Call("transaction", cacheStoreName, "readwrite").Call("objectStore", cacheStoreName)
	_, _ = awaitIDBRequest(ctx, store.Call("put", entry))
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
		if !db.Get("objectStoreNames").Call("contains", cacheStoreName).Bool() {
			options := js.Global().Get("Object").New()
			options.Set("keyPath", "url")
			db.Call("createObjectStore", cacheStoreName, options)
		}
		return nil
	})
	request.Set("onupgradeneeded", onUpgrade)

	db, err := awaitIDBRequest(ctx, request)
	onUpgrade.Release()
	if err != nil {
		return js.Undefined(), err
	}

	cacheMu.Lock()
	cacheDB = db
	cacheMu.Unlock()
	return db, nil
}

func awaitIDBRequest(ctx context.Context, request js.Value) (js.Value, error) {
	executor := js.FuncOf(func(_ js.Value, args []js.Value) any {
		resolve := args[0]
		reject := args[1]
		var success js.Func
		var failure js.Func

		release := func() {
			success.Release()
			failure.Release()
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
