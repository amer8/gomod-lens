.DEFAULT_GOAL := help

GO ?= go
NODE ?= node
PORT ?= 8080
GOCACHE ?= $(CURDIR)/.gocache
GOMODCACHE ?= $(CURDIR)/.gomodcache

GO_ENV := GOCACHE=$(GOCACHE) GOMODCACHE=$(GOMODCACHE)
GO_PACKAGES := ./...
GO_SOURCE_DIRS := main.go internal cmd

.PHONY: help cache-dirs run test test-js test-wasm vet vet-wasm fmt fmt-check tidy-check wasm serve check clean new-lens

help: ## Show available targets.
	@awk 'BEGIN {FS = ":.*##"; printf "Usage: make <target>\n\nTargets:\n"} /^[a-zA-Z0-9_-]+:.*##/ {printf "  %-12s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

cache-dirs:
	@mkdir -p "$(GOCACHE)" "$(GOMODCACHE)"

run: cache-dirs ## Run the development server on PORT, default 8080.
	$(GO_ENV) $(GO) run . -port $(PORT)

test: cache-dirs ## Run all Go tests with repo-local caches.
	$(GO_ENV) $(GO) test $(GO_PACKAGES)

test-js: ## Run browser logic and registry tests (Node.js 22+).
	$(NODE) --test tests/*.test.mjs

new-lens: ## Scaffold and register a browser lens: make new-lens NAME=module-overview.
	$(NODE) tools/lenses.mjs new "$(NAME)"

test-wasm: cache-dirs ## Run Go WASM lifecycle tests in Node.js.
	GOOS=js GOARCH=wasm $(GO_ENV) $(GO) test -exec="$$($(GO) env GOROOT)/lib/wasm/go_js_wasm_exec" ./cmd/wasm

vet: cache-dirs ## Run go vet.
	$(GO_ENV) $(GO) vet $(GO_PACKAGES)

vet-wasm: cache-dirs ## Run go vet for the WebAssembly entrypoint.
	GOOS=js GOARCH=wasm $(GO_ENV) $(GO) vet ./cmd/wasm

fmt: ## Format Go source files.
	gofmt -w $(GO_SOURCE_DIRS)

fmt-check: ## Check Go formatting without writing files.
	@test -z "$$(gofmt -l $(GO_SOURCE_DIRS))" || (gofmt -l $(GO_SOURCE_DIRS); exit 1)

tidy-check: cache-dirs ## Verify go.mod and go.sum are tidy.
	$(GO_ENV) $(GO) mod tidy
	git diff --exit-code -- go.mod go.sum

wasm: cache-dirs ## Generate the complete static deployment in dist/.
	$(GO_ENV) $(GO) run ./cmd/build-static-wasm -go "$(GO)"

serve: wasm ## Build and serve the static deployment on port 4173.
	$(GO_ENV) $(GO) run ./cmd/serve-dist

check: fmt-check tidy-check wasm vet vet-wasm test test-js test-wasm ## Run the same checks used by CI.

clean: ## Remove generated local caches and static artifacts.
	rm -rf "$(CURDIR)/.gocache" "$(CURDIR)/.gomodcache" dist
