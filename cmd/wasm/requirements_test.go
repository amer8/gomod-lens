//go:build js && wasm

package main

import (
	"context"
	"errors"
	"syscall/js"
	"testing"

	"github.com/amer8/gomod-lens/internal/staticresolver"
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
		charged := 0
		request := staticresolver.FetchRequest{MaxBytes: 4, ChargeBytes: func(n int) error {
			charged += n
			return nil
		}}
		got, err := readResponseText(context.Background(), response, request)
		if charged != len(tc.body) {
			t.Fatalf("charged %d bytes for a %d-byte response", charged, len(tc.body))
		}
		if (err != nil) != tc.tooLarge || !tc.tooLarge && got != tc.body {
			t.Fatalf("size %d returned %q, %v", len(tc.body), got, err)
		}
	}
}

func TestCachedManifestChargesTheSameBudgetAsAStream(t *testing.T) {
	cacheMu.Lock()
	oldDB := cacheDB
	cacheDB = js.Global().Get("Function").New(`
		return {transaction: () => ({objectStore: () => ({get() {
			const r = {result: {body: "abcd", expiresAt: Date.now() + 60000}};
			queueMicrotask(() => r.onsuccess());
			return r;
		}})})}`).Invoke()
	cacheMu.Unlock()
	defer func() { cacheMu.Lock(); cacheDB = oldDB; cacheMu.Unlock() }()

	denied := errors.New("budget exhausted")
	for _, tc := range []struct {
		limit int
		deny  bool
	}{{4, false}, {3, false}, {4, true}} {
		charged := 0
		req := staticresolver.FetchRequest{
			URL: "https://proxy.golang.org/example.org/a/@v/v1.0.0.mod", MaxBytes: tc.limit,
			ChargeBytes: func(n int) error {
				charged += n
				if tc.deny {
					return denied
				}
				return nil
			},
		}
		body, err := (browserFetcher{}).FetchText(context.Background(), req)
		wantError := tc.deny || tc.limit < 4
		if charged != 4 || (err != nil) != wantError || tc.deny && !errors.Is(err, denied) || !wantError && body != "abcd" {
			t.Fatalf("cached manifest limit=%d deny=%t: body=%q charged=%d err=%v", tc.limit, tc.deny, body, charged, err)
		}
	}
}
