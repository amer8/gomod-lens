//go:build !js || !wasm

package graph

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"path/filepath"
	"sort"
	"strings"
)

func parseModuleList(raw []byte) (map[string]moduleInfo, string, error) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	modules := make(map[string]moduleInfo)
	var mainID string

	for {
		var item moduleInfo
		if err := decoder.Decode(&item); err != nil {
			if err == io.EOF {
				break
			}
			return nil, "", fmt.Errorf("decode module list: %w", err)
		}

		id := moduleID(item.Path, item.Version)
		modules[id] = item
		if item.Main {
			mainID = id
		}
	}

	if len(modules) == 0 {
		return nil, "", fmt.Errorf("go list returned no modules")
	}

	return modules, mainID, nil
}

func parseDirectRequires(raw []byte) (map[string]bool, error) {
	return parseRequires(raw, false)
}

func parseRequires(raw []byte, includeIndirect bool) (map[string]bool, error) {
	var file modEditFile
	if err := json.Unmarshal(raw, &file); err != nil {
		return nil, fmt.Errorf("decode go.mod json: %w", err)
	}

	requires := make(map[string]bool)
	for _, req := range file.Require {
		if req.Indirect && !includeIndirect {
			continue
		}
		requires[moduleID(req.Path, req.Version)] = true
	}

	return requires, nil
}

func parseReplacements(raw []byte, dir string) ([]replacementRule, error) {
	var file modEditFile
	if err := json.Unmarshal(raw, &file); err != nil {
		return nil, fmt.Errorf("decode go.mod json: %w", err)
	}

	replacements := make([]replacementRule, 0, len(file.Replace))
	for _, replacement := range file.Replace {
		info := moduleInfo{
			Path:    replacement.New.Path,
			Version: replacement.New.Version,
		}
		if replacement.New.Version == "" && strings.TrimSpace(replacement.New.Path) != "" {
			if filepath.IsAbs(replacement.New.Path) {
				info.Dir = filepath.Clean(replacement.New.Path)
			} else {
				info.Dir = filepath.Clean(filepath.Join(dir, replacement.New.Path))
			}
		}

		replacements = append(replacements, replacementRule{
			Path:        replacement.Old.Path,
			Version:     replacement.Old.Version,
			Replacement: info,
		})
	}

	return replacements, nil
}

func parseEdges(raw []byte) ([]Edge, error) {
	scanner := bufio.NewScanner(bytes.NewReader(raw))
	seen := make(map[string]bool)
	var edges []Edge

	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}

		fields := strings.Fields(line)
		if len(fields) != 2 {
			return nil, fmt.Errorf("invalid graph line %q", line)
		}

		source := canonicalModuleToken(fields[0])
		target := canonicalModuleToken(fields[1])
		key := source + "->" + target
		if seen[key] {
			continue
		}

		seen[key] = true
		edges = append(edges, Edge{Source: source, Target: target})
	}

	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("scan graph output: %w", err)
	}

	sort.Slice(edges, func(i, j int) bool {
		if edges[i].Source == edges[j].Source {
			return edges[i].Target < edges[j].Target
		}
		return edges[i].Source < edges[j].Source
	})

	return edges, nil
}

func canonicalModuleToken(token string) string {
	name, version := splitModuleToken(token)
	return moduleID(name, version)
}

func splitModuleToken(token string) (string, string) {
	index := strings.LastIndex(token, "@")
	if index <= 0 {
		return token, ""
	}
	return token[:index], token[index+1:]
}

func moduleID(path, version string) string {
	if strings.TrimSpace(version) == "" {
		return path
	}
	return path + "@" + version
}

type moduleInfo struct {
	Path     string      `json:"Path"`
	Version  string      `json:"Version"`
	Main     bool        `json:"Main"`
	Indirect bool        `json:"Indirect"`
	Dir      string      `json:"Dir"`
	Replace  *moduleInfo `json:"Replace"`
}

type modEditFile struct {
	Require []modRequirement `json:"Require"`
	Replace []modReplace     `json:"Replace"`
}

type modRequirement struct {
	Path     string `json:"Path"`
	Version  string `json:"Version"`
	Indirect bool   `json:"Indirect"`
}

type modReplace struct {
	Old modReplaceTarget `json:"Old"`
	New modReplaceTarget `json:"New"`
}

type modReplaceTarget struct {
	Path    string `json:"Path"`
	Version string `json:"Version"`
}
