package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestPreviewListener(t *testing.T) {
	for input, want := range map[string]string{
		"": "127.0.0.1:4173", " 8080 ": "127.0.0.1:8080",
		":9000": ":9000", "[::1]:9000": "[::1]:9000", "0.0.0.0:8080": "0.0.0.0:8080",
	} {
		server := previewServer(input, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusNoContent)
		}))
		if server.Addr != want || server.ReadHeaderTimeout != 5*time.Second {
			t.Errorf("preview %q: address %q, header timeout %v", input, server.Addr, server.ReadHeaderTimeout)
		}
		response := httptest.NewRecorder()
		server.Handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/", nil))
		if response.Code != http.StatusNoContent || response.Header().Get("Cache-Control") != "no-store" {
			t.Errorf("preview handler returned %d, %v", response.Code, response.Header())
		}
	}
}
