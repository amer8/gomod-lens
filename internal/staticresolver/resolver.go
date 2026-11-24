package staticresolver

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	goversion "go/version"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"golang.org/x/mod/module"

	"github.com/amer8/gomod-lens/internal/graph"
	"github.com/amer8/gomod-lens/internal/modulesearch"
)

const (
	moduleMode            = "module"
	proxyBaseURL          = "https://proxy.golang.org"
	depsDevBaseURL        = "https://api.deps.dev/v3"
	githubSearchURL       = "https://api.github.com/search/repositories"
	maxSelectedModules    = 1500
	maxModuleVersions     = 3000
	maxGraphEdges         = 16000
	maxRequirementVisits  = 100000
	maxGoModBytes         = 1 << 20
	maxGraphGoModBytes    = 32 << 20
	moduleLoadConcurrency = 8
	scoreLoadConcurrency  = 5
)

// Resolver builds module dependency graphs using browser-provided fetches.
type Resolver struct {
	fetcher Fetcher

	mu                  sync.Mutex
	modFileCache        map[string]moduleMeta
	versionInfoCache    map[string]string
	releaseVersionCache map[string]releaseVersions
	depsDevVersionCache map[string]depsDevVersion
	depsDevProjectCache map[string]depsDevProject
}

type requestedTarget struct {
	Target  string
	Path    string
	Version string
}

type moduleRef struct {
	Path    string
	Version string
	ID      string
}

type buildResolution struct {
	selected map[string]string
	loaded   map[string]moduleMeta
}

type modulePruning int

const (
	pruningPruned modulePruning = iota
	pruningUnpruned
)

type loadCandidate struct {
	moduleRef
	pruning modulePruning
}

// New creates a Resolver that retrieves upstream data through fetcher.
func New(fetcher Fetcher) *Resolver {
	return &Resolver{
		fetcher:             fetcher,
		modFileCache:        make(map[string]moduleMeta),
		versionInfoCache:    make(map[string]string),
		releaseVersionCache: make(map[string]releaseVersions),
		depsDevVersionCache: make(map[string]depsDevVersion),
		depsDevProjectCache: make(map[string]depsDevProject),
	}
}

// ResolveGraph resolves target as a public module and returns its dependency graph.
func (r *Resolver) ResolveGraph(ctx context.Context, target string, options Options) (*graph.Graph, error) {
	if r == nil || r.fetcher == nil {
		return nil, errors.New("static resolver requires a fetcher")
	}
	// Scope the parsed metadata and aggregate budget to this analysis, even when
	// a caller reuses a Resolver or runs more than one analysis concurrently.
	scoped := New(&graphFetcher{Fetcher: r.fetcher, remaining: maxGraphGoModBytes})
	return scoped.resolveGraph(ctx, target, options)
}

type graphFetcher struct {
	Fetcher
	mu        sync.Mutex
	remaining int
}

