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
	for _, name := range []string{"PRIVACY.md", "THIRD_PARTY_NOTICES.md", "LICENSE"} {
		if err := copyFile(filepath.Join("..", "..", name), filepath.Join(root, name)); err != nil {
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
	if string(body) != string(index) {
		t.Fatal("static build changed the canonical HTML shell")
	}
	for _, want := range []string{`src="./assets/app.js"`, `src="./assets/wasm_exec.js"`, `href="./assets/main.css"`, `./assets/analysis/analysis.css`, `./assets/assistant/assistant.css`, `id="lens-toolbar" aria-label="Lens selection" hidden`, `id="sidebar-toggle"`, `class="panel-intro">`, `aria-label="Project information"`, `src="./assets/gopher-63.svg"`, `aria-label="Contribute to gomod-lens on GitHub"`} {
		if !strings.Contains(string(body), want) {
			t.Errorf("static page missing %q", want)
		}
	}
	for _, obsolete := range []string{`src="/assets/`, `href="/assets/`, `data-runtime`, `{{`, `http-client.js`} {
		if strings.Contains(string(body), obsolete) {
			t.Errorf("static page contains obsolete markup %q", obsolete)
		}
	}
	for name, want := range map[string]string{
		"privacy.html": "Each upstream service receives",
		"notices.html": `href="assets/licenses/CDLA-Permissive-2.0.txt"`,
		"LICENSE.txt":  "MIT License",
	} {
		body, err := os.ReadFile(filepath.Join(root, "dist", name))
		if err != nil || !strings.Contains(string(body), want) {
			t.Errorf("public document %s missing content %q: %v", name, want, err)
		}
	}
}

func TestGoRuntimeIncludesLicenseFromSameToolchain(t *testing.T) {
	root, toolchain := t.TempDir(), t.TempDir()
	for name, body := range map[string]string{"lib/wasm/wasm_exec.js": "toolchain runtime", "LICENSE": "toolchain copyright, conditions and disclaimer"} {
		path := filepath.Join(toolchain, name)
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	b := builder{root: root}
	if err := b.copyGoRuntime(toolchain); err != nil {
		t.Fatal(err)
	}
	for name, want := range map[string]string{wasmRuntime: "toolchain runtime", "dist/assets/licenses/Go.txt": "toolchain copyright, conditions and disclaimer"} {
		body, err := os.ReadFile(filepath.Join(root, name))
		if err != nil || string(body) != want {
			t.Errorf("%s: got %q, err=%v", name, body, err)
		}
	}
	if err := os.Remove(filepath.Join(toolchain, "LICENSE")); err != nil {
		t.Fatal(err)
	}
	if err := b.copyGoRuntime(toolchain); err == nil {
		t.Fatal("missing toolchain license must fail the build")
	}
}
