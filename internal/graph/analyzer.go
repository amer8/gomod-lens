//go:build !js || !wasm

package graph

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

const (
	// Seed remote analysis in an isolated module so resolution does not inherit
	// the user's local workspace or module requirements.
	remoteModuleSeedGoMod = "module gomod-lens/tmp\n\ngo 1.26\n"
)

var remoteModuleEnv = []string{
	"GOWORK=off",
	"GOPROXY=https://proxy.golang.org",
	"GONOPROXY=",
	"GOPRIVATE=",
}

type Analyzer struct {
	runner Runner
	lenses []Lens
}

// NewAnalyzer creates an Analyzer backed by runner and the default built-in lenses.
func NewAnalyzer(runner Runner) *Analyzer {
	return &Analyzer{
		runner: runner,
		lenses: []Lens{
			NewOpenSSFScorecardLens(NewDepsDevOpenSSFScoreProvider(nil, 5)),
			NewReleaseFreshnessLens(NewGoProxyReleaseFreshnessProvider(nil, 5)),
		},
	}
}

// SetLenses replaces the lenses applied after dependency graph analysis.
func (a *Analyzer) SetLenses(lenses ...Lens) {
	a.lenses = append([]Lens(nil), lenses...)
}

// SetOpenSSFScoreProvider replaces the provider used to enrich graphs with Scorecard data.
func (a *Analyzer) SetOpenSSFScoreProvider(provider OpenSSFScoreProvider) {
	a.replaceLens(LensOpenSSF, NewOpenSSFScorecardLens(provider))
}

// SetReleaseFreshnessProvider replaces the provider used to enrich graphs with
// release freshness data.
func (a *Analyzer) SetReleaseFreshnessProvider(provider ReleaseFreshnessProvider) {
	a.replaceLens(LensReleaseFreshness, NewReleaseFreshnessLens(provider))
}

func (a *Analyzer) replaceLens(lensID string, lens Lens) {
	lensID = normalizeLensID(lensID)
	for i, existing := range a.lenses {
		if existing == nil {
			continue
		}
		if normalizeLensID(existing.Definition().ID) == lensID {
			a.lenses[i] = lens
			return
		}
	}
	a.lenses = append(a.lenses, lens)
}

// Analyze builds a dependency graph for a local path or public module target.
func (a *Analyzer) Analyze(ctx context.Context, req Request) (*Graph, error) {
	target := strings.TrimSpace(req.Target)
	mode := normalizeMode(req.Mode)
	if target == "" {
		if mode == ModeModule {
			return nil, invalidRequestf("module target is required")
		}
		target = "."
	}
	if mode == ModeAuto {
		mode = detectMode(target)
	}

	var result *Graph
	var err error
	switch mode {
	case ModeLocal:
		result, err = a.analyzeLocal(ctx, target)
	case ModeModule:
		result, err = a.analyzeModule(ctx, target)
	default:
		return nil, invalidRequestf("unsupported mode %q", mode)
	}
	if err != nil {
		return nil, err
	}

	if err := a.applyLenses(ctx, result); err != nil {
		return nil, err
	}

	return result, nil
}

func (a *Analyzer) applyLenses(ctx context.Context, graph *Graph) error {
	for _, lens := range a.lenses {
		if lens == nil {
			continue
		}
		definition := lens.Definition()
		if err := lens.Analyze(ctx, graph); err != nil {
			return fmt.Errorf("apply lens %q: %w", definition.ID, err)
		}
		graph.Meta.AddLens(definition)
	}
	return nil
}

func normalizeMode(mode string) string {
	switch strings.ToLower(strings.TrimSpace(mode)) {
	case "", ModeAuto:
		return ModeAuto
	case ModeLocal:
		return ModeLocal
	case ModeModule:
		return ModeModule
	default:
		return mode
	}
}

func detectMode(target string) string {
	target = strings.TrimSpace(target)
	switch {
	case target == "", target == ".", target == "..":
		return ModeLocal
	case strings.HasPrefix(target, "./"), strings.HasPrefix(target, "../"):
		return ModeLocal
	case filepath.IsAbs(target), strings.HasSuffix(target, ".mod"):
		return ModeLocal
	}

	if info, err := os.Stat(target); err == nil && info.IsDir() {
		return ModeLocal
	}

	return ModeModule
}

