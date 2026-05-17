package graph

const (
	// ModeAuto lets the analyzer choose local or module analysis from the target.
	ModeAuto = "auto"
	// ModeLocal analyzes a local module or workspace path.
	ModeLocal = "local"
	// ModeModule analyzes a public module path resolved through Go tooling.
	ModeModule = "module"

	// LensOpenSSF identifies the built-in OpenSSF Scorecard lens.
	LensOpenSSF = "openssf"
	// LensReleaseFreshness identifies the built-in release freshness lens.
	LensReleaseFreshness = "release-freshness"

	// OverlayOpenSSF marks graphs enriched with OpenSSF Scorecard data.
	//
	// Deprecated: use LensOpenSSF and GraphMeta.Lenses for new lens-aware code.
	OverlayOpenSSF = "openssf"
)

// Request describes the dependency graph analysis to run.
type Request struct {
	Target string
	Mode   string
}

// Graph is the dependency graph and summary metadata returned by analysis.
type Graph struct {
	RootID      string      `json:"rootId"`
	Nodes       []Node      `json:"nodes"`
	Edges       []Edge      `json:"edges"`
	Meta        GraphMeta   `json:"meta"`
	PackageInfo PackageInfo `json:"packageInfo"`
}

// GraphMeta summarizes how a dependency graph was produced.
type GraphMeta struct {
	Mode      string           `json:"mode"`
	Target    string           `json:"target"`
	Overlay   string           `json:"overlay,omitempty"`
	Lenses    []LensDefinition `json:"lenses,omitempty"`
	NodeCount int              `json:"nodeCount"`
	EdgeCount int              `json:"edgeCount"`
}

// Node represents a module version in the dependency graph.
type Node struct {
	ID          string        `json:"id"`
	Name        string        `json:"name"`
	Version     string        `json:"version,omitempty"`
	Root        bool          `json:"root"`
	Main        bool          `json:"main"`
	Direct      bool          `json:"direct"`
	Replaced    bool          `json:"replaced"`
	Replacement string        `json:"replacement,omitempty"`
	InDegree    int           `json:"inDegree"`
	OutDegree   int           `json:"outDegree"`
	Lenses      LensResults   `json:"lenses,omitempty"`
	OpenSSF     *OpenSSFScore `json:"openssf,omitempty"`
}

// LensDefinition describes a graph analysis lens available on a graph.
type LensDefinition struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
}

// LensResults stores per-node lens results by lens ID.
type LensResults map[string]LensResult

// LensResult is the generic, per-node output of a graph lens.
type LensResult struct {
	Status  string            `json:"status"`
	Score   *float64          `json:"score,omitempty"`
	Message string            `json:"message,omitempty"`
	Details map[string]string `json:"details,omitempty"`
}

// OpenSSFScore describes the Scorecard lookup result for a module version.
type OpenSSFScore struct {
	Module    string   `json:"module,omitempty"`
	Version   string   `json:"version,omitempty"`
	Status    string   `json:"status"`
	Score     *float64 `json:"score,omitempty"`
	ProjectID string   `json:"projectId,omitempty"`
	Date      string   `json:"date,omitempty"`
	Error     string   `json:"error,omitempty"`
}

// Edge represents a directed dependency from Source to Target.
type Edge struct {
	Source string `json:"source"`
	Target string `json:"target"`
}

// PackageInfo summarizes package names and licenses in a graph.
type PackageInfo struct {
	Licenses []LicenseInfo `json:"licenses"`
	Names    []PackageName `json:"names"`
}

// LicenseInfo counts modules whose license detection produced Name.
type LicenseInfo struct {
	Name  string `json:"name"`
	Count int    `json:"count"`
}

// PackageName counts selected module versions for a package path.
type PackageName struct {
	Name   string `json:"name"`
	Count  int    `json:"count"`
	Root   bool   `json:"root"`
	Direct bool   `json:"direct"`
}
