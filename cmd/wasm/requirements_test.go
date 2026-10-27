//go:build js && wasm

package main

import (
	"context"
	"syscall/js"
	"testing"
)

func TestRequirementsBridgeUsesGoParserAndRefreshBypassesCache(t *testing.T) {
	global := js.Global()
	oldFetch, oldIndexedDB := global.Get("fetch"), global.Get("indexedDB")
	defer global.Set("fetch", oldFetch)
	defer global.Set("indexedDB", oldIndexedDB)
	global.Set("indexedDB", js.Undefined())
	requests := 0
	fetch := js.FuncOf(func(_ js.Value, args []js.Value) any {
		requests++
		if args[1].Get("credentials").String() != "omit" || args[1].Get("cache").String() != "reload" || !args[1].Get("signal").Truthy() {
			t.Errorf("metadata request lost refresh, credentials, or timeout")
		}
		response := global.Get("Response").New("module\texample.org/root\ngo\t1.26.7\n")
		return global.Get("Promise").Call("resolve", response)
	})
	defer fetch.Release()
	global.Set("fetch", fetch)
	options := global.Get("Object").New()
	options.Set("refresh", true)
	value := loadGoRequirements(js.Undefined(), []js.Value{js.ValueOf(`[{"id":"root","name":"example.org/root","version":"v1.0.0"}]`), options})
	result, err := awaitPromise(context.Background(), value.(js.Value))
	if err != nil {
		t.Fatal(err)
	}
	record := result.Get("records").Get("root")
	if requests != 1 || record.Get("status").String() != "observed" || record.Get("minimum").String() != "1.26.7" || record.Get("source").String() == "" {
		t.Fatalf("unexpected observation after %d requests: %v", requests, record)
	}
}
