//go:build !js || !wasm

package graph

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
)

const (
	goProxyBaseURL          = "https://proxy.golang.org"
	maxGoProxyResponseBytes = 4 << 20
)

var errGoProxyNotFound = errors.New("not found")

// GoProxyReleaseFreshnessProvider loads release metadata through proxy.golang.org.
type GoProxyReleaseFreshnessProvider struct {
	client      *http.Client
	concurrency int
	cacheMu     sync.RWMutex
	cache       map[string]string
}

// NewGoProxyReleaseFreshnessProvider creates a Go-proxy-backed freshness provider.
func NewGoProxyReleaseFreshnessProvider(client *http.Client, concurrency int) *GoProxyReleaseFreshnessProvider {
	if client == nil {
		client = &http.Client{Timeout: 12 * time.Second}
	}
	if concurrency < 1 {
		concurrency = 1
	}
	return &GoProxyReleaseFreshnessProvider{
		client:      client,
		concurrency: concurrency,
		cache:       make(map[string]string),
	}
}

// FetchReleaseFreshness returns release freshness results keyed by request ID.
func (p *GoProxyReleaseFreshnessProvider) FetchReleaseFreshness(ctx context.Context, deps []ReleaseFreshnessRequest) map[string]ReleaseFreshnessInfo {
	results := make(map[string]ReleaseFreshnessInfo, len(deps))
	requestsByModule := make(map[string][]ReleaseFreshnessRequest)
	for _, dep := range deps {
		module := strings.TrimSpace(dep.Module)
		if module == "" {
			continue
		}
		requestsByModule[module] = append(requestsByModule[module], dep)
	}

	var wg sync.WaitGroup
	var resultMu sync.Mutex
	sem := make(chan struct{}, p.concurrency)

	for module, requests := range requestsByModule {
		if latest, ok := p.cached(module); ok {
			publishReleaseFreshness(results, &resultMu, requests, latest, nil)
			continue
		}

		wg.Add(1)
		go func(module string, requests []ReleaseFreshnessRequest) {
			defer wg.Done()

			select {
			case sem <- struct{}{}:
				defer func() { <-sem }()
			case <-ctx.Done():
				publishReleaseFreshness(results, &resultMu, requests, "", ctx.Err())
				return
			}

			latest, err := p.fetchLatestReleaseVersion(ctx, module)
			if err == nil && latest != "" {
				p.setCached(module, latest)
			}
			publishReleaseFreshness(results, &resultMu, requests, latest, err)
		}(module, requests)
	}

	wg.Wait()
	return results
}

func (p *GoProxyReleaseFreshnessProvider) cached(module string) (string, bool) {
	p.cacheMu.RLock()
	defer p.cacheMu.RUnlock()
	latest, ok := p.cache[module]
	return latest, ok
}

func (p *GoProxyReleaseFreshnessProvider) setCached(module, latest string) {
	p.cacheMu.Lock()
	defer p.cacheMu.Unlock()
	p.cache[module] = latest
}

func (p *GoProxyReleaseFreshnessProvider) fetchLatestReleaseVersion(ctx context.Context, module string) (string, error) {
	list, err := p.fetchText(ctx, goProxyModuleURL(module)+"/@v/list", "text/plain,*/*")
	if err == nil {
		if latest := LatestStableModuleVersion(list); latest != "" {
			return latest, nil
		}
	} else if !errors.Is(err, errGoProxyNotFound) {
		return "", err
	}

	var latest struct {
		Version string `json:"Version"`
	}
	err = p.fetchJSON(ctx, goProxyModuleURL(module)+"/@latest", "application/json", &latest)
	if err != nil {
		return "", err
	}
	if strings.TrimSpace(latest.Version) == "" {
		return "", fmt.Errorf("Go module proxy did not return a latest version for %s", module)
	}
	return latest.Version, nil
}

func (p *GoProxyReleaseFreshnessProvider) fetchJSON(ctx context.Context, requestURL, accept string, out any) error {
	text, err := p.fetchText(ctx, requestURL, accept)
	if err != nil {
		return err
	}
	if err := json.Unmarshal([]byte(text), out); err != nil {
		return fmt.Errorf("decode %s: %w", requestURL, err)
	}
	return nil
}

func (p *GoProxyReleaseFreshnessProvider) fetchText(ctx context.Context, requestURL, accept string) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, requestURL, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Accept", accept)
	req.Header.Set("User-Agent", depsDevUserAgent())

	resp, err := p.client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, maxGoProxyResponseBytes+1))
	if err != nil {
		return "", err
	}
	if len(body) > maxGoProxyResponseBytes {
		return "", fmt.Errorf("Go module proxy response exceeded %d bytes", maxGoProxyResponseBytes)
	}
	if resp.StatusCode == http.StatusNotFound || resp.StatusCode == http.StatusGone {
		return "", errGoProxyNotFound
	}
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("Go module proxy returned status %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	return string(body), nil
}

func publishReleaseFreshness(results map[string]ReleaseFreshnessInfo, mu *sync.Mutex, requests []ReleaseFreshnessRequest, latest string, err error) {
	mu.Lock()
	defer mu.Unlock()
	for _, dep := range requests {
		switch {
		case err == nil:
			results[dep.ID] = ClassifyReleaseFreshness(dep.Module, dep.Version, latest)
		case errors.Is(err, errGoProxyNotFound):
			results[dep.ID] = ReleaseFreshnessUnavailable(dep.Module, dep.Version)
		default:
			results[dep.ID] = ReleaseFreshnessLookupError(dep.Module, dep.Version, err)
		}
	}
}

func goProxyModuleURL(modulePath string) string {
	parts := strings.Split(modulePath, "/")
	for i, part := range parts {
		parts[i] = goProxyPathEscape(part)
	}
	return goProxyBaseURL + "/" + strings.Join(parts, "/")
}

func goProxyPathEscape(value string) string {
	var escaped strings.Builder
	for _, char := range value {
		if char >= 'A' && char <= 'Z' {
			escaped.WriteByte('!')
			escaped.WriteRune(char + ('a' - 'A'))
		} else {
			escaped.WriteRune(char)
		}
	}
	return escaped.String()
}
