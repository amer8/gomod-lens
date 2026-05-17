//go:build !js || !wasm

package graph

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
)

func buildPackageInfo(rootID string, nodeIDs []string, modules map[string]moduleInfo, direct map[string]bool, replacements []replacementRule) PackageInfo {
	licenseCounts := make(map[string]int)
	nameCounts := make(map[string]*PackageName)
	licenseCache := make(map[string]string)

	for _, id := range nodeIDs {
		info := resolveModuleInfo(id, modules, replacements)

		licenseCounts[detectModuleLicense(info.Dir, licenseCache)]++

		entry, ok := nameCounts[info.Path]
		if !ok {
			entry = &PackageName{
				Name:   info.Path,
				Root:   id == rootID,
				Direct: direct[id],
			}
			nameCounts[info.Path] = entry
		}
		entry.Count++
		entry.Root = entry.Root || id == rootID
		entry.Direct = entry.Direct || direct[id]
	}

	licenses := make([]LicenseInfo, 0, len(licenseCounts))
	for name, count := range licenseCounts {
		licenses = append(licenses, LicenseInfo{Name: name, Count: count})
	}
	sort.Slice(licenses, func(i, j int) bool {
		if licenses[i].Count != licenses[j].Count {
			return licenses[i].Count > licenses[j].Count
		}
		if licenses[i].Name == "unknown" {
			return false
		}
		if licenses[j].Name == "unknown" {
			return true
		}
		return licenses[i].Name < licenses[j].Name
	})

	names := make([]PackageName, 0, len(nameCounts))
	for _, entry := range nameCounts {
		names = append(names, *entry)
	}
	sort.Slice(names, func(i, j int) bool {
		if names[i].Root != names[j].Root {
			return names[i].Root
		}
		if names[i].Direct != names[j].Direct {
			return names[i].Direct
		}
		if names[i].Count != names[j].Count {
			return names[i].Count > names[j].Count
		}
		return names[i].Name < names[j].Name
	})

	return PackageInfo{
		Licenses: licenses,
		Names:    names,
	}
}

func detectModuleLicense(dir string, cache map[string]string) string {
	dir = strings.TrimSpace(dir)
	if dir == "" {
		return "unknown"
	}
	if license, ok := cache[dir]; ok {
		return license
	}

	entries, err := os.ReadDir(dir)
	if err != nil {
		cache[dir] = "unknown"
		return "unknown"
	}

	candidates := make([]string, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}

		name := strings.ToUpper(entry.Name())
		if name == "LICENSE" ||
			strings.HasPrefix(name, "LICENSE.") ||
			name == "LICENCE" ||
			strings.HasPrefix(name, "LICENCE.") ||
			strings.HasPrefix(name, "COPYING") ||
			name == "UNLICENSE" ||
			strings.HasPrefix(name, "NOTICE") {
			candidates = append(candidates, filepath.Join(dir, entry.Name()))
		}
	}

	sort.Strings(candidates)
	for _, candidate := range candidates {
		raw, err := os.ReadFile(candidate)
		if err != nil {
			continue
		}
		if len(raw) > 128*1024 {
			raw = raw[:128*1024]
		}

		license := classifyLicenseText(string(raw))
		cache[dir] = license
		return license
	}

	cache[dir] = "unknown"
	return "unknown"
}

func classifyLicenseText(text string) string {
	normalized := strings.ToLower(text)
	switch {
	case strings.Contains(normalized, "spdx-license-identifier: mit"),
		strings.Contains(normalized, "permission is hereby granted, free of charge, to any person obtaining a copy"):
		return "MIT"
	case strings.Contains(normalized, "spdx-license-identifier: apache-2.0"),
		(strings.Contains(normalized, "apache license") && strings.Contains(normalized, "version 2.0")):
		return "Apache-2.0"
	case strings.Contains(normalized, "spdx-license-identifier: isc"),
		strings.Contains(normalized, "permission to use, copy, modify, and/or distribute this software for any purpose"):
		return "ISC"
	case strings.Contains(normalized, "mozilla public license") && strings.Contains(normalized, "version 2.0"):
		return "MPL-2.0"
	case strings.Contains(normalized, "gnu lesser general public license"):
		return "LGPL"
	case strings.Contains(normalized, "gnu general public license") && strings.Contains(normalized, "version 3"):
		return "GPL-3.0"
	case strings.Contains(normalized, "gnu general public license") && strings.Contains(normalized, "version 2"):
		return "GPL-2.0"
	case strings.Contains(normalized, "boost software license"):
		return "BSL-1.0"
	case strings.Contains(normalized, "creative commons zero"):
		return "CC0-1.0"
	case strings.Contains(normalized, "this is free and unencumbered software released into the public domain"):
		return "Unlicense"
	case strings.Contains(normalized, "redistribution and use in source and binary forms, with or without modification, are permitted"):
		if strings.Contains(normalized, "neither the name") {
			return "BSD-3-Clause"
		}
		return "BSD-2-Clause"
	default:
		return "unknown"
	}
}
