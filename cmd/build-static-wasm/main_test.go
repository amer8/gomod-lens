package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSyncAssetsBuildsFromCanonicalSourcesAndRemovesObsoleteOutputs(t *testing.T) {
	root := t.TempDir()
	files := map[string]string{"app.js": "shared bootstrap", "app-controller.js": "shared UI", "assistant/queries.js": "analysis adapter", "analysis/registry.js": "lenses", "vendor/runtime.js": "vendored runtime"}
	for name, body := range files {
		path := filepath.Join(root, assetsSource, name)
		if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(body), 0644); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.MkdirAll(filepath.Join(root, assetsTarget), 0755); err != nil {
		t.Fatal(err)
	}
	stale := filepath.Join(root, assetsTarget, "app-static.js")
	if err := os.WriteFile(stale, []byte("obsolete entrypoint"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := (builder{root: root}).syncAssets(); err != nil {
		t.Fatal(err)
	}
	for name, want := range files {
		body, err := os.ReadFile(filepath.Join(root, assetsTarget, name))
		if err != nil || string(body) != want {
			t.Errorf("%s: body=%q, err=%v", name, body, err)
		}
	}
	if _, err := os.Stat(stale); !os.IsNotExist(err) {
		t.Fatalf("obsolete output remains: %v", err)
	}
	body, err := os.ReadFile(filepath.Join(root, "dist", "index.html"))
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{`data-runtime="wasm"`, `src="./assets/app.js"`, `src="./assets/wasm_exec.js"`, `href="./assets/main.css"`, `./assets/vendor/ngraph.graph.js`} {
		if !strings.Contains(string(body), want) {
			t.Errorf("static page missing %q", want)
		}
	}
	if strings.Contains(string(body), `src="/assets/`) {
		t.Fatal("static page contains a root-relative script URL")
	}
}