func (a *Analyzer) analyzeLocal(ctx context.Context, target string) (*Graph, error) {
	dir, err := normalizeLocalDir(target)
	if err != nil {
		return nil, err
	}

	modules, mainID, err := a.readModuleList(ctx, dir, nil)
	if err != nil {
		return nil, err
	}

	edges, err := a.readEdges(ctx, dir, nil)
	if err != nil {
		return nil, err
	}

	direct, replacements, err := a.readGoModMetadata(ctx, dir, nil, false)
	if err != nil {
		return nil, err
	}

	return buildGraph(buildInput{
		rootID:       mainID,
		mode:         ModeLocal,
		target:       dir,
		modules:      modules,
		edges:        edges,
		direct:       direct,
		replacements: replacements,
		filterToRoot: false,
	})
}

func (a *Analyzer) analyzeModule(ctx context.Context, target string) (*Graph, error) {
	target = strings.TrimSpace(target)
	if target == "" {
		return nil, invalidRequestf("module target is required")
	}

	tempDir, err := os.MkdirTemp("", "gomod-lens-*")
	if err != nil {
		return nil, fmt.Errorf("create temp dir: %w", err)
	}
	defer os.RemoveAll(tempDir)

	if err := os.WriteFile(filepath.Join(tempDir, "go.mod"), []byte(remoteModuleSeedGoMod), 0o644); err != nil {
		return nil, fmt.Errorf("write temp go.mod: %w", err)
	}

	env := append([]string(nil), remoteModuleEnv...)
	resolvedTarget := target
	requested := goGetRequestTarget(resolvedTarget)

	if _, err := a.runner.Run(ctx, tempDir, env, "go", "get", requested); err != nil {
		declaredPath := declaredModulePathFromError(err)
		if declaredPath == "" {
			return nil, fmt.Errorf("resolve module %q: %w", target, err)
		}

		_, version := splitModuleToken(target)
		resolvedTarget = moduleID(declaredPath, version)
		requested = goGetRequestTarget(resolvedTarget)
		if err := os.WriteFile(filepath.Join(tempDir, "go.mod"), []byte(remoteModuleSeedGoMod), 0o644); err != nil {
			return nil, fmt.Errorf("reset temp go.mod: %w", err)
		}
		if _, retryErr := a.runner.Run(ctx, tempDir, env, "go", "get", requested); retryErr != nil {
			return nil, fmt.Errorf("resolve module %q via declared path %q: %w", target, resolvedTarget, retryErr)
		}
	}

	modules, _, err := a.readModuleList(ctx, tempDir, env)
	if err != nil {
		return nil, err
	}

	tempRequires, _, err := a.readGoModMetadata(ctx, tempDir, env, true)
	if err != nil {
		return nil, err
	}

	rootID, err := pickRootModuleID(resolvedTarget, tempRequires)
	if err != nil {
		return nil, err
	}

	rootInfo, ok := modules[rootID]
	if !ok {
		return nil, fmt.Errorf("resolved root module %q missing from module list", rootID)
	}
	if strings.TrimSpace(rootInfo.Dir) == "" {
		return nil, fmt.Errorf("resolved root module %q has no module directory", rootID)
	}

	rootModules, rootMainID, err := a.readModuleList(ctx, rootInfo.Dir, env)
	if err != nil {
		return nil, fmt.Errorf("load root module list: %w", err)
	}

	rootEdges, err := a.readEdges(ctx, rootInfo.Dir, env)
	if err != nil {
		return nil, fmt.Errorf("load root module graph: %w", err)
	}

	rootDirect, replacements, err := a.readGoModMetadata(ctx, rootInfo.Dir, env, false)
	if err != nil {
		return nil, fmt.Errorf("read root module requirements: %w", err)
	}

	rootModules, rootEdges = rewriteMainModuleID(rootModules, rootEdges, rootMainID, rootID)

	return buildGraph(buildInput{
		rootID:       rootID,
		mode:         ModeModule,
		target:       resolvedTarget,
		modules:      rootModules,
		edges:        rootEdges,
		direct:       rootDirect,
		replacements: replacements,
		filterToRoot: true,
	})
}

func goGetRequestTarget(target string) string {
	requested := target
	if _, version := splitModuleToken(requested); version == "" {
		requested += "@latest"
	}
	return requested
}

