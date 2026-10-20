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
			stores := 0
			contains := js.FuncOf(func(js.Value, []js.Value) any { return stores > 0 })
			defer contains.Release()
			names.Set("contains", contains)
			db.Set("objectStoreNames", names)
			create := js.FuncOf(func(js.Value, []js.Value) any { stores++; return nil })
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
