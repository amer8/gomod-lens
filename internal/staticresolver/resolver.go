package staticresolver

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	goversion "go/version"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/amer8/gomod-lens/internal/graph"
	"github.com/amer8/gomod-lens/internal/modulesearch"
)

const (
	moduleMode            = "module"
	proxyBaseURL          = "https://proxy.golang.org"
	depsDevBaseURL        = "https://api.deps.dev/v3"
	githubSearchURL       = "https://api.github.com/search/repositories"
	maxSelectedModules    = 1500
	moduleLoadConcurrency = 8
	scoreLoadConcurrency  = 5
)

// Resolver builds module dependency graphs using browser-provided fetches.
type Resolver struct {
	fetcher Fetcher

	mu                  sync.Mutex
	modFileCache        map[string]moduleMeta
	versionInfoCache    map[string]string
	releaseVersionCache map[string]string
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
		releaseVersionCache: make(map[string]string),
		depsDevVersionCache: make(map[string]depsDevVersion),
		depsDevProjectCache: make(map[string]depsDevProject),
	}
}

// ResolveGraph resolves target as a public module and returns its dependency graph.
func (r *Resolver) ResolveGraph(ctx context.Context, target string, options Options) (*graph.Graph, error) {
	if r == nil || r.fetcher == nil {
		return nil, errors.New("static resolver requires a fetcher")
	}
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
	if declaredPath := declaredRootModulePath(rootMeta.ModulePath, root.Path); declaredPath != root.Path {
		root = moduleRef{Path: declaredPath, Version: rootVersion, ID: moduleID(declaredPath, rootVersion)}
		requested = requestedTarget{
			Target:  moduleID(declaredPath, requested.Version),
			Path:    declaredPath,
			Version: requested.Version,
		}
		r.cacheGoMod(root.Path, root.Version, rootMeta)
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
	if isLikelyLocalTarget(target) || strings.Contains(target, "://") || strings.ContainsAny(target, "?#") {
		return requestedTarget{}, errors.New("enter a public Go module path")
	}

	base, version := splitTargetVersion(target)
	if !shouldSearchModuleTarget(base) {
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
	var latest struct {
		Version string `json:"Version"`
	}
	err := r.fetchJSON(ctx, proxyModuleURL(path)+"/@latest", "application/json", &latest)
	if err == nil && latest.Version != "" {
		return latest.Version, nil
	}
	if err != nil && !IsNotFound(err) {
		return "", err
	}

	list, err := r.fetchText(ctx, proxyModuleURL(path)+"/@v/list", "text/plain,*/*")
	if err != nil {
		return "", err
	}
	versions := make([]string, 0)
	for version := range strings.FieldsSeq(list) {
		version = strings.TrimSpace(version)
		if version != "" && parseGoVersion(version) != nil {
			versions = append(versions, version)
		}
	}
	sort.Slice(versions, func(i, j int) bool {
		return compareGoVersions(versions[i], versions[j]) > 0
	})
	if len(versions) > 0 {
		for _, version := range versions {
			if parsed := parseGoVersion(version); parsed != nil && parsed.Prerelease == "" {
				return version, nil
			}
		}
		return versions[0], nil
	}

	return "", fmt.Errorf("proxy did not return a latest version for %s", path)
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
		if parseGoVersion(version) != nil {
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
	for {
		resolution, err := r.resolveRequirements(ctx, root, rootMeta, requirements, rootReplacements, rootExclusions, progress)
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

func (r *Resolver) resolveRequirements(ctx context.Context, root moduleRef, rootMeta moduleMeta, rootRequirements []requirement, rootReplacements []replacement, rootExclusions map[string]bool, progress *progressReporter) (buildResolution, error) {
	resolution := buildResolution{
		selected: map[string]string{root.Path: root.Version},
		loaded:   make(map[string]moduleMeta),
	}

	loadModes := make(map[string]loadCandidate)
	rootPruning := pruningForGoDirective(rootMeta.GoVersion)
	for _, requirement := range rootRequirements {
		if selectRequirement(resolution.selected, requirement, rootExclusions, root.Path) {
			if len(resolution.selected) > maxSelectedModules {
				return buildResolution{}, fmt.Errorf("module graph is too large to resolve in the browser (%d modules)", len(resolution.selected))
			}
		}
		markLoadMode(loadModes, requirement, rootPruning, rootExclusions)
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
			for _, requirement := range meta.Requires {
				if selectRequirement(resolution.selected, requirement, rootExclusions, root.Path) {
					if len(resolution.selected) > maxSelectedModules {
						return buildResolution{}, fmt.Errorf("module graph is too large to resolve in the browser (%d modules)", len(resolution.selected))
					}
				}
				if loadTransitive {
					markLoadMode(loadModes, requirement, nextPruning, rootExclusions)
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

func (r *Resolver) cacheGoMod(path, version string, meta moduleMeta) {
	if path == "" || version == "" {
		return
	}
	meta.RequestedPath = path
	meta.RequestedVersion = version

	r.mu.Lock()
	defer r.mu.Unlock()
	r.modFileCache[path+"@"+version] = meta
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
			ID:          entry.ID,
			Name:        entry.Path,
			Version:     entry.Version,
			Root:        entry.Path == root.Path,
			Main:        entry.Path == root.Path,
			Direct:      entry.Path != root.Path && rootDirectPaths[entry.Path],
			Replaced:    rule != nil,
			Replacement: replacementTargetID(rule),
			InDegree:    degrees.in[entry.ID],
			OutDegree:   degrees.out[entry.ID],
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
	return r.fetcher.FetchText(ctx, FetchRequest{URL: requestURL, Accept: accept})
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

func markLoadMode(loadModes map[string]loadCandidate, requirement requirement, pruning modulePruning, exclusions map[string]bool) {
	if isPseudoModulePath(requirement.Path) || requirement.Version == "" || isRequirementExcluded(requirement, exclusions) {
		return
	}
	id := moduleID(requirement.Path, requirement.Version)
	if current, ok := loadModes[id]; !ok || pruning > current.pruning {
		loadModes[id] = loadCandidate{
			moduleRef: moduleRef{Path: requirement.Path, Version: requirement.Version, ID: id},
			pruning:   pruning,
		}
	}
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

// NormalizeModuleSearchQuery trims search input and removes any requested version suffix.
func NormalizeModuleSearchQuery(query string) string {
	base, _ := splitTargetVersion(strings.TrimSpace(query))
	return strings.TrimSpace(base)
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
		strings.HasSuffix(target, ".mod")
}

func isPseudoModulePath(path string) bool {
	return path == "go" || path == "toolchain"
}

func declaredRootModulePath(declared, requested string) string {
	declared = strings.TrimSpace(declared)
	if !isPlausibleDeclaredModulePath(declared) {
		return strings.TrimSpace(requested)
	}
	return declared
}

func isPlausibleDeclaredModulePath(path string) bool {
	if path == "" ||
		strings.Contains(path, "@") ||
		strings.Contains(path, "://") ||
		strings.ContainsAny(path, "?#") ||
		strings.HasPrefix(path, ".") ||
		strings.HasPrefix(path, "/") ||
		isPseudoModulePath(path) {
		return false
	}

	for _, r := range path {
		switch {
		case r >= 'a' && r <= 'z':
			continue
		case r >= 'A' && r <= 'Z':
			continue
		case r >= '0' && r <= '9':
			continue
		}
		switch r {
		case '/', '.', '-', '_', '~':
			continue
		default:
			return false
		}
	}
	return true
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
		})
	}

	for i := 0; i < limit; i++ {
		wg.Go(func() {
			for next := range jobs {
				if err := ctx.Err(); err != nil {
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
		case <-ctx.Done():
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
