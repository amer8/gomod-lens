.DEFAULT_GOAL := help

GO ?= go
PORT ?= 8080
GOCACHE ?= $(CURDIR)/.gocache
GOMODCACHE ?= $(CURDIR)/.gomodcache

GO_ENV := GOCACHE=$(GOCACHE) GOMODCACHE=$(GOMODCACHE)
GO_PACKAGES := ./...
GO_SOURCE_DIRS := main.go internal cmd

.PHONY: help cache-dirs run test vet vet-wasm fmt fmt-check tidy-check wasm serve check clean

help: ## Show available targets.
	@awk 'BEGIN {FS = ":.*##"; printf "Usage: make <target>\n\nTargets:\n"} /^[a-zA-Z0-9_-]+:.*##/ {printf "  %-12s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

cache-dirs:
	@mkdir -p "$(GOCACHE)" "$(GOMODCACHE)"

run: cache-dirs ## Run the development server on PORT, default 8080.
	$(GO_ENV) $(GO) run . -port $(PORT)

test: cache-dirs ## Run all Go tests with repo-local caches.
	$(GO_ENV) $(GO) test $(GO_PACKAGES)

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

wasm: cache-dirs ## Build the static WebAssembly artifact into dist/assets.
	$(GO_ENV) $(GO) run ./cmd/build-static-wasm -go "$(GO)"

serve: cache-dirs ## Serve the static dist prototype on port 4173.
	$(GO_ENV) $(GO) run ./cmd/serve-dist

check: fmt-check tidy-check wasm vet vet-wasm test ## Run the same checks used by CI.

clean: ## Remove generated local caches and static artifacts.
	rm -rf "$(CURDIR)/.gocache" "$(CURDIR)/.gomodcache" dist/assets/gomod-lens.wasm dist/assets/wasm_exec.js dist/assets/vendor
