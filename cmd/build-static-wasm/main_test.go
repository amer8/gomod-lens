package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSyncAssetsBuildsFromCanonicalSourcesAndRemovesObsoleteOutputs(t *testing.T) {
	root := t.TempDir()
	index, err := os.ReadFile(filepath.Join("..", "..", indexSource))
	if err != nil {
		t.Fatal(err)
	}
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
	if err := os.WriteFile(filepath.Join(root, indexSource), index, 0644); err != nil {
		t.Fatal(err)
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
	if string(body) != string(index) {
		t.Fatal("static build changed the canonical HTML shell")
	}
	for _, want := range []string{`src="./assets/app.js"`, `src="./assets/wasm_exec.js"`, `href="./assets/main.css"`, `./assets/analysis/analysis.css`, `./assets/assistant/assistant.css`, `./assets/vendor/ngraph.graph.js`, `id="lens-toolbar" aria-label="Lens selection" hidden`, `id="sidebar-toggle"`, `class="panel-intro">`, `aria-label="Project information"`, `src="./assets/gopher-63.svg"`, `aria-label="Contribute to gomod-lens on GitHub"`} {
		if !strings.Contains(string(body), want) {
			t.Errorf("static page missing %q", want)
		}
	}
	for _, obsolete := range []string{`src="/assets/`, `href="/assets/`, `data-runtime`, `{{`, `http-client.js`} {
		if strings.Contains(string(body), obsolete) {
			t.Errorf("static page contains obsolete markup %q", obsolete)
		}
	}
}