func (f *graphFetcher) FetchText(ctx context.Context, request FetchRequest) (string, error) {
	if !strings.HasSuffix(request.URL, ".mod") {
		return f.Fetcher.FetchText(ctx, request)
	}
	f.mu.Lock()
	request.MaxBytes = min(maxGoModBytes, f.remaining)
	f.mu.Unlock()
	if request.MaxBytes == 0 {
		return "", errors.New("module metadata exceeds the browser size limit")
	}
	body, err := f.Fetcher.FetchText(ctx, request)
	if err != nil {
		return "", err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(body) > maxGoModBytes || len(body) > f.remaining {
		return "", errors.New("module metadata exceeds the browser size limit")
	}
	f.remaining -= len(body)
	return body, nil
}

func (r *Resolver) resolveGraph(ctx context.Context, target string, options Options) (*graph.Graph, error) {
	progress := newProgressReporter(options.Progress)

	progress.Report(4, "Resolving module")
	requested, err := r.resolveRequestedTarget(ctx, target)
	if err != nil {
		return nil, err
	}
	rootVersion, err := r.resolveTargetVersion(ctx, requested.Path, requested.Version)
	if err != nil {
		return nil, err
	}
	root := moduleRef{Path: requested.Path, Version: rootVersion, ID: moduleID(requested.Path, rootVersion)}

	progress.Report(12, "Loading root module")
	rootMeta, err := r.loadGoMod(ctx, root.Path, root.Version)
	if err != nil {
		return nil, err
	}
	declared := rootMeta.ModulePath
	if declared != root.Path && module.CheckPath(declared) == nil && r.sameModuleOrigin(ctx, root.Path, declared, rootVersion) {
		canonical, err := r.loadGoMod(ctx, declared, rootVersion)
		if err == nil && canonical.ModulePath == declared {
			rootMeta = canonical
			root = moduleRef{Path: declared, Version: rootVersion, ID: moduleID(declared, rootVersion)}
			requested.Target = moduleID(declared, rootVersion)
		}
	}
	rootReplacements := rootMeta.Replacements
	rootExclusions := exclusionIndex(rootMeta.Excludes)
	rootDirectPaths := make(map[string]bool)
	for _, requirement := range rootMeta.Requires {
		if !requirement.Indirect && !isRequirementExcluded(requirement, rootExclusions) {
			rootDirectPaths[requirement.Path] = true
		}
	}

	progress.Report(18, "Resolving dependencies")
	resolution, err := r.resolveBuildList(ctx, root, rootReplacements, rootExclusions, progress)
	if err != nil {
		return nil, err
	}

	progress.Report(78, "Building graph")
	result, err := r.buildGraph(ctx, root, requested.Target, resolution, rootDirectPaths, rootReplacements, rootExclusions)
	if err != nil {
		return nil, err
	}

	progress.Report(82, "Applying OpenSSF lens")
	if err := r.applyOpenSSFOverlay(ctx, result, progress); err != nil {
		return nil, err
	}

	progress.Report(98, "Applying Release Freshness lens")
	if err := r.applyReleaseFreshnessLens(ctx, result, progress); err != nil {
		return nil, err
	}

	progress.Report(100, "Done")
	return result, nil
}

// SearchModules searches public Go modules for a short query or module path.
func (r *Resolver) SearchModules(ctx context.Context, query string, limit int) ([]ModuleSearchResult, error) {
	if r == nil || r.fetcher == nil {
		return nil, errors.New("static resolver requires a fetcher")
	}
	query = NormalizeModuleSearchQuery(query)
	if query == "" {
		return nil, nil
	}
	var payload modulesearch.GitHubResponse
	if err := r.fetchJSON(ctx, githubSearchURL+"?"+modulesearch.GitHubQuery(query).Encode(), "application/vnd.github+json", &payload); err != nil {
		return nil, err
	}

	return payload.Results(query, limit), nil
}

func (r *Resolver) resolveRequestedTarget(ctx context.Context, target string) (requestedTarget, error) {
	target = NormalizeModuleTarget(target)
	if target == "" {
		return requestedTarget{}, errors.New("target is required")
	}
	if isLikelyLocalTarget(target) || strings.ContainsAny(target, ":\\?#%") {
		return requestedTarget{}, errors.New("enter a public Go module path")
	}

	base, version := splitTargetVersion(target)
	if strings.Contains(base, "@") {
		return requestedTarget{}, errors.New("enter a public Go module path")
	}
	if !shouldSearchModuleTarget(base) {
		if module.CheckPath(base) != nil {
			return requestedTarget{}, errors.New("enter a public Go module path")
		}
		return requestedTarget{Target: target, Path: base, Version: version}, nil
	}

	results, err := r.SearchModules(ctx, base, 1)
	if err != nil {
		return requestedTarget{}, err
	}
	if len(results) == 0 {
		return requestedTarget{}, fmt.Errorf("no Go module found for %s", base)
	}

	path := results[0].Path
	resolvedTarget := path
	if version != "" {
		resolvedTarget += "@" + version
	}
	return requestedTarget{Target: resolvedTarget, Path: path, Version: version}, nil
}

func (r *Resolver) resolveTargetVersion(ctx context.Context, path, version string) (string, error) {
	version = strings.TrimSpace(version)
	if version == "" || version == "latest" {
		return r.resolveLatestVersion(ctx, path)
	}
	return r.resolveVersionInfo(ctx, path, version)
}

func (r *Resolver) resolveLatestVersion(ctx context.Context, path string) (string, error) {
	release, err := r.latestRelease(ctx, path)
	if err != nil {
		return "", err
	}
	if release.latest == "" {
		return "", fmt.Errorf("no unretracted release available for %s", path)
	}
	return release.latest, nil
}

func (r *Resolver) resolveVersionInfo(ctx context.Context, path, version string) (string, error) {
	key := path + "@" + version
	r.mu.Lock()
	if cached, ok := r.versionInfoCache[key]; ok {
		r.mu.Unlock()
		return cached, nil
	}
	r.mu.Unlock()

	var payload struct {
		Version string `json:"Version"`
	}
	err := r.fetchJSON(ctx, proxyModuleURL(path)+"/@v/"+proxyPathEscape(version)+".info", "application/json", &payload)
	if err != nil {
		if IsNotFound(err) && parseGoVersion(version) != nil {
			r.mu.Lock()
			r.versionInfoCache[key] = version
			r.mu.Unlock()
			return version, nil
		}
		return "", err
	}
	resolved := payload.Version
	if resolved == "" {
		resolved = version
	}

	r.mu.Lock()
	r.versionInfoCache[key] = resolved
	r.mu.Unlock()
	return resolved, nil
}

func (r *Resolver) resolveBuildList(ctx context.Context, root moduleRef, rootReplacements []replacement, rootExclusions map[string]bool, progress *progressReporter) (buildResolution, error) {
	// Replacements affect required dependency versions, not the main module.
	rootMeta, err := r.loadGoMod(ctx, root.Path, root.Version)
	if err != nil {
		return buildResolution{}, err
	}
	requirements := append([]requirement(nil), rootMeta.Requires...)
	budget := resolutionBudget{versions: maxModuleVersions, requirements: maxRequirementVisits}
	for {
		resolution, err := r.resolveRequirements(ctx, root, rootMeta, requirements, rootReplacements, rootExclusions, progress, &budget)
		if err != nil || pruningForGoDirective(rootMeta.GoVersion) == pruningUnpruned {
			return resolution, err
		}
		// Go expands inconsistent pruned roots at their selected versions and
		// rebuilds the graph. Constraints from discarded modern root versions
		// must not survive that rebuild; legacy traversal still retains them.
		changed := false
		for i := range requirements {
			selected := resolution.selected[requirements[i].Path]
			if selected != "" && selected != requirements[i].Version && !isRequirementExcluded(requirements[i], rootExclusions) {
				requirements[i].Version = selected
				changed = true
			}
		}
		if !changed {
			return resolution, nil
		}
	}
}

type resolutionBudget struct {
	versions, requirements int
}

func (b *resolutionBudget) visit(count int) error {
	if count > b.requirements {
		return errors.New("dependency traversal exceeds the browser work limit")
	}
	b.requirements -= count
	return nil
}

func (r *Resolver) resolveRequirements(ctx context.Context, root moduleRef, rootMeta moduleMeta, rootRequirements []requirement, rootReplacements []replacement, rootExclusions map[string]bool, progress *progressReporter, budget *resolutionBudget) (buildResolution, error) {
	resolution := buildResolution{
		selected: map[string]string{root.Path: root.Version},
		loaded:   make(map[string]moduleMeta),
	}

	loadModes := make(map[string]loadCandidate)
	rootPruning := pruningForGoDirective(rootMeta.GoVersion)
	if err := budget.visit(len(rootRequirements)); err != nil {
		return buildResolution{}, err
	}
	for _, requirement := range rootRequirements {
		if selectRequirement(resolution.selected, requirement, rootExclusions, root.Path) {
			if len(resolution.selected) > maxSelectedModules {
				return buildResolution{}, fmt.Errorf("module graph is too large to resolve in the browser (%d modules)", len(resolution.selected))
			}
		}
		if err := markLoadMode(loadModes, requirement, rootPruning, rootExclusions, &budget.versions); err != nil {
			return buildResolution{}, err
		}
	}

	processed := make(map[string]modulePruning)
	loadedMu := sync.Mutex{}
	pass := 0

	for {
		if err := ctx.Err(); err != nil {
			return buildResolution{}, err
		}
		pass++
		snapshot := pendingLoadSnapshot(loadModes, processed)
		if len(snapshot) == 0 {
			break
		}

		err := mapLimit(ctx, snapshot, moduleLoadConcurrency, func(index int, entry loadCandidate) error {
			id := moduleID(entry.Path, entry.Version)

			loadedMu.Lock()
			_, ok := resolution.loaded[id]
			loadedMu.Unlock()
			if !ok {
				meta, err := r.loadSelectedGoMod(ctx, entry.moduleRef, rootReplacements)
				if err != nil {
					return err
				}
				loadedMu.Lock()
				if _, exists := resolution.loaded[id]; !exists {
					resolution.loaded[id] = meta
				}
				loadedMu.Unlock()
			}

			value := 18 + pass*8
			if len(snapshot) > 0 {
				value += (index * 7) / len(snapshot)
			}
			if value > 72 {
				value = 72
			}
			progress.Report(value, "Resolving dependencies")
			return nil
		})
		if err != nil {
			return buildResolution{}, err
		}

		for _, entry := range snapshot {
			id := moduleID(entry.Path, entry.Version)
			processed[id] = entry.pruning
			meta := resolution.loaded[id]
			loadTransitive := entry.pruning == pruningUnpruned || pruningForGoDirective(meta.GoVersion) == pruningUnpruned
			nextPruning := pruningForGoDirective(meta.GoVersion)
			if entry.pruning == pruningUnpruned {
				nextPruning = pruningUnpruned
			}
			if err := budget.visit(len(meta.Requires)); err != nil {
				return buildResolution{}, err
			}
			for _, requirement := range meta.Requires {
				if selectRequirement(resolution.selected, requirement, rootExclusions, root.Path) {
					if len(resolution.selected) > maxSelectedModules {
						return buildResolution{}, fmt.Errorf("module graph is too large to resolve in the browser (%d modules)", len(resolution.selected))
					}
				}
				if loadTransitive {
					if err := markLoadMode(loadModes, requirement, nextPruning, rootExclusions, &budget.versions); err != nil {
						return buildResolution{}, err
					}
				}
			}
		}
	}

	// A dependency can require the same version as the analyzed root and apply
	// a replacement to that version. Traverse its metadata independently, then
	// restore the main module's own metadata for the displayed root node.
	resolution.loaded[root.ID] = rootMeta
	return resolution, nil
}

func (r *Resolver) loadSelectedGoMod(ctx context.Context, entry moduleRef, rootReplacements []replacement) (moduleMeta, error) {
	replacement := replacementFor(entry.Path, entry.Version, rootReplacements)
	if replacement == nil {
		meta, err := r.loadGoMod(ctx, entry.Path, entry.Version)
		if err != nil {
			return moduleMeta{}, err
		}
		meta.SelectedPath = entry.Path
		meta.SelectedVersion = entry.Version
		return meta, nil
	}

	if replacement.LocalPath != "" || replacement.NewPath == "" || replacement.NewVersion == "" {
		return moduleMeta{
			ModulePath:      entry.Path,
			SelectedPath:    entry.Path,
			SelectedVersion: entry.Version,
			Replacement:     replacement,
		}, nil
	}

	meta, err := r.loadGoMod(ctx, replacement.NewPath, replacement.NewVersion)
	if err != nil {
		return moduleMeta{}, err
	}
	meta.SelectedPath = entry.Path
	meta.SelectedVersion = entry.Version
	meta.Replacement = replacement
	return meta, nil
}

func (r *Resolver) loadGoMod(ctx context.Context, path, version string) (moduleMeta, error) {
	key := path + "@" + version
	r.mu.Lock()
	if cached, ok := r.modFileCache[key]; ok {
		r.mu.Unlock()
		return cached, nil
	}
	r.mu.Unlock()

	source := proxyModuleURL(path) + "/@v/" + proxyPathEscape(version) + ".mod"
	raw, err := r.fetchText(ctx, source, "text/plain,*/*")
	if err != nil {
		return moduleMeta{}, err
	}
	meta, err := parseGoMod(raw)
	if err != nil {
		return moduleMeta{}, err
	}
	meta.RequestedPath = path
	meta.RequestedVersion = version
	meta.Source = source
	meta.ObservedAt = time.Now().UTC().Format(time.RFC3339Nano)

	r.mu.Lock()
	r.modFileCache[key] = meta
	r.mu.Unlock()
	return meta, nil
}

// A go.mod declaration alone cannot establish that two paths name the same source.
func (r *Resolver) sameModuleOrigin(ctx context.Context, requested, declared, version string) bool {
	type origin struct{ VCS, URL, Subdir, Hash string }
	lookup := func(path string) (origin, bool) {
		var info struct {
			Version string
			Origin  origin
		}
		err := r.fetchJSON(ctx, proxyModuleURL(path)+"/@v/"+proxyPathEscape(version)+".info", "application/json", &info)
		return info.Origin, err == nil && info.Version == version && info.Origin.VCS != "" && info.Origin.URL != "" && info.Origin.Hash != ""
	}
	first, ok := lookup(requested)
	if !ok {
		return false
	}
	second, ok := lookup(declared)
	return ok && first == second
}

func (r *Resolver) buildGraph(ctx context.Context, root moduleRef, requestedTarget string, resolution buildResolution, rootDirectPaths map[string]bool, rootReplacements []replacement, rootExclusions map[string]bool) (*graph.Graph, error) {
	nodes := make([]graph.Node, 0, len(resolution.selected))
	edges := make([]graph.Edge, 0)
	seenEdges := make(map[string]bool)
	selectedEntries := selectedSnapshot(resolution.selected)
	selectedEntries = filterPseudoModules(selectedEntries)
	sort.Slice(selectedEntries, func(i, j int) bool {
		if selectedEntries[i].Path == root.Path {
			return true
		}
		if selectedEntries[j].Path == root.Path {
			return false
		}
		return selectedEntries[i].ID < selectedEntries[j].ID
	})

	for _, entry := range selectedEntries {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		sourceID := moduleID(entry.Path, entry.Version)
		meta, ok := resolution.loaded[sourceID]
		if !ok {
			continue
		}

		for _, requirement := range meta.Requires {
			if isPseudoModulePath(requirement.Path) || isRequirementExcluded(requirement, rootExclusions) {
				continue
			}
			selectedVersion := resolution.selected[requirement.Path]
			if selectedVersion == "" {
				continue
			}
			targetID := moduleID(requirement.Path, selectedVersion)
			if targetID == sourceID {
				continue
			}
			key := sourceID + "->" + targetID
			if seenEdges[key] {
				continue
			}
			if len(edges) >= maxGraphEdges {
				return nil, fmt.Errorf("module graph exceeds the browser limit of %d edges", maxGraphEdges)
			}
			seenEdges[key] = true
			edges = append(edges, graph.Edge{Source: sourceID, Target: targetID})
		}
	}

	degrees := computeDegrees(edges)
	for _, entry := range selectedEntries {
		var rule *replacement
		if entry.Path != root.Path {
			rule = replacementFor(entry.Path, entry.Version, rootReplacements)
		}
		node := graph.Node{
			ID:               entry.ID,
			Name:             entry.Path,
			Version:          entry.Version,
			Root:             entry.Path == root.Path,
			Main:             entry.Path == root.Path,
			Direct:           entry.Path != root.Path && rootDirectPaths[entry.Path],
			Replaced:         rule != nil,
			Replacement:      replacementTargetID(rule),
			LocalReplacement: rule != nil && rule.LocalPath != "",
			InDegree:         degrees.in[entry.ID],
			OutDegree:        degrees.out[entry.ID],
		}
		if meta, ok := resolution.loaded[entry.ID]; ok && meta.Source != "" {
			identity, public := goRequirementIdentity(node)
			if public {
				requirement := requirementObservation(meta, identity)
				node.GoRequirement = &requirement
			}
		}
		nodes = append(nodes, node)
	}

	names := make([]graph.PackageName, 0, len(nodes))
	for _, node := range nodes {
		names = append(names, graph.PackageName{
			Name:   node.Name,
			Count:  1,
			Root:   node.Root,
			Direct: node.Direct,
		})
	}

	return &graph.Graph{
		RootID: root.ID,
		Nodes:  nodes,
		Edges:  edges,
		Meta: graph.GraphMeta{
			Mode:      moduleMode,
			Target:    requestedTarget,
			NodeCount: len(nodes),
			EdgeCount: len(edges),
		},
		PackageInfo: graph.PackageInfo{
			Licenses: []graph.LicenseInfo{{Name: "unknown", Count: len(nodes)}},
			Names:    names,
		},
	}, nil
}

func (r *Resolver) fetchText(ctx context.Context, requestURL, accept string) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	request := FetchRequest{URL: requestURL, Accept: accept}
	switch {
	case strings.HasSuffix(requestURL, ".mod"):
		request.MaxBytes = maxGoModBytes
	case strings.HasSuffix(requestURL, "/@v/list"):
		request.MaxBytes = maxReleaseListBytes
	}
	body, err := r.fetcher.FetchText(ctx, request)
	if err == nil && request.MaxBytes > 0 && len(body) > request.MaxBytes {
		return "", errors.New("upstream response exceeds the browser size limit")
	}
	return body, err
}

