package staticresolver

import (
	"fmt"
	goversion "go/version"

	"golang.org/x/mod/modfile"
)

type requirement struct {
	Path     string
	Version  string
	Indirect bool
}
type replacement struct {
	OldPath    string
	OldVersion string
	NewPath    string
	NewVersion string
	LocalPath  string
}
type exclusion struct {
	Path    string
	Version string
}
type moduleMeta struct {
	ModulePath       string
	GoVersion        string
	RequestedPath    string
	RequestedVersion string
	Requires         []requirement
	Replacements     []replacement
	Excludes         []exclusion
	SelectedPath     string
	SelectedVersion  string
	Replacement      *replacement
	Source           string
	ObservedAt       string
}

// Both graph resolution and on-demand metadata use the same Go module parser.
func parseGoMod(raw string) (moduleMeta, error) {
	file, err := modfile.Parse("go.mod", []byte(raw), nil)
	if err != nil {
		return moduleMeta{}, err
	}
	if file.Module == nil || file.Module.Mod.Path == "" {
		return moduleMeta{}, fmt.Errorf("source did not contain a module declaration")
	}
	result := moduleMeta{ModulePath: file.Module.Mod.Path}
	if file.Go != nil {
		result.GoVersion = file.Go.Version
		if !goversion.IsValid("go" + result.GoVersion) {
			return moduleMeta{}, fmt.Errorf("source contains an invalid Go minimum")
		}
	}
	for _, item := range file.Require {
		result.Requires = append(result.Requires, requirement{Path: item.Mod.Path, Version: item.Mod.Version, Indirect: item.Indirect})
	}
	for _, item := range file.Exclude {
		result.Excludes = append(result.Excludes, exclusion{Path: item.Mod.Path, Version: item.Mod.Version})
	}
	for _, item := range file.Replace {
		next := replacement{OldPath: item.Old.Path, OldVersion: item.Old.Version}
		if item.New.Version == "" {
			next.LocalPath = item.New.Path
		} else {
			next.NewPath = item.New.Path
			next.NewVersion = item.New.Version
		}
		result.Replacements = append(result.Replacements, next)
	}
	return result, nil
}
