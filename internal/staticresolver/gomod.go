package staticresolver

import "strings"

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
}

func parseGoMod(raw string) moduleMeta {
	text := stripBlockComments(raw)
	result := moduleMeta{}
	block := ""

	for originalLine := range strings.SplitSeq(text, "\n") {
		indirect := hasIndirectComment(originalLine)
		line := strings.TrimSpace(stripLineComment(originalLine))
		if line == "" {
			continue
		}

		if line == ")" {
			block = ""
			continue
		}

		if block == "" {
			switch {
			case strings.HasPrefix(line, "module "):
				result.ModulePath = unquote(strings.TrimSpace(strings.TrimPrefix(line, "module ")))
			case strings.HasPrefix(line, "go "):
				result.GoVersion = firstGoModField(strings.TrimSpace(strings.TrimPrefix(line, "go ")))
			case line == "require (" || strings.HasPrefix(line, "require ("):
				block = "require"
			case line == "replace (" || strings.HasPrefix(line, "replace ("):
				block = "replace"
			case line == "exclude (" || strings.HasPrefix(line, "exclude ("):
				block = "exclude"
			case strings.HasPrefix(line, "require "):
				appendRequire(&result, strings.TrimSpace(strings.TrimPrefix(line, "require ")), indirect)
			case strings.HasPrefix(line, "replace "):
				appendReplace(&result, strings.TrimSpace(strings.TrimPrefix(line, "replace ")))
			case strings.HasPrefix(line, "exclude "):
				appendExclude(&result, strings.TrimSpace(strings.TrimPrefix(line, "exclude ")))
			}
			continue
		}

		switch block {
		case "require":
			appendRequire(&result, line, indirect)
		case "replace":
			appendReplace(&result, line)
		case "exclude":
			appendExclude(&result, line)
		}
	}

	return result
}

func firstGoModField(line string) string {
	fields := splitGoModFields(line)
	if len(fields) == 0 {
		return ""
	}
	return fields[0]
}

func hasIndirectComment(line string) bool {
	_, after, ok := strings.Cut(line, "//")
	if !ok {
		return false
	}
	return strings.HasPrefix(strings.TrimSpace(after), "indirect")
}

func appendRequire(result *moduleMeta, line string, indirect bool) {
	parts := splitGoModFields(line)
	if len(parts) < 2 {
		return
	}
	result.Requires = append(result.Requires, requirement{
		Path:     parts[0],
		Version:  parts[1],
		Indirect: indirect,
	})
}

func appendReplace(result *moduleMeta, line string) {
	sides := strings.Split(line, "=>")
	if len(sides) != 2 {
		return
	}

	oldParts := splitGoModFields(sides[0])
	newParts := splitGoModFields(sides[1])
	if len(oldParts) == 0 || len(newParts) == 0 {
		return
	}

	next := replacement{
		OldPath:    oldParts[0],
		OldVersion: fieldOrEmpty(oldParts, 1),
	}
	if len(newParts) == 1 && isLocalReplacementTarget(newParts[0]) {
		next.LocalPath = newParts[0]
	} else {
		next.NewPath = newParts[0]
		next.NewVersion = fieldOrEmpty(newParts, 1)
	}
	result.Replacements = append(result.Replacements, next)
}

func appendExclude(result *moduleMeta, line string) {
	parts := splitGoModFields(line)
	if len(parts) < 2 {
		return
	}
	result.Excludes = append(result.Excludes, exclusion{
		Path:    parts[0],
		Version: parts[1],
	})
}

func splitGoModFields(line string) []string {
	fields := strings.Fields(strings.TrimSpace(line))
	out := make([]string, 0, len(fields))
	for _, field := range fields {
		out = append(out, unquote(field))
	}
	return out
}

func stripBlockComments(text string) string {
	for {
		start := strings.Index(text, "/*")
		if start < 0 {
			return text
		}
		end := strings.Index(text[start+2:], "*/")
		if end < 0 {
			return text[:start]
		}
		text = text[:start] + text[start+2+end+2:]
	}
}

func stripLineComment(line string) string {
	before, _, ok := strings.Cut(line, "//")
	if !ok {
		return line
	}
	return before
}

func unquote(value string) string {
	value = strings.TrimSpace(value)
	if len(value) < 2 {
		return value
	}
	if (value[0] == '"' && value[len(value)-1] == '"') || (value[0] == '`' && value[len(value)-1] == '`') {
		return value[1 : len(value)-1]
	}
	return value
}

func fieldOrEmpty(values []string, index int) string {
	if index < 0 || index >= len(values) {
		return ""
	}
	return values[index]
}
