package app

import (
	"bytes"
	"context"
	"strings"
	"testing"

	"github.com/amer8/gomod-lens/internal/graph"
)

func TestGraphFragmentEscapesPayloadScript(t *testing.T) {
	t.Parallel()

	g := graph.Graph{
		RootID: `example.com/root`,
		Nodes: []graph.Node{{
			ID:      `example.com/root`,
			Name:    `</script><img src=x onerror=alert(1)>`,
			Root:    true,
			OpenSSF: &graph.OpenSSFScore{Status: "skipped"},
		}},
		Meta: graph.GraphMeta{
			Mode:   graph.ModeModule,
			Target: `example.com/root?x="bad"`,
		},
	}

	var body bytes.Buffer
	if err := GraphFragment(newGraphViewModel(g)).Render(context.Background(), &body); err != nil {
		t.Fatalf("Render() error = %v", err)
	}

	rendered := body.String()
	if strings.Contains(rendered, `</script><img`) {
		t.Fatalf("payload included raw script terminator: %s", rendered)
	}
	if !strings.Contains(rendered, `\u003c/script\u003e`) {
		t.Fatalf("payload did not contain escaped script terminator: %s", rendered)
	}
	if strings.Count(rendered, `</script>`) != 1 {
		t.Fatalf("script terminator count = %d, body = %s", strings.Count(rendered, `</script>`), rendered)
	}
	if !strings.Contains(rendered, `data-target="example.com/root?x=&#34;bad&#34;"`) {
		t.Fatalf("target attribute was not escaped: %s", rendered)
	}
	if !strings.Contains(rendered, `style="background-color: #8b95a7"`) {
		t.Fatalf("score swatch style missing or over-escaped: %s", rendered)
	}
	if !strings.Contains(rendered, `<h4>Lenses</h4>`) || !strings.Contains(rendered, `OpenSSF Scorecard`) {
		t.Fatalf("lens panel missing: %s", rendered)
	}
	lensesIndex := strings.Index(rendered, `<h4>Lenses</h4>`)
	relationIndex := strings.Index(rendered, `<h4>Relation groups</h4>`)
	originsIndex := strings.Index(rendered, `<h4>Module origins</h4>`)
	hubsIndex := strings.Index(rendered, `<h4>Dependency hubs</h4>`)
	if lensesIndex < 0 || relationIndex < 0 || originsIndex < 0 ||
		hubsIndex < 0 || lensesIndex > relationIndex || relationIndex > originsIndex || originsIndex > hubsIndex {
		t.Fatalf("sidebar section order should be lenses, relation groups, module origins, dependency hubs: %s", rendered)
	}
	if strings.Contains(rendered, `<h4>Modules</h4>`) {
		t.Fatalf("sidebar should use Dependency hubs heading instead of Modules: %s", rendered)
	}
	for _, want := range []string{
		`class="lens-circle lens-circle-openssf lens-circle-active"`,
		`data-lens-panel-target="openssf"`,
		`aria-current="true"`,
		`href="https://github.com/amer8/gomod-lens/blob/main/CONTRIBUTING.md#adding-lenses"`,
		`aria-label="Learn how to add a lens"`,
	} {
		if !strings.Contains(rendered, want) {
			t.Fatalf("lens switcher missing %q: %s", want, rendered)
		}
	}
}

func TestGraphErrorFragmentEscapesMessage(t *testing.T) {
	t.Parallel()

	var body bytes.Buffer
	if err := GraphErrorFragment(`bad " <tag>`).Render(context.Background(), &body); err != nil {
		t.Fatalf("Render() error = %v", err)
	}

	rendered := body.String()
	if strings.Contains(rendered, `<tag>`) {
		t.Fatalf("message was not escaped: %s", rendered)
	}
	if !strings.Contains(rendered, `data-error="bad &#34; &lt;tag&gt;"`) {
		t.Fatalf("escaped message missing: %s", rendered)
	}
}

func TestIndexPageShowsLinkedMascotOnInitialLoad(t *testing.T) {
	t.Parallel()

	var body bytes.Buffer
	if err := IndexPage().Render(context.Background(), &body); err != nil {
		t.Fatalf("Render() error = %v", err)
	}

	rendered := body.String()
	for _, want := range []string{
		`class="panel-intro"`,
		`class="attribution-mascot-link"`,
		`href="https://github.com/amer8/gomod-lens"`,
		`aria-label="Open gomod-lens repository on GitHub"`,
		`src="/assets/gopher-63.svg"`,
		`aria-label="Contribute to gomod-lens on GitHub"`,
		`<span class="github-link-label">Contribute</span>`,
	} {
		if !strings.Contains(rendered, want) {
			t.Fatalf("initial page missing %q: %s", want, rendered)
		}
	}

	searchIndex := strings.Index(rendered, `id="search-form"`)
	attributionIndex := strings.Index(rendered, `class="panel-intro"`)
	emptyResultIndex := strings.Index(rendered, `id="graph-result" data-state="empty"`)
	if searchIndex < 0 || attributionIndex < 0 || emptyResultIndex < 0 ||
		searchIndex > attributionIndex || attributionIndex > emptyResultIndex {
		t.Fatalf("initial attribution should render between search and empty graph result: %s", rendered)
	}
}

func TestGraphFragmentShowsRelationGroupsBelowPersistentPanelIntro(t *testing.T) {
	t.Parallel()

	g := graph.Graph{
		RootID: `example.com/root`,
		Nodes: []graph.Node{{
			ID:   `example.com/root`,
			Name: `example.com/root`,
			Root: true,
		}},
		Meta: graph.GraphMeta{
			Mode:   graph.ModeModule,
			Target: `example.com/root`,
		},
	}

	var body bytes.Buffer
	if err := GraphFragment(newGraphViewModel(g)).Render(context.Background(), &body); err != nil {
		t.Fatalf("Render() error = %v", err)
	}

	rendered := body.String()
	if strings.Contains(rendered, `class="attribution-mascot-link"`) {
		t.Fatalf("graph fragment should not duplicate persistent attribution block: %s", rendered)
	}
	if !strings.Contains(rendered, `<h4>Relation groups</h4>`) {
		t.Fatalf("relation groups heading missing: %s", rendered)
	}
}
