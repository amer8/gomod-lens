//go:build js && wasm

package main

import (
	"context"
	"errors"
	"fmt"
	"syscall/js"
	"testing"
)

func TestAwaitPromiseResults(t *testing.T) {
	value, err := awaitPromise(context.Background(), js.Global().Get("Promise").Call("resolve", "result"))
	if err != nil || value.String() != "result" {
		t.Fatalf("fulfilled promise: %v, %v", value, err)
	}
	_, err = awaitPromise(context.Background(), js.Global().Get("Promise").Call("reject", js.Global().Get("Error").New("failed")))
	if err == nil || err.Error() != "failed" {
		t.Fatalf("rejected promise: %v", err)
	}
}

func TestCanceledPromiseReleasesBothCallbacksAfterSettlement(t *testing.T) {
	for _, reject := range []bool{false, true} {
		t.Run(fmt.Sprint(reject), func(t *testing.T) {
			var resolve, fail js.Value
			executor := js.FuncOf(func(_ js.Value, args []js.Value) any {
				resolve, fail = args[0], args[1]
				return nil
			})
			promise := js.Global().Get("Promise").New(executor)
			executor.Release()
			var fulfilledCallback, rejectedCallback js.Value
			bridge := js.FuncOf(func(_ js.Value, args []js.Value) any {
				fulfilledCallback, rejectedCallback = args[0], args[1]
				return promise.Call("then", args[0], args[1])
			})
			defer bridge.Release()
			wrapper := js.Global().Get("Object").New()
			wrapper.Set("then", bridge)
			console := js.Global().Get("console")
			originalError := console.Get("error")
			var diagnostics []string
			captureError := js.FuncOf(func(_ js.Value, args []js.Value) any {
				diagnostics = append(diagnostics, args[0].String())
				return nil
			})
			console.Set("error", captureError)
			defer func() { console.Set("error", originalError); captureError.Release() }()

			ctx, cancel := context.WithCancel(context.Background())
			cancel()
			if _, err := awaitPromise(ctx, wrapper); !errors.Is(err, context.Canceled) {
				t.Fatalf("canceled waiter did not return: %v", err)
			}
			if reject {
				fail.Invoke(js.Global().Get("Error").New("late failure"))
			} else {
				resolve.Invoke("late success")
			}
			// A later microtask provides a barrier after natural settlement.
			if _, err := awaitPromise(context.Background(), js.Global().Get("Promise").Call("resolve")); err != nil {
				t.Fatal(err)
			}
			if len(diagnostics) != 0 {
				t.Fatalf("callbacks were released before JavaScript settled: %v", diagnostics)
			}
			// The Go JS runtime reports calls to released functions. Probe the
			// captured handlers to check that neither retained a Go callback.
			fulfilledCallback.Invoke(js.Undefined())
			rejectedCallback.Invoke(js.Global().Get("Error").New("probe"))
			if len(diagnostics) != 2 || diagnostics[0] != "call to released function" || diagnostics[1] != "call to released function" {
				t.Fatalf("settled callbacks were retained: %v", diagnostics)
			}
		})
	}
}