func (r *Resolver) fetchJSON(ctx context.Context, requestURL, accept string, out any) error {
	text, err := r.fetchText(ctx, requestURL, accept)
	if err != nil {
		return err
	}
	if err := json.Unmarshal([]byte(text), out); err != nil {
		return fmt.Errorf("decode %s: %w", requestURL, err)
	}
	return nil
}

func selectedSnapshot(selected map[string]string) []moduleRef {
	entries := make([]moduleRef, 0, len(selected))
	for path, version := range selected {
		entries = append(entries, moduleRef{Path: path, Version: version, ID: moduleID(path, version)})
	}
	sort.Slice(entries, func(i, j int) bool {
		return entries[i].ID < entries[j].ID
	})
	return entries
}

func pendingLoadSnapshot(loadModes map[string]loadCandidate, processed map[string]modulePruning) []loadCandidate {
	entries := make([]loadCandidate, 0, len(loadModes))
	for id, entry := range loadModes {
		if done, ok := processed[id]; ok && done >= entry.pruning {
			continue
		}
		entries = append(entries, entry)
	}
	sort.Slice(entries, func(i, j int) bool {
		return entries[i].ID < entries[j].ID
	})
	return entries
}

func selectRequirement(selected map[string]string, requirement requirement, exclusions map[string]bool, rootPath string) bool {
	// The analyzed root acts as Go's main module. Other versions of its path
	// may contribute requirements, but cannot replace the requested version.
	if requirement.Path == rootPath {
		return false
	}
	if isPseudoModulePath(requirement.Path) || requirement.Version == "" || isRequirementExcluded(requirement, exclusions) {
		return false
	}
	current := selected[requirement.Path]
	if current == "" || compareGoVersions(requirement.Version, current) > 0 {
		selected[requirement.Path] = requirement.Version
		return true
	}
	return false
}

