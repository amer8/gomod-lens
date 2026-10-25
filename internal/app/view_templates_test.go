package app

import (
	"bytes"
	"context"
	"strings"
	"testing"
)

func TestIndexPageStartsWithCollapsedMascot(t *testing.T) {
	t.Parallel()

	var body bytes.Buffer
	if err := IndexPage().Render(context.Background(), &body); err != nil {
		t.Fatalf("Render() error = %v", err)
	}

	rendered := body.String()
	for _, want := range []string{
		`class="panel-intro">`,
		`class="attribution-toggle"`,
		`href="https://github.com/amer8/gomod-lens"`,
		`aria-label="Project information"`,
		`id="lens-toolbar" aria-label="Lens selection" hidden`,
		`id="sidebar-toggle" class="sidebar-toggle" type="button" aria-controls="left-panel" aria-expanded="true" aria-label="Hide sidebar"`,
		`src="/assets/gopher-63.svg"`,
		`aria-label="Contribute to gomod-lens on GitHub"`,
		`<span class="github-link-label">Contribute</span>`,
	} {
		if !strings.Contains(rendered, want) {
			t.Fatalf("initial page missing %q: %s", want, rendered)
		}
	}

	attributionEnd := strings.Index(rendered, "</details>")
	contributeIndex := strings.Index(rendered, `class="github-link"`)
	if contributeIndex < strings.Index(rendered, `class="attribution-content"`) || contributeIndex > attributionEnd {
		t.Fatalf("Contribute link should be inside the collapsed project information: %s", rendered)
	}

	searchIndex := strings.Index(rendered, `id="search-form"`)
	attributionIndex := strings.Index(rendered, `class="panel-intro"`)
	emptyResultIndex := strings.Index(rendered, `id="graph-result" data-state="empty"`)
	if searchIndex < 0 || attributionIndex < 0 || emptyResultIndex < 0 ||
		searchIndex > emptyResultIndex || emptyResultIndex > attributionIndex ||
		!strings.Contains(rendered[emptyResultIndex:attributionIndex], "</div>\n      </div>") {
		t.Fatalf("initial attribution should render outside and after the sidebar: %s", rendered)
	}
}

func TestShellUsesTheSameTemplateForBothDeployments(t *testing.T) {
	for _, test := range []struct {
		page            templateComponent
		runtime, prefix string
	}{{IndexPage(), "server", "/assets/"}, {StaticIndexPage(), "wasm", "./assets/"}} {
		var body bytes.Buffer
		if err := test.page.Render(context.Background(), &body); err != nil {
			t.Fatal(err)
		}
		html := body.String()
		for _, want := range []string{`data-runtime="` + test.runtime + `"`, `src="` + test.prefix + `app.js"`, `href="` + test.prefix + `main.css"`, test.prefix + `analysis/analysis.css`, test.prefix + `assistant/assistant.css`, test.prefix + `vendor/ngraph.graph.js`} {
			if !strings.Contains(html, want) {
				t.Errorf("%s shell missing %s", test.runtime, want)
			}
		}
		if strings.Contains(html, "wasm_exec.js") != (test.runtime == "wasm") || strings.Contains(html, "htmx") {
			t.Errorf("%s shell has the wrong scripts", test.runtime)
		}
	}
}
