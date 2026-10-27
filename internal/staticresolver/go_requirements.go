package staticresolver

import (
	"context"
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

// LookupGoRequirements loads only the supplied versions. Duplicate replacement
// identities share a fetch and parse; failures remain unknown per module.
func (r *Resolver) LookupGoRequirements(ctx context.Context, nodes []graph.Node, progress func(int, int)) (GoRequirements, error) {
	if r == nil || r.fetcher == nil {
		return GoRequirements{}, errors.New("static resolver requires a fetcher")
	}
	result := GoRequirements{Records: make(map[string]graph.GoRequirement)}
	groups := make(map[graph.ModuleIdentity][]string)
	identities := make([]graph.ModuleIdentity, 0)
	for _, node := range nodes {
		identity, ok := goRequirementIdentity(node)
		if !ok {
			result.Records[node.ID] = graph.GoRequirement{Status: "unknown", Error: "No resolved public module version is available."}
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
		meta, err := r.loadGoMod(ctx, identity.Name, identity.Version)
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
		for _, id := range groups[identity] {
			result.Records[id] = observation
			done++
		}
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
	return graph.GoRequirement{Status: "observed", Minimum: minimum, Implicit: meta.GoVersion == "",
		Identity: identity, Source: meta.Source, ObservedAt: meta.ObservedAt}
}

func goRequirementIdentity(node graph.Node) (graph.ModuleIdentity, bool) {
	name, version := node.Name, node.Version
	if node.Replaced {
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
