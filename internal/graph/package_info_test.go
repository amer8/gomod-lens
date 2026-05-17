package graph

import "testing"

func TestBuildGraphIncludesPackageInfoSummary(t *testing.T) {
	t.Parallel()

	rootDir := t.TempDir()
	directDir := t.TempDir()
	indirectDir := t.TempDir()

	mustWriteFile(t, rootDir+"/LICENSE", "Permission is hereby granted, free of charge, to any person obtaining a copy")
	mustWriteFile(t, directDir+"/LICENSE", "Apache License\nVersion 2.0, January 2004")
	mustWriteFile(t, indirectDir+"/COPYING", "Permission is hereby granted, free of charge, to any person obtaining a copy")

	graph, err := buildGraph(buildInput{
		rootID: "github.com/acme/demo",
		mode:   ModeModule,
		target: "github.com/acme/demo",
		modules: map[string]moduleInfo{
			"github.com/acme/demo": {
				Path: "github.com/acme/demo",
				Dir:  rootDir,
			},
			"github.com/spf13/cobra@v1.8.0": {
				Path:    "github.com/spf13/cobra",
				Version: "v1.8.0",
				Dir:     directDir,
			},
			"golang.org/x/sync@v0.7.0": {
				Path:    "golang.org/x/sync",
				Version: "v0.7.0",
				Dir:     indirectDir,
			},
		},
		edges: []Edge{
			{Source: "github.com/acme/demo", Target: "github.com/spf13/cobra@v1.8.0"},
			{Source: "github.com/spf13/cobra@v1.8.0", Target: "golang.org/x/sync@v0.7.0"},
		},
		direct: map[string]bool{
			"github.com/spf13/cobra@v1.8.0": true,
		},
		filterToRoot: true,
	})
	if err != nil {
		t.Fatalf("buildGraph() error = %v", err)
	}

	if len(graph.PackageInfo.Licenses) != 2 {
		t.Fatalf("licenses length = %d", len(graph.PackageInfo.Licenses))
	}
	if graph.PackageInfo.Licenses[0].Name != "MIT" || graph.PackageInfo.Licenses[0].Count != 2 {
		t.Fatalf("first license = %+v", graph.PackageInfo.Licenses[0])
	}
	if graph.PackageInfo.Licenses[1].Name != "Apache-2.0" || graph.PackageInfo.Licenses[1].Count != 1 {
		t.Fatalf("second license = %+v", graph.PackageInfo.Licenses[1])
	}

	if len(graph.PackageInfo.Names) != 3 {
		t.Fatalf("names length = %d", len(graph.PackageInfo.Names))
	}
	if !graph.PackageInfo.Names[0].Root || graph.PackageInfo.Names[0].Name != "github.com/acme/demo" {
		t.Fatalf("first package name = %+v", graph.PackageInfo.Names[0])
	}
	if !graph.PackageInfo.Names[1].Direct || graph.PackageInfo.Names[1].Name != "github.com/spf13/cobra" {
		t.Fatalf("second package name = %+v", graph.PackageInfo.Names[1])
	}
	if graph.PackageInfo.Names[2].Direct || graph.PackageInfo.Names[2].Name != "golang.org/x/sync" {
		t.Fatalf("third package name = %+v", graph.PackageInfo.Names[2])
	}
}
