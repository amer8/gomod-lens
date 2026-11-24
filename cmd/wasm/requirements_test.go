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

func TestGraphAndSearchBridgeLimitRequestsWithoutCallerSignal(t *testing.T) {
	global := js.Global()
	oldFetch, oldIDB := global.Get("fetch"), global.Get("indexedDB")
	defer global.Set("fetch", oldFetch)
	defer global.Set("indexedDB", oldIDB)
	global.Set("indexedDB", js.Undefined())
	calls := 0
	fetch := js.FuncOf(func(_ js.Value, args []js.Value) any {
		calls++
		if !args[1].Get("signal").Truthy() {
			t.Errorf("missing timeout signal for %s", args[0].String())
		}
		return global.Get("Promise").Call("reject", global.Get("DOMException").New("Request timed out", "TimeoutError"))
	})
	defer fetch.Release()
	global.Set("fetch", fetch)
	for _, tc := range []struct {
		entry func(js.Value, []js.Value) any
		input string
	}{{resolveGraph, "example.org/module@v1.0.0"}, {searchModules, "module"}} {
		promise := tc.entry(js.Undefined(), []js.Value{js.ValueOf(tc.input)}).(js.Value)
		_, err := awaitPromise(context.Background(), promise)
		if err == nil || err.Error() != "Request timed out" {
			t.Fatalf("timeout not propagated: %v", err)
		}
	}
	if calls != 2 {
		t.Fatalf("expected one request from each bridge, got %d", calls)
	}
}

func TestBoundedResponseRead(t *testing.T) {
	for _, tc := range []struct {
		body     string
		tooLarge bool
	}{{"1234", false}, {"12345", true}} {
		response := js.Global().Get("Response").New(tc.body)
		got, err := readResponseText(context.Background(), response, 4)
		if (err != nil) != tc.tooLarge || !tc.tooLarge && got != tc.body {
			t.Fatalf("size %d returned %q, %v", len(tc.body), got, err)
		}
	}
}