func markLoadMode(loadModes map[string]loadCandidate, requirement requirement, pruning modulePruning, exclusions map[string]bool, remainingLoads *int) error {
	if isPseudoModulePath(requirement.Path) || requirement.Version == "" || isRequirementExcluded(requirement, exclusions) {
		return nil
	}
	id := moduleID(requirement.Path, requirement.Version)
	if current, ok := loadModes[id]; !ok || pruning > current.pruning {
		if *remainingLoads == 0 {
			return fmt.Errorf("module graph exceeds the browser limit of %d module-version loads", maxModuleVersions)
		}
		*remainingLoads--
		loadModes[id] = loadCandidate{
			moduleRef: moduleRef{Path: requirement.Path, Version: requirement.Version, ID: id},
			pruning:   pruning,
		}
	}
	return nil
}

func pruningForGoDirective(version string) modulePruning {
	version = strings.TrimSpace(version)
	// Unlike toolchain names, go directives need a minor version, end in a
	// digit, and cannot carry a custom suffix. Check before indexing the end.
	if !strings.Contains(version, ".") || strings.Contains(version, "-") ||
		version[len(version)-1] < '0' || version[len(version)-1] > '9' {
		return pruningUnpruned
	}
	if goversion.Compare(goversion.Lang("go"+version), "go1.17") < 0 {
		return pruningUnpruned
	}
	return pruningPruned
}

