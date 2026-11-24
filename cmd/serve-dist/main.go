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
	"time"
)

func main() {
	var (
		dir       = flag.String("dir", "dist", "Directory containing the static GitHub Pages artifact")
		port      = flag.String("port", "4173", "HTTP port or address to listen on")
		devChecks = flag.Bool("dev-checks", false, "Serve the developer model checks from the source tree")
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

	mux := http.NewServeMux()
	mux.Handle("/", http.FileServer(http.Dir(root)))
	if *devChecks {
		source := os.DirFS("internal/app/web/static/assistant")
		for _, name := range []string{"dev-checks.html", "dev-checks.js"} {
			mux.HandleFunc("GET /assets/assistant/"+name, func(w http.ResponseWriter, r *http.Request) {
				http.ServeFileFS(w, r, source, name)
			})
		}
	}
	server := previewServer(*port, mux)
	log.Printf("serving %s at %s", root, displayAddress(server.Addr))
	if err := server.ListenAndServe(); err != nil {
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

func previewServer(address string, handler http.Handler) *http.Server {
	address = strings.TrimSpace(address)
	if address == "" {
		address = "4173"
	}
	if !strings.Contains(address, ":") {
		address = "127.0.0.1:" + address
	}
	return &http.Server{
		Addr:              address,
		Handler:           noCache(handler),
		ReadHeaderTimeout: 5 * time.Second,
	}
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
