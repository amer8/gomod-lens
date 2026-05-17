package main

import (
	"flag"
	"log"
	"net/http"
	"os"
	"strings"

	"github.com/amer8/gomod-lens/internal/app"
	"github.com/amer8/gomod-lens/internal/graph"
)

func main() {
	port := flag.String("port", envOrDefault("PORT", "8080"), "HTTP port or address to listen on")
	flag.Parse()

	address := normalizeAddress(*port)
	server, err := app.NewServer(graph.NewAnalyzer(graph.CommandRunner{}))
	if err != nil {
		log.Fatalf("create server: %v", err)
	}

	log.Printf("gomod-lens listening on %s", displayAddress(address))
	if err := http.ListenAndServe(address, server.Routes()); err != nil {
		log.Fatalf("listen: %v", err)
	}
}

func envOrDefault(key, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}

func normalizeAddress(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ":8080"
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
