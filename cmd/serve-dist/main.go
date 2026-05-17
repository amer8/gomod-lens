package main

import (
	"flag"
	"fmt"
	"log"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

func main() {
	var (
		dir  = flag.String("dir", "dist", "Directory containing the static GitHub Pages artifact")
		port = flag.String("port", "4173", "HTTP port or address to listen on")
	)
	flag.Parse()

	if err := mime.AddExtensionType(".wasm", "application/wasm"); err != nil {
		log.Fatalf("register wasm MIME type: %v", err)
	}

	root, err := filepath.Abs(*dir)
	if err != nil {
		log.Fatalf("resolve static directory: %v", err)
	}
	if err := requireStaticArtifact(root); err != nil {
		log.Fatal(err)
	}

	address := normalizeAddress(*port)
	log.Printf("serving %s at %s", root, displayAddress(address))
	if err := http.ListenAndServe(address, noCache(http.FileServer(http.Dir(root)))); err != nil {
		log.Fatalf("listen: %v", err)
	}
}

func requireStaticArtifact(root string) error {
	index := filepath.Join(root, "index.html")
	if info, err := os.Stat(index); err != nil {
		return fmt.Errorf("static artifact not found at %s; run make wasm first", index)
	} else if info.IsDir() {
		return fmt.Errorf("static artifact index is a directory: %s", index)
	}
	return nil
}

func noCache(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		next.ServeHTTP(w, r)
	})
}

func normalizeAddress(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ":4173"
	}
	if strings.Contains(raw, ":") {
		return raw
	}
	return ":" + raw
}

func displayAddress(address string) string {
	if strings.HasPrefix(address, ":") {
		return "http://localhost" + address
	}
	if strings.HasPrefix(address, "http://") || strings.HasPrefix(address, "https://") {
		return address
	}
	return "http://" + address
}