func filterPseudoModules(entries []moduleRef) []moduleRef {
	out := entries[:0]
	for _, entry := range entries {
		if !isPseudoModulePath(entry.Path) {
			out = append(out, entry)
		}
	}
	return out
}

type degreeIndex struct {
	in  map[string]int
	out map[string]int
}

func computeDegrees(edges []graph.Edge) degreeIndex {
	degrees := degreeIndex{
		in:  make(map[string]int),
		out: make(map[string]int),
	}
	for _, edge := range edges {
		degrees.out[edge.Source]++
		degrees.in[edge.Target]++
	}
	return degrees
}

func moduleID(path, version string) string {
	if version == "" {
		return path
	}
	return path + "@" + version
}

func splitTargetVersion(target string) (string, string) {
	index := strings.LastIndex(target, "@")
	if index <= 0 {
		return strings.TrimSpace(target), ""
	}
	return strings.TrimSpace(target[:index]), strings.TrimSpace(target[index+1:])
}

// NormalizeModuleTarget trims public module target input and rejects local paths.
func NormalizeModuleTarget(target string) string {
	normalized := strings.TrimSpace(target)
	if normalized == "" || isLikelyLocalTarget(normalized) {
		return ""
	}
	return normalized
}

var searchInput = regexp.MustCompile(`^([A-Za-z0-9_-][A-Za-z0-9._~/-]*(?: [A-Za-z0-9_-]+)*)(?:@(?:[A-Za-z0-9_/-]*|v[0-9][A-Za-z0-9.+-]*))?$`)

