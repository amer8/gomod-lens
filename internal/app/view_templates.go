package app

import (
	"context"
	"embed"
	"encoding/json"
	"html/template"
	"io"
)

//go:embed web/templates/*.html
var templateFiles embed.FS

var viewTemplates = template.Must(template.ParseFS(templateFiles, "web/templates/*.html"))

type templateComponent struct {
	render func(context.Context, io.Writer) error
}

// Render writes the component output unless the context has already been canceled.
func (c templateComponent) Render(ctx context.Context, w io.Writer) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	return c.render(ctx, w)
}

type indexTemplateData struct {
	ImportMapScript template.HTML
	AssetsPrefix    string
	Runtime         string
}

// IndexPage returns the component that renders the application shell.
func IndexPage() templateComponent {
	return indexPage("server", "/assets/")
}

// StaticIndexPage renders the same shell with deployment-relative asset URLs.
func StaticIndexPage() templateComponent {
	return indexPage("wasm", "./assets/")
}

func indexPage(runtime, prefix string) templateComponent {
	return templateComponent{render: func(_ context.Context, w io.Writer) error {
		raw, err := json.Marshal(map[string]map[string]string{
			"imports": {
				"ngraph.forcelayout": prefix + "vendor/ngraph.forcelayout.js",
				"ngraph.graph":       prefix + "vendor/ngraph.graph.js",
				"ngraph.svg":         prefix + "vendor/ngraph.svg.js",
			},
		})
		if err != nil {
			return err
		}
		return viewTemplates.ExecuteTemplate(w, "index", indexTemplateData{
			ImportMapScript: template.HTML(`<script id="ngraph-importmap" type="importmap">` + string(raw) + `</script>`),
			AssetsPrefix:    prefix,
			Runtime:         runtime,
		})
	}}
}
