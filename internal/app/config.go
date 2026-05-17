package app

import (
	"os"
	"strconv"
	"time"
)

const defaultUpstreamUserAgent = "gomod-lens (+https://github.com/amer8/gomod-lens)"

// ServerConfig configures HTTP handling, upstream requests, caching, and limits.
type ServerConfig struct {
	RequestTimeout        time.Duration
	SearchTimeout         time.Duration
	AnalysisConcurrency   int
	GraphCacheTTL         time.Duration
	SearchCacheTTL        time.Duration
	UpstreamUserAgent     string
	TrustProxyHeaders     bool
	GraphRateLimit        RateLimitConfig
	SearchRateLimit       RateLimitConfig
	GlobalGraphRateLimit  RateLimitConfig
	GlobalSearchRateLimit RateLimitConfig
}

// RateLimitConfig defines a fixed-window request limit.
type RateLimitConfig struct {
	Requests int
	Window   time.Duration
}

// DefaultServerConfig returns server settings sourced from environment variables.
func DefaultServerConfig() ServerConfig {
	return ServerConfig{
		RequestTimeout:      envDuration("GOMOD_LENS_REQUEST_TIMEOUT", 45*time.Second),
		SearchTimeout:       envDuration("GOMOD_LENS_SEARCH_TIMEOUT", 10*time.Second),
		AnalysisConcurrency: envInt("GOMOD_LENS_ANALYSIS_CONCURRENCY", 1),
		GraphCacheTTL:       envDuration("GOMOD_LENS_GRAPH_CACHE_TTL", 24*time.Hour),
		SearchCacheTTL:      envDuration("GOMOD_LENS_SEARCH_CACHE_TTL", time.Hour),
		UpstreamUserAgent:   envString("GOMOD_LENS_USER_AGENT", defaultUpstreamUserAgent),
		TrustProxyHeaders:   envBool("GOMOD_LENS_TRUST_PROXY_HEADERS", false),
		GraphRateLimit: RateLimitConfig{
			Requests: envInt("GOMOD_LENS_GRAPH_RATE_LIMIT", 5),
			Window:   envDuration("GOMOD_LENS_GRAPH_RATE_WINDOW", time.Minute),
		},
		SearchRateLimit: RateLimitConfig{
			Requests: envInt("GOMOD_LENS_SEARCH_RATE_LIMIT", 5),
			Window:   envDuration("GOMOD_LENS_SEARCH_RATE_WINDOW", time.Minute),
		},
		GlobalGraphRateLimit: RateLimitConfig{
			Requests: envInt("GOMOD_LENS_GLOBAL_GRAPH_RATE_LIMIT", 20),
			Window:   envDuration("GOMOD_LENS_GLOBAL_GRAPH_RATE_WINDOW", time.Minute),
		},
		GlobalSearchRateLimit: RateLimitConfig{
			Requests: envInt("GOMOD_LENS_GLOBAL_SEARCH_RATE_LIMIT", 8),
			Window:   envDuration("GOMOD_LENS_GLOBAL_SEARCH_RATE_WINDOW", time.Minute),
		},
	}
}

func normalizeServerConfig(config ServerConfig) ServerConfig {
	if config.RequestTimeout <= 0 {
		config.RequestTimeout = 45 * time.Second
	}
	if config.SearchTimeout <= 0 {
		config.SearchTimeout = 10 * time.Second
	}
	if config.AnalysisConcurrency <= 0 {
		config.AnalysisConcurrency = 1
	}
	if config.GraphCacheTTL < 0 {
		config.GraphCacheTTL = 0
	}
	if config.SearchCacheTTL < 0 {
		config.SearchCacheTTL = 0
	}
	if config.UpstreamUserAgent == "" {
		config.UpstreamUserAgent = defaultUpstreamUserAgent
	}
	if config.GraphRateLimit.Window <= 0 {
		config.GraphRateLimit.Window = time.Minute
	}
	if config.SearchRateLimit.Window <= 0 {
		config.SearchRateLimit.Window = time.Minute
	}
	if config.GlobalGraphRateLimit.Window <= 0 {
		config.GlobalGraphRateLimit.Window = time.Minute
	}
	if config.GlobalSearchRateLimit.Window <= 0 {
		config.GlobalSearchRateLimit.Window = time.Minute
	}
	return config
}

func envString(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

func envInt(key string, fallback int) int {
	raw := os.Getenv(key)
	if raw == "" {
		return fallback
	}
	value, err := strconv.Atoi(raw)
	if err != nil {
		return fallback
	}
	return value
}

func envBool(key string, fallback bool) bool {
	raw := os.Getenv(key)
	if raw == "" {
		return fallback
	}
	value, err := strconv.ParseBool(raw)
	if err != nil {
		return fallback
	}
	return value
}

func envDuration(key string, fallback time.Duration) time.Duration {
	raw := os.Getenv(key)
	if raw == "" {
		return fallback
	}
	value, err := time.ParseDuration(raw)
	if err != nil {
		return fallback
	}
	return value
}
