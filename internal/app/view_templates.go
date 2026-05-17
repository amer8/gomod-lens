package app

import (
	"context"
	"embed"
	"encoding/json"
	"html"
	"html/template"
	"io"
	"strings"
)

//go:embed web/templates/*.html
var templateFiles embed.FS

var viewTemplates = template.Must(template.New("view").Funcs(template.FuncMap{
	"backgroundColor": backgroundColorStyle,
}).ParseFS(templateFiles, "web/templates/*.html"))

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
	HtmxURL         string
}

type graphTemplateData struct {
	GraphViewModel
	GraphPayloadScript template.HTML
}

// IndexPage returns the component that renders the application shell.
func IndexPage() templateComponent {
	return templateComponent{render: func(_ context.Context, w io.Writer) error {
		importMapScript, err := jsonScript("ngraph-importmap", "importmap", importMap())
		if err != nil {
			return err
		}
		return viewTemplates.ExecuteTemplate(w, "index", indexTemplateData{
			ImportMapScript: importMapScript,
			HtmxURL:         htmxURL(),
		})
	}}
}

// GraphFragment returns the component that renders graph controls and payload data.
func GraphFragment(vm GraphViewModel) templateComponent {
	return templateComponent{render: func(_ context.Context, w io.Writer) error {
		payloadScript, err := jsonScript("graph-payload", "application/json", vm.Graph)
		if err != nil {
			return err
		}
		return viewTemplates.ExecuteTemplate(w, "graphFragment", graphTemplateData{
			GraphViewModel:     vm,
			GraphPayloadScript: payloadScript,
		})
	}}
}

// GraphErrorFragment returns the component that renders a graph loading error.
func GraphErrorFragment(message string) templateComponent {
	return executeTemplateComponent("graphErrorFragment", struct {
		Message string
	}{Message: message})
}

func executeTemplateComponent(name string, data any) templateComponent {
	return templateComponent{render: func(_ context.Context, w io.Writer) error {
		return viewTemplates.ExecuteTemplate(w, name, data)
	}}
}

func jsonScript(id, scriptType string, value any) (template.HTML, error) {
	raw, err := json.Marshal(value)
	if err != nil {
		return "", err
	}

	var b strings.Builder
	b.Grow(len(raw) + len(id) + len(scriptType) + 40)
	b.WriteString(`<script id="`)
	b.WriteString(html.EscapeString(id))
	b.WriteString(`"`)
	if scriptType != "" {
		b.WriteString(` type="`)
		b.WriteString(html.EscapeString(scriptType))
		b.WriteString(`"`)
	}
	b.WriteString(`>`)
	b.Write(raw)
	b.WriteString(`</script>`)
	return template.HTML(b.String()), nil
}

func backgroundColorStyle(color string) template.CSS {
	if !isHexColor(color) {
		return ""
	}
	return template.CSS("background-color: " + color)
}

func isHexColor(value string) bool {
	if len(value) != 7 || value[0] != '#' {
		return false
	}
	for _, c := range value[1:] {
		if (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F') {
			continue
		}
		return false
	}
	return true
}
