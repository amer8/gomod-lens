package staticresolver

import (
	"context"
	"errors"
	"net/url"
	"strings"
	"sync"

	"github.com/amer8/gomod-lens/internal/graph"
)

type depsDevVersion struct {
	RelatedProjects []depsDevRelatedProject `json:"relatedProjects"`
}

type depsDevRelatedProject struct {
	ProjectKey struct {
		ID string `json:"id"`
	} `json:"projectKey"`
	RelationType string `json:"relationType"`
}

type depsDevProject struct {
	Scorecard *struct {
		OverallScore *float64 `json:"overallScore"`
		Date         string   `json:"date"`
	} `json:"scorecard"`
}

func (r *Resolver) applyOpenSSFOverlay(ctx context.Context, result *graph.Graph, progress *progressReporter) error {
	result.Meta.AddLens(graph.OpenSSFLensDefinition())

	var mu sync.Mutex
	completed := 0

	return mapLimit(ctx, result.Nodes, scoreLoadConcurrency, func(index int, node graph.Node) error {
		score, err := r.openSSFScoreForNode(ctx, node)
		if err != nil {
			return err
		}

		mu.Lock()
		graph.SetNodeOpenSSFScore(&result.Nodes[index], score)
		completed++
		offset := 16
		if len(result.Nodes) > 0 {
			offset = (completed * 16) / len(result.Nodes)
		}
		progress.Report(82+offset, "Applying OpenSSF lens")
		mu.Unlock()
		return nil
	})
}

func (r *Resolver) openSSFScoreForNode(ctx context.Context, node graph.Node) (*graph.OpenSSFScore, error) {
	module := node.Name
	version := node.Version

	if node.Replaced && node.Replacement != "" {
		replacementModule, replacementVersion := splitTargetVersion(node.Replacement)
		if isLocalReplacementTarget(replacementModule) {
			return &graph.OpenSSFScore{
				Module:  module,
				Version: version,
				Status:  "skipped",
				Error:   "local replacement",
			}, nil
		}
		module = replacementModule
		if replacementVersion != "" {
			version = replacementVersion
		}
	}

	if module == "" || version == "" {
		return &graph.OpenSSFScore{
			Module:  module,
			Version: version,
			Status:  "skipped",
			Error:   "module version is not available",
		}, nil
	}

	versionInfo, err := r.fetchDepsDevVersionWithFallback(ctx, module, version)
	if err != nil {
		return r.openSSFErrorScore(ctx, module, version, err)
	}

	projectIDs := sourceProjectIDs(module, versionInfo.RelatedProjects)
	if len(projectIDs) == 0 {
		return &graph.OpenSSFScore{
			Module:  module,
			Version: version,
			Status:  "no_project",
		}, nil
	}

	for _, projectID := range projectIDs {
		project, err := r.fetchDepsDevProject(ctx, projectID)
		if err != nil {
			if IsNotFound(err) {
				continue
			}
			return r.openSSFErrorScore(ctx, module, version, err)
		}
		if project.Scorecard != nil && project.Scorecard.OverallScore != nil {
			score := *project.Scorecard.OverallScore
			return &graph.OpenSSFScore{
				Module:    module,
				Version:   version,
				Status:    "found",
				Score:     &score,
				ProjectID: projectID,
				Date:      project.Scorecard.Date,
			}, nil
		}
	}

	return &graph.OpenSSFScore{
		Module:  module,
		Version: version,
		Status:  "no_scorecard",
	}, nil
}

func (r *Resolver) openSSFErrorScore(ctx context.Context, module, version string, err error) (*graph.OpenSSFScore, error) {
	if err != nil && errors.Is(err, context.Canceled) {
		return nil, err
	}
	if IsNotFound(err) {
		return &graph.OpenSSFScore{
			Module:  module,
			Version: version,
			Status:  "unavailable",
		}, nil
	}

	message := ""
	if err != nil {
		message = err.Error()
	}
	return &graph.OpenSSFScore{
		Module:  module,
		Version: version,
		Status:  "error",
		Error:   message,
	}, nil
}

func (r *Resolver) fetchDepsDevVersionWithFallback(ctx context.Context, modulePath, version string) (depsDevVersion, error) {
	versionInfo, err := r.fetchDepsDevVersion(ctx, modulePath, version)
	if err == nil {
		return versionInfo, nil
	}
	if IsNotFound(err) && needsIncompatible(modulePath, version) {
		return r.fetchDepsDevVersion(ctx, modulePath, version+"+incompatible")
	}
	return depsDevVersion{}, err
}

func (r *Resolver) fetchDepsDevVersion(ctx context.Context, modulePath, version string) (depsDevVersion, error) {
	key := modulePath + "@" + version
	r.mu.Lock()
	if cached, ok := r.depsDevVersionCache[key]; ok {
		r.mu.Unlock()
		return cached, nil
	}
	r.mu.Unlock()

	var payload depsDevVersion
	requestURL := depsDevBaseURL + "/systems/GO/packages/" + url.PathEscape(modulePath) + "/versions/" + url.PathEscape(version)
	if err := r.fetchJSON(ctx, requestURL, "application/json", &payload); err != nil {
		return depsDevVersion{}, err
	}

	r.mu.Lock()
	r.depsDevVersionCache[key] = payload
	r.mu.Unlock()
	return payload, nil
}

func (r *Resolver) fetchDepsDevProject(ctx context.Context, projectID string) (depsDevProject, error) {
	r.mu.Lock()
	if cached, ok := r.depsDevProjectCache[projectID]; ok {
		r.mu.Unlock()
		return cached, nil
	}
	r.mu.Unlock()

	var payload depsDevProject
	requestURL := depsDevBaseURL + "/projects/" + url.PathEscape(projectID)
	if err := r.fetchJSON(ctx, requestURL, "application/json", &payload); err != nil {
		return depsDevProject{}, err
	}

	r.mu.Lock()
	r.depsDevProjectCache[projectID] = payload
	r.mu.Unlock()
	return payload, nil
}

func sourceProjectIDs(modulePath string, relatedProjects []depsDevRelatedProject) []string {
	ids := make([]string, 0)
	for _, project := range relatedProjects {
		if project.RelationType == "SOURCE_REPO" && strings.TrimSpace(project.ProjectKey.ID) != "" {
			ids = append(ids, project.ProjectKey.ID)
		}
	}
	if len(ids) > 0 {
		return ids
	}
	return graph.InferOpenSSFProjectIDs(modulePath)
}

func needsIncompatible(modulePath, version string) bool {
	parsed := parseGoVersion(version)
	if parsed == nil || parsed.Major < 2 || strings.Contains(version, "+incompatible") {
		return false
	}
	return !strings.HasSuffix(modulePath, "/v"+itoa(parsed.Major))
}
