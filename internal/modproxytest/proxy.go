// Package modproxytest builds an offline module proxy for Go-toolchain parity tests.
package modproxytest

import (
	"archive/zip"
	"bytes"
	"fmt"
	"io/fs"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Env isolates every fixture's module cache as well as its proxy. Tests may use
// the same module IDs with different requirements without reusing cached files.
func Env(t testing.TB, modules map[string]string) []string {
	t.Helper()
	cache := t.TempDir()
	t.Cleanup(func() {
		_ = filepath.WalkDir(cache, func(path string, entry fs.DirEntry, err error) error {
			if err == nil && entry.IsDir() {
				return os.Chmod(path, 0o755)
			}
			return err
		})
	})
	return []string{"GOPROXY=" + New(t, modules), "GOSUMDB=off", "GONOPROXY=", "GOPRIVATE=", "GOWORK=off", "GOTOOLCHAIN=local", "GOMODCACHE=" + cache}
}

// New serves the supplied module@version go.mod files through a file proxy.
// Each module also contains a trivial Go package so go get exercises downloads.
func New(t testing.TB, modules map[string]string) string {
	t.Helper()
	dir := t.TempDir()
	for id, mod := range modules {
		at := strings.LastIndex(id, "@")
		if at < 0 {
			t.Fatalf("fixture module lacks version: %s", id)
		}
		path, version := id[:at], id[at+1:]
		base := filepath.Join(dir, filepath.FromSlash(path), "@v")
		if err := os.MkdirAll(base, 0o755); err != nil {
			t.Fatal(err)
		}
		var archive bytes.Buffer
		writer := zip.NewWriter(&archive)
		for name, contents := range map[string]string{"go.mod": mod, "fixture.go": "package fixture\n"} {
			entry, err := writer.Create(id + "/" + name)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := entry.Write([]byte(contents)); err != nil {
				t.Fatal(err)
			}
		}
		if err := writer.Close(); err != nil {
			t.Fatal(err)
		}
		for name, contents := range map[string][]byte{
			version + ".mod":  []byte(mod),
			version + ".info": []byte(fmt.Sprintf(`{"Version":%q,"Time":"2026-01-01T00:00:00Z"}`, version)),
			version + ".zip":  archive.Bytes(),
		} {
			if err := os.WriteFile(filepath.Join(base, name), contents, 0o644); err != nil {
				t.Fatal(err)
			}
		}
	}
	return (&url.URL{Scheme: "file", Path: filepath.ToSlash(dir)}).String()
}
