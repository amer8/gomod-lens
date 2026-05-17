//go:build js && wasm

package main

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"syscall/js"

	"github.com/amer8/gomod-lens/internal/graph"
	"github.com/amer8/gomod-lens/internal/graphview"
	"github.com/amer8/gomod-lens/internal/staticresolver"
)

func main() {
	js.Global().Set("gomodLensResolveGraph", js.FuncOf(resolveGraph))
	js.Global().Set("gomodLensSearchModules", js.FuncOf(searchModules))
	js.Global().Set("gomodLensWASMReady", true)
	select {}
}

func resolveGraph(_ js.Value, args []js.Value) any {
	target := stringArg(args, 0)
	options := objectArg(args, 1)

	return newPromise(func(resolve, reject js.Value) {
		ctx, cleanup := contextFromOptions(options)
		defer cleanup()

		fetcher := browserFetcher{signal: signalFromOptions(options)}
		resolver := staticresolver.New(fetcher)
		graph, err := resolver.ResolveGraph(ctx, target, staticresolver.Options{
			Progress: progressCallback(options),
		})
		if err != nil {
			reject.Invoke(jsError(err))
			return
		}
		resolve.Invoke(toJS(newGraphResponse(*graph)))
	})
}

type graphResponse struct {
	RootID      string            `json:"rootId"`
	Nodes       []graph.Node      `json:"nodes"`
	Edges       []graph.Edge      `json:"edges"`
	Meta        graph.GraphMeta   `json:"meta"`
	PackageInfo graph.PackageInfo `json:"packageInfo"`
	ViewModel   graphview.Model   `json:"viewModel"`
}

func newGraphResponse(g graph.Graph) graphResponse {
	return graphResponse{
		RootID:      g.RootID,
		Nodes:       g.Nodes,
		Edges:       g.Edges,
		Meta:        g.Meta,
		PackageInfo: g.PackageInfo,
		ViewModel:   graphview.New(g),
	}
}

func searchModules(_ js.Value, args []js.Value) any {
	query := stringArg(args, 0)
	limit := intArg(args, 1, 6)
	options := objectArg(args, 2)

	return newPromise(func(resolve, reject js.Value) {
		ctx, cleanup := contextFromOptions(options)
		defer cleanup()

		fetcher := browserFetcher{signal: signalFromOptions(options)}
		resolver := staticresolver.New(fetcher)
		results, err := resolver.SearchModules(ctx, query, limit)
		if err != nil {
			reject.Invoke(jsError(err))
			return
		}
		resolve.Invoke(toJS(results))
	})
}

func newPromise(work func(resolve, reject js.Value)) js.Value {
	executor := js.FuncOf(func(_ js.Value, args []js.Value) any {
		resolve := args[0]
		reject := args[1]
		go work(resolve, reject)
		return nil
	})
	promise := js.Global().Get("Promise").New(executor)
	executor.Release()
	return promise
}

func contextFromOptions(options js.Value) (context.Context, func()) {
	ctx, cancel := context.WithCancel(context.Background())
	signal := signalFromOptions(options)
	if !signal.Truthy() {
		return ctx, cancel
	}
	if signal.Get("aborted").Truthy() {
		cancel()
	}

	onAbort := js.FuncOf(func(js.Value, []js.Value) any {
		cancel()
		return nil
	})
	signal.Call("addEventListener", "abort", onAbort)
	return ctx, func() {
		signal.Call("removeEventListener", "abort", onAbort)
		onAbort.Release()
		cancel()
	}
}

func progressCallback(options js.Value) func(staticresolver.Progress) {
	if !options.Truthy() {
		return nil
	}
	callback := options.Get("onProgress")
	if callback.Type() != js.TypeFunction {
		return nil
	}
	return func(progress staticresolver.Progress) {
		payload := js.Global().Get("Object").New()
		payload.Set("value", progress.Value)
		payload.Set("label", progress.Label)
		callback.Invoke(payload)
	}
}

type browserFetcher struct {
	signal js.Value
}

func (f browserFetcher) FetchText(ctx context.Context, request staticresolver.FetchRequest) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	if body, ok := cachedResponse(ctx, request.URL); ok {
		return body, nil
	}

	init := js.Global().Get("Object").New()
	headers := js.Global().Get("Object").New()
	if strings.TrimSpace(request.Accept) != "" {
		headers.Set("Accept", request.Accept)
	}
	init.Set("headers", headers)
	if f.signal.Truthy() {
		init.Set("signal", f.signal)
	}

	response, err := awaitPromise(ctx, js.Global().Call("fetch", request.URL, init))
	if err != nil {
		return "", err
	}
	if !response.Get("ok").Bool() {
		return "", &staticresolver.HTTPError{
			Status:     response.Get("status").Int(),
			StatusText: response.Get("statusText").String(),
			URL:        request.URL,
		}
	}

	text, err := awaitPromise(ctx, response.Call("text"))
	if err != nil {
		return "", err
	}
	body := text.String()
	storeCachedResponse(ctx, request.URL, body)
	return body, nil
}

type promiseResult struct {
	value js.Value
	err   error
}

func awaitPromise(ctx context.Context, promise js.Value) (js.Value, error) {
	ch := make(chan promiseResult, 1)
	thenFunc := js.FuncOf(func(_ js.Value, args []js.Value) any {
		select {
		case ch <- promiseResult{value: args[0]}:
		default:
		}
		return nil
	})
	catchFunc := js.FuncOf(func(_ js.Value, args []js.Value) any {
		select {
		case ch <- promiseResult{err: errorFromJS(args[0])}:
		default:
		}
		return nil
	})
	promise.Call("then", thenFunc).Call("catch", catchFunc)

	select {
	case result := <-ch:
		thenFunc.Release()
		catchFunc.Release()
		return result.value, result.err
	case <-ctx.Done():
		return js.Undefined(), ctx.Err()
	}
}

func errorFromJS(value js.Value) error {
	if value.Truthy() {
		if name := value.Get("name"); name.Truthy() && name.String() == "AbortError" {
			return context.Canceled
		}
		if message := value.Get("message"); message.Truthy() {
			return errors.New(message.String())
		}
		return errors.New(value.String())
	}
	return errors.New("JavaScript promise rejected")
}

func jsError(err error) js.Value {
	if errors.Is(err, context.Canceled) {
		return js.Global().Get("DOMException").New("Aborted", "AbortError")
	}
	return js.Global().Get("Error").New(err.Error())
}

func toJS(value any) js.Value {
	raw, err := json.Marshal(value)
	if err != nil {
		return js.Global().Get("Object").New()
	}
	return js.Global().Get("JSON").Call("parse", string(raw))
}

func stringArg(args []js.Value, index int) string {
	if index < 0 || index >= len(args) {
		return ""
	}
	return args[index].String()
}

func intArg(args []js.Value, index int, fallback int) int {
	if index < 0 || index >= len(args) {
		return fallback
	}
	if args[index].Type() != js.TypeNumber {
		return fallback
	}
	return args[index].Int()
}

func objectArg(args []js.Value, index int) js.Value {
	if index < 0 || index >= len(args) {
		return js.Undefined()
	}
	value := args[index]
	if value.Type() != js.TypeObject {
		return js.Undefined()
	}
	return value
}

func signalFromOptions(options js.Value) js.Value {
	if !options.Truthy() {
		return js.Undefined()
	}
	signal := options.Get("signal")
	if !signal.Truthy() {
		return js.Undefined()
	}
	return signal
}
