package staticresolver

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"time"

	"github.com/amer8/gomod-lens/internal/graph"
)

// GoRequirements is exact-version metadata for the requested graph nodes.
type GoRequirements struct {
	Records    map[string]graph.GoRequirement `json:"records"`
	CapturedAt string                         `json:"capturedAt"`
}

// A single observation can appear under many graph IDs after replacements.
// Charge the encoded map entries before storing them for the WASM response.
func (r GoRequirements) record(ids []string, observation graph.GoRequirement, remaining *int) error {
	value, err := json.Marshal(observation)
	if err != nil {
		return err
	}
	for _, id := range ids {
		key, err := json.Marshal(id)
		if err != nil {
			return err
		}
		size := len(key) + len(value) + 2 // colon and comma
		if size > *remaining {
			return errors.New("Go requirements response exceeds the browser size limit")
		}
		*remaining -= size
		r.Records[id] = observation
	}
	return nil
}

// LookupGoRequirements loads only the supplied versions. Duplicate replacement
// identities share a fetch and parse; failures remain unknown per module.
func (r *Resolver) LookupGoRequirements(ctx context.Context, nodes []graph.Node, progress func(int, int)) (GoRequirements, error) {
	if r == nil || r.fetcher == nil {
		return GoRequirements{}, errors.New("static resolver requires a fetcher")
	}
	scoped := r.forAnalysis()
	result := GoRequirements{Records: make(map[string]graph.GoRequirement)}
	remaining := 32 << 20 // encoded metadata entries per browser response
	groups := make(map[graph.ModuleIdentity][]string)
	identities := make([]graph.ModuleIdentity, 0)
	for _, node := range nodes {
		identity, ok := goRequirementIdentity(node)
		if !ok {
			if err := result.record([]string{node.ID}, graph.GoRequirement{Status: "unknown", Error: "No resolved public module version is available."}, &remaining); err != nil {
				return GoRequirements{}, err
			}
			continue
		}
		if _, found := groups[identity]; !found {
			identities = append(identities, identity)
		}
		groups[identity] = append(groups[identity], node.ID)
	}
	var mu sync.Mutex
	done := len(result.Records)
	if progress != nil {
		progress(done, len(nodes))
	}
	err := mapLimit(ctx, identities, 4, func(_ int, identity graph.ModuleIdentity) error {
		// Each identity is visited once. Keep just the observation after parsing.
		meta, err := scoped.fetchGoMod(ctx, identity.Name, identity.Version)
		var observation graph.GoRequirement
		if err != nil {
			if ctx.Err() != nil || errors.Is(err, context.Canceled) {
				return err
			}
			observation = graph.GoRequirement{Status: "unknown", Identity: identity,
				Source:     proxyModuleURL(identity.Name) + "/@v/" + proxyPathEscape(identity.Version) + ".mod",
				ObservedAt: time.Now().UTC().Format(time.RFC3339Nano), Error: err.Error()}
		} else {
			observation = requirementObservation(meta, identity)
		}
		mu.Lock()
		defer mu.Unlock()
		if err := result.record(groups[identity], observation, &remaining); err != nil {
			return err
		}
		done += len(groups[identity])
		if progress != nil {
			progress(done, len(nodes))
		}
		return nil
	})
	if err != nil {
		return GoRequirements{}, err
	}
	result.CapturedAt = time.Now().UTC().Format(time.RFC3339Nano)
	return result, ctx.Err()
}

func requirementObservation(meta moduleMeta, identity graph.ModuleIdentity) graph.GoRequirement {
	minimum := meta.GoVersion
	if minimum == "" {
		minimum = "1.16"
	}
	if !goMinimumFitsLens(minimum) {
		return graph.GoRequirement{Status: "unknown", Identity: identity, Source: meta.Source, ObservedAt: meta.ObservedAt,
			Error: "Go minimum exceeds the browser version limit."}
	}
	return graph.GoRequirement{Status: "observed", Minimum: minimum, Implicit: meta.GoVersion == "",
		Identity: identity, Source: meta.Source, ObservedAt: meta.ObservedAt}
}

// Graph resolution still uses the declared Go version for module pruning.
// Only the observation sent to the browser lens needs this size limit.
func goMinimumFitsLens(version string) bool {
	const maxComponentDigits = 32
	if len(version) <= maxComponentDigits {
		return true
	}
	if len(version) > 3*maxComponentDigits+len(".beta") {
		return false
	}
	for digits := range strings.FieldsFuncSeq(version, func(r rune) bool { return r < '0' || r > '9' }) {
		if len(digits) > maxComponentDigits {
			return false
		}
	}
	return true
}

func goRequirementIdentity(node graph.Node) (graph.ModuleIdentity, bool) {
	name, version := node.Name, node.Version
	if node.Replaced {
		if node.LocalReplacement || isLocalReplacementTarget(node.Replacement) {
			return graph.ModuleIdentity{}, false
		}
		at := strings.LastIndex(node.Replacement, "@")
		if at < 1 {
			return graph.ModuleIdentity{}, false
		}
		name, version = node.Replacement[:at], node.Replacement[at+1:]
	}
	first, _, _ := strings.Cut(name, "/")
	if !strings.Contains(first, ".") || isLikelyLocalTarget(name) || strings.Contains(name, "://") || parseGoVersion(version) == nil {
		return graph.ModuleIdentity{}, false
	}
	return graph.ModuleIdentity{Name: name, Version: version}, true
}
