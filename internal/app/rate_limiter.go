package app

import (
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

type fixedWindowRateLimiter struct {
	mu      sync.Mutex
	limit   int
	window  time.Duration
	clients map[string]rateLimitWindow
	now     func() time.Time
}

type rateLimitWindow struct {
	count     int
	startedAt time.Time
}

func newFixedWindowRateLimiter(config RateLimitConfig) *fixedWindowRateLimiter {
	if config.Requests <= 0 {
		return nil
	}
	if config.Window <= 0 {
		config.Window = time.Minute
	}
	return &fixedWindowRateLimiter{
		limit:   config.Requests,
		window:  config.Window,
		clients: make(map[string]rateLimitWindow),
		now:     time.Now,
	}
}

func (l *fixedWindowRateLimiter) allow(key string) (time.Duration, bool) {
	if l == nil || l.limit <= 0 {
		return 0, true
	}
	if key == "" {
		key = "unknown"
	}

	l.mu.Lock()
	defer l.mu.Unlock()

	now := l.now()
	window := l.clients[key]
	if window.startedAt.IsZero() || now.Sub(window.startedAt) >= l.window {
		l.clients[key] = rateLimitWindow{count: 1, startedAt: now}
		l.cleanupLocked(now)
		return 0, true
	}

	if window.count >= l.limit {
		return time.Until(window.startedAt.Add(l.window)).Round(time.Second), false
	}

	window.count++
	l.clients[key] = window
	return 0, true
}

func (l *fixedWindowRateLimiter) cleanupLocked(now time.Time) {
	if len(l.clients) < 1024 {
		return
	}
	for key, window := range l.clients {
		if now.Sub(window.startedAt) >= l.window {
			delete(l.clients, key)
		}
	}
}

func clientKey(r *http.Request, trustProxyHeaders bool) string {
	if trustProxyHeaders {
		for _, header := range []string{"CF-Connecting-IP", "X-Real-IP"} {
			if value := strings.TrimSpace(r.Header.Get(header)); value != "" {
				return value
			}
		}
		if forwarded := strings.TrimSpace(r.Header.Get("X-Forwarded-For")); forwarded != "" {
			if first, _, ok := strings.Cut(forwarded, ","); ok {
				return strings.TrimSpace(first)
			}
			return forwarded
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err == nil && host != "" {
		return host
	}
	return r.RemoteAddr
}
