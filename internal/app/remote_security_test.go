package app

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/amer8/gomod-lens/internal/graph"
	"github.com/amer8/gomod-lens/internal/modproxytest"
)

func TestPublicGraphEndpointRejectsRemoteFilesystemReplacements(t *testing.T) {
	privateDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(privateDir, "go.mod"), []byte("module private.example/customer\nrequire private.example/secret v1.0.0\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	fixtureEnv := modproxytest.Env(t, map[string]string{
		"example.org/root@v1.0.0": fmt.Sprintf("module example.org/root\n\ngo 1.26\nrequire example.org/dep v1.0.0\nreplace example.org/dep => %s\n", privateDir),
		"example.org/dep@v1.0.0":  "module example.org/dep\n\ngo 1.26\n",
	})
	analyzer := graph.NewAnalyzer(fakeRunner(func(ctx context.Context, dir string, env []string, name string, args ...string) ([]byte, error) {
		return (graph.CommandRunner{}).Run(ctx, dir, append(append([]string(nil), env...), fixtureEnv...), name, args...)
	}))
	analyzer.SetLenses()
	server, err := NewServer(analyzer)
	if err != nil {
		t.Fatal(err)
	}
	response := httptest.NewRecorder()
	server.Routes().ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/graph?target=example.org/root@v1.0.0", nil))
	if response.Code != http.StatusBadRequest || !strings.Contains(response.Body.String(), "filesystem replacements") {
		t.Fatalf("expected a safe 400 response: %d %s", response.Code, response.Body.String())
	}
	if strings.Contains(response.Body.String(), "private.example") || strings.Contains(response.Body.String(), privateDir) {
		t.Fatalf("public API disclosed local module information: %s", response.Body.String())
	}
}