func declaredModulePathFromError(err error) string {
	if err == nil {
		return ""
	}

	const marker = "module declares its path as:"
	text := err.Error()
	index := strings.Index(text, marker)
	if index < 0 {
		return ""
	}

	rest := strings.TrimSpace(text[index+len(marker):])
	fields := strings.Fields(rest)
	if len(fields) == 0 {
		return ""
	}

	path := strings.TrimSpace(fields[0])
	if !isPlausibleDeclaredModulePath(path) {
		return ""
	}
	return path
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

func normalizeLocalDir(target string) (string, error) {
	path := target
	if strings.HasSuffix(path, ".mod") {
		path = filepath.Dir(path)
	}

	absPath, err := filepath.Abs(path)
	if err != nil {
		return "", invalidRequestError(fmt.Errorf("resolve path %q: %w", target, err))
	}

	if _, err := os.Stat(filepath.Join(absPath, "go.mod")); err != nil {
		return "", invalidRequestError(fmt.Errorf("go.mod not found in %s", absPath))
	}

	return absPath, nil
}

func (a *Analyzer) readModuleList(ctx context.Context, dir string, env []string) (map[string]moduleInfo, string, error) {
	raw, err := a.runner.Run(ctx, dir, env, "go", "list", "-m", "-json", "all")
	if err != nil {
		return nil, "", fmt.Errorf("load module list: %w", err)
	}

	modules, mainID, err := parseModuleList(raw)
	if err != nil {
		return nil, "", err
	}

	return modules, mainID, nil
}

func (a *Analyzer) readEdges(ctx context.Context, dir string, env []string) ([]Edge, error) {
	raw, err := a.runner.Run(ctx, dir, env, "go", "mod", "graph")
	if err != nil {
		return nil, fmt.Errorf("load module graph: %w", err)
	}

	return parseEdges(raw)
}

func (a *Analyzer) readGoModMetadata(ctx context.Context, dir string, env []string, includeIndirect bool) (map[string]bool, []replacementRule, error) {
	raw, err := a.runner.Run(ctx, dir, env, "go", "mod", "edit", "-json")
	if err != nil {
		return nil, nil, fmt.Errorf("load requirements: %w", err)
	}

	requires, err := parseRequires(raw, includeIndirect)
	if err != nil {
		return nil, nil, err
	}

	replacements, err := parseReplacements(raw, dir)
	if err != nil {
		return nil, nil, err
	}

	return requires, replacements, nil
}

func pickRootModuleID(target string, requires map[string]bool) (string, error) {
	targetPath, _ := splitModuleToken(target)
	if exact := canonicalModuleToken(target); requires[exact] {
		return exact, nil
	}

	var candidates []string
	for id := range requires {
		path, _ := splitModuleToken(id)
		if path == targetPath {
			candidates = append(candidates, id)
		}
	}

	sort.Strings(candidates)
	if len(candidates) == 1 {
		return candidates[0], nil
	}
	if len(candidates) == 0 && len(requires) == 1 {
		for id := range requires {
			return id, nil
		}
	}

	return "", fmt.Errorf("unable to determine resolved root module for %q", target)
}

type buildInput struct {
	rootID       string
	mode         string
	target       string
	modules      map[string]moduleInfo
	edges        []Edge
	direct       map[string]bool
	replacements []replacementRule
	filterToRoot bool
}

type replacementRule struct {
	Path        string
	Version     string
	Replacement moduleInfo
}

func isPseudoModuleID(id string) bool {
	path, _ := splitModuleToken(id)
	return isPseudoModulePath(path)
}

func isPseudoModulePath(path string) bool {
	switch strings.TrimSpace(path) {
	case "go", "toolchain":
		return true
	default:
		return false
	}
}

func buildGraph(input buildInput) (*Graph, error) {
	if strings.TrimSpace(input.rootID) == "" {
		return nil, fmt.Errorf("root module is required")
	}

	selectedByPath := make(map[string]string, len(input.modules))
	for id, info := range input.modules {
		if isPseudoModuleID(id) {
			continue
		}

		path := info.Path
		if path == "" {
			path, _ = splitModuleToken(id)
		}
		selectedByPath[path] = id
	}

	outgoing := make(map[string][]string)
	includedEdges := make([]Edge, 0, len(input.edges))
	seenEdges := make(map[string]bool)
	for _, edge := range input.edges {
		edge, ok := normalizeSelectedEdge(edge, input.modules, selectedByPath)
		if !ok {
			continue
		}

		key := edge.Source + "->" + edge.Target
		if seenEdges[key] {
			continue
		}

		seenEdges[key] = true
		outgoing[edge.Source] = append(outgoing[edge.Source], edge.Target)
		includedEdges = append(includedEdges, edge)
	}

	included := make(map[string]bool)
	if input.filterToRoot {
		queue := []string{input.rootID}
		included[input.rootID] = true
		for len(queue) > 0 {
			current := queue[0]
			queue = queue[1:]
			for _, next := range outgoing[current] {
				if included[next] {
					continue
				}
				included[next] = true
				queue = append(queue, next)
			}
		}
	} else {
		included[input.rootID] = true
		for _, edge := range includedEdges {
			included[edge.Source] = true
			included[edge.Target] = true
		}
		for id := range input.modules {
			if isPseudoModuleID(id) {
				continue
			}
			included[id] = true
		}
	}

	inDegree := make(map[string]int)
	outDegree := make(map[string]int)
	filteredEdges := make([]Edge, 0, len(includedEdges))
	for _, edge := range includedEdges {
		if !included[edge.Source] || !included[edge.Target] {
			continue
		}
		filteredEdges = append(filteredEdges, edge)
		outDegree[edge.Source]++
		inDegree[edge.Target]++
	}

	nodeIDs := make([]string, 0, len(included))
	for id := range included {
		nodeIDs = append(nodeIDs, id)
	}
	sort.Slice(nodeIDs, func(i, j int) bool {
		if nodeIDs[i] == input.rootID {
			return true
		}
		if nodeIDs[j] == input.rootID {
			return false
		}
		return nodeIDs[i] < nodeIDs[j]
	})

	nodes := make([]Node, 0, len(nodeIDs))
	for _, id := range nodeIDs {
		info := resolveModuleInfo(id, input.modules, input.replacements)

		replacement := ""
		replaced := info.Replace != nil
		if replaced {
			replacement = moduleID(info.Replace.Path, info.Replace.Version)
		}

		nodes = append(nodes, Node{
			ID:          id,
			Name:        info.Path,
			Version:     info.Version,
			Root:        id == input.rootID,
			Main:        info.Main,
			Direct:      input.direct[id],
			Replaced:    replaced,
			Replacement: replacement,
			InDegree:    inDegree[id],
			OutDegree:   outDegree[id],
		})
	}

	return &Graph{
		RootID:      input.rootID,
		Nodes:       nodes,
		Edges:       filteredEdges,
		PackageInfo: buildPackageInfo(input.rootID, nodeIDs, input.modules, input.direct, input.replacements),
		Meta: GraphMeta{
			Mode:      input.mode,
			Target:    input.target,
			NodeCount: len(nodes),
			EdgeCount: len(filteredEdges),
		},
	}, nil
}

func normalizeSelectedEdge(edge Edge, selected map[string]moduleInfo, selectedByPath map[string]string) (Edge, bool) {
	if isPseudoModuleID(edge.Source) || isPseudoModuleID(edge.Target) {
		return Edge{}, false
	}
	if _, ok := selected[edge.Source]; !ok {
		return Edge{}, false
	}
	if _, ok := selected[edge.Target]; ok {
		return edge, true
	}

	targetPath, _ := splitModuleToken(edge.Target)
	selectedTarget, ok := selectedByPath[targetPath]
	if !ok {
		return Edge{}, false
	}

	edge.Target = selectedTarget
	return edge, true
}

func rewriteMainModuleID(modules map[string]moduleInfo, edges []Edge, mainID, resolvedID string) (map[string]moduleInfo, []Edge) {
	if mainID == "" || mainID == resolvedID {
		return modules, edges
	}

	rewrittenModules := make(map[string]moduleInfo, len(modules))
	for id, info := range modules {
		if id == mainID {
			_, resolvedVersion := splitModuleToken(resolvedID)
			info.Version = resolvedVersion
			rewrittenModules[resolvedID] = info
			continue
		}
		rewrittenModules[id] = info
	}

	rewrittenEdges := make([]Edge, 0, len(edges))
	for _, edge := range edges {
		if edge.Source == mainID {
			edge.Source = resolvedID
		}
		if edge.Target == mainID {
			edge.Target = resolvedID
		}
		rewrittenEdges = append(rewrittenEdges, edge)
	}

	return rewrittenModules, rewrittenEdges
}

func resolveModuleInfo(id string, modules map[string]moduleInfo, replacements []replacementRule) moduleInfo {
	if info, ok := modules[id]; ok {
		return info
	}

	path, version := splitModuleToken(id)
	info := moduleInfo{Path: path, Version: version}

	if replacement, ok := matchReplacement(path, version, replacements); ok {
		info.Replace = replacement
		if replacement.Dir != "" {
			info.Dir = replacement.Dir
		}
	}

	return info
}

func matchReplacement(path, version string, replacements []replacementRule) (*moduleInfo, bool) {
	for _, rule := range replacements {
		if rule.Path == path && rule.Version == version {
			replacement := rule.Replacement
			return &replacement, true
		}
	}

	for _, rule := range replacements {
		if rule.Path == path && rule.Version == "" {
			replacement := rule.Replacement
			return &replacement, true
		}
	}

	return nil, false
}