// NormalizeModuleSearchQuery checks the entire input before dropping a version.
// In particular, never reinterpret the user information in a URL as a query.
func NormalizeModuleSearchQuery(query string) string {
	match := searchInput.FindStringSubmatch(strings.TrimSpace(query))
	if match == nil || isLikelyLocalTarget(match[1]) {
		return ""
	}
	return match[1]
}

func shouldSearchModuleTarget(target string) bool {
	target = NormalizeModuleSearchQuery(target)
	if target == "" || isLikelyLocalTarget(target) {
		return false
	}
	firstSegment := target
	if before, _, ok := strings.Cut(target, "/"); ok {
		firstSegment = before
	}
	return !strings.Contains(firstSegment, ".")
}

func isLikelyLocalTarget(target string) bool {
	return target == "." ||
		target == ".." ||
		strings.HasPrefix(target, "./") ||
		strings.HasPrefix(target, "../") ||
		strings.HasPrefix(target, "/") ||
		strings.HasPrefix(target, "~") ||
		strings.Contains(target, `\`) ||
		(len(target) >= 2 && target[1] == ':') ||
		strings.HasSuffix(target, ".mod")
}

func isPseudoModulePath(path string) bool {
	return path == "go" || path == "toolchain"
}

func exclusionIndex(exclusions []exclusion) map[string]bool {
	if len(exclusions) == 0 {
		return nil
	}
	index := make(map[string]bool, len(exclusions))
	for _, exclusion := range exclusions {
		if exclusion.Path == "" || exclusion.Version == "" {
			continue
		}
		index[moduleID(exclusion.Path, exclusion.Version)] = true
	}
	return index
}

func isRequirementExcluded(requirement requirement, exclusions map[string]bool) bool {
	return exclusions[moduleID(requirement.Path, requirement.Version)]
}

func isLocalReplacementTarget(target string) bool {
	if target == "" {
		return false
	}
	return strings.HasPrefix(target, ".") ||
		strings.HasPrefix(target, "/") ||
		strings.HasPrefix(target, `\`) ||
		(len(target) >= 2 && target[1] == ':')
}

func replacementFor(path, version string, replacements []replacement) *replacement {
	var wildcard *replacement
	for i := range replacements {
		replacement := &replacements[i]
		if replacement.OldPath != path {
			continue
		}
		if replacement.OldVersion == version && version != "" {
			return replacement
		}
		if replacement.OldVersion == "" {
			wildcard = replacement
		}
	}
	return wildcard
}

func replacementTargetID(replacement *replacement) string {
	if replacement == nil {
		return ""
	}
	if replacement.LocalPath != "" {
		return replacement.LocalPath
	}
	return moduleID(replacement.NewPath, replacement.NewVersion)
}

func proxyModuleURL(modulePath string) string {
	parts := strings.Split(modulePath, "/")
	for i, part := range parts {
		parts[i] = proxyPathEscape(part)
	}
	return proxyBaseURL + "/" + strings.Join(parts, "/")
}

func proxyPathEscape(value string) string {
	var escaped strings.Builder
	for _, char := range value {
		if char >= 'A' && char <= 'Z' {
			escaped.WriteByte('!')
			escaped.WriteRune(char + ('a' - 'A'))
		} else {
			escaped.WriteRune(char)
		}
	}
	return url.PathEscape(escaped.String())
}

func mapLimit[T any](ctx context.Context, items []T, limit int, worker func(index int, item T) error) error {
	if len(items) == 0 {
		return nil
	}
	if limit <= 0 || limit > len(items) {
		limit = len(items)
	}
	dispatch, stop := context.WithCancel(ctx)
	defer stop()

	type job struct {
		index int
		item  T
	}
	jobs := make(chan job)
	var wg sync.WaitGroup
	var once sync.Once
	var firstErr error

	recordErr := func(err error) {
		if err == nil {
			return
		}
		once.Do(func() {
			firstErr = err
			stop()
		})
	}

	for i := 0; i < limit; i++ {
		wg.Go(func() {
			for next := range jobs {
				if err := dispatch.Err(); err != nil {
					recordErr(err)
					continue
				}
				recordErr(worker(next.index, next.item))
			}
		})
	}

sendJobs:
	for index, item := range items {
		select {
		case <-dispatch.Done():
			recordErr(ctx.Err())
			break sendJobs
		case jobs <- job{index: index, item: item}:
		}
	}
	close(jobs)
	wg.Wait()

	if firstErr != nil {
		return firstErr
	}
	return ctx.Err()
}

type progressReporter struct {
	mu   sync.Mutex
	last int
	fn   func(Progress)
}

func newProgressReporter(fn func(Progress)) *progressReporter {
	return &progressReporter{fn: fn}
}

func (p *progressReporter) Report(value int, label string) {
	if p == nil || p.fn == nil {
		return
	}
	if value < 0 {
		value = 0
	}
	if value > 100 {
		value = 100
	}

	p.mu.Lock()
	if value < p.last {
		value = p.last
	}
	p.last = value
	p.mu.Unlock()

	p.fn(Progress{Value: value, Label: label})
}
