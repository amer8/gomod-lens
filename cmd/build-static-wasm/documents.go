package main

import (
	"bytes"
	"fmt"
	"html"
	"html/template"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

var documentPage = template.Must(template.New("document").Parse(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{{.Title}} · go.mod Lens</title>
  <link rel="stylesheet" href="./assets/legal.css">
</head>
<body>
  <header><a href="./">← go.mod Lens</a><nav aria-label="Project information"><a href="./privacy.html">Privacy</a><a href="./notices.html">Licenses and notices</a></nav></header>
  <main>{{.Body}}</main>
</body>
</html>
`))

func (b builder) publishDocuments() error {
	for _, document := range []struct{ source, target, title string }{
		{"PRIVACY.md", "privacy.html", "Privacy and external services"},
		{"THIRD_PARTY_NOTICES.md", "notices.html", "Licenses and notices"},
	} {
		source, err := os.ReadFile(filepath.Join(b.root, document.source))
		if err != nil {
			return fmt.Errorf("read public document: %w", err)
		}
		var page bytes.Buffer
		if err := documentPage.Execute(&page, struct {
			Title string
			Body  template.HTML
		}{document.title, template.HTML(documentMarkdown(string(source)))}); err != nil {
			return err
		}
		if err := os.WriteFile(filepath.Join(b.root, "dist", document.target), page.Bytes(), 0o644); err != nil {
			return err
		}
	}
	return copyFile(filepath.Join(b.root, "LICENSE"), filepath.Join(b.root, "dist", "LICENSE.txt"))
}

var documentToken = regexp.MustCompile("\\[[^]\\n]+\\]\\([^)\\n]+\\)|<https?://[^>\\s]+>|`[^`]+`|\\*\\*[^*]+\\*\\*")
var headingPunctuation = regexp.MustCompile(`[^a-z0-9]+`)

// Render the headings, paragraphs, lists and tables used by our two canonical
// documents. Escape all source text; raw HTML and executable links stay inert.
func documentMarkdown(source string) string {
	var out strings.Builder
	for _, block := range strings.Split(strings.ReplaceAll(source, "\r\n", "\n"), "\n\n") {
		block = strings.TrimSpace(block)
		if block == "" {
			continue
		}
		lines := strings.Split(block, "\n")
		switch {
		case strings.HasPrefix(block, "#"):
			for _, line := range lines {
				level := len(line) - len(strings.TrimLeft(line, "#"))
				if level < 1 || level > 6 || !strings.HasPrefix(line[level:], " ") {
					fmt.Fprintf(&out, "<p>%s</p>\n", documentInline(line))
					continue
				}
				title := strings.TrimSpace(line[level:])
				id := strings.Trim(headingPunctuation.ReplaceAllString(strings.ToLower(title), "-"), "-")
				fmt.Fprintf(&out, "<h%d id=%q>%s</h%d>\n", level, id, documentInline(title), level)
			}
		case strings.HasPrefix(block, "|"):
			out.WriteString("<div class=table-scroll><table>\n")
			for row, line := range lines {
				if row == 1 {
					continue // Markdown's column separator.
				}
				out.WriteString("<tr>")
				for _, cell := range strings.Split(strings.Trim(line, "| "), "|") {
					tag := "td"
					if row == 0 {
						tag = "th"
					}
					fmt.Fprintf(&out, "<%s>%s</%s>", tag, documentInline(strings.TrimSpace(cell)), tag)
				}
				out.WriteString("</tr>\n")
			}
			out.WriteString("</table></div>\n")
		case strings.HasPrefix(block, "- "):
			out.WriteString("<ul>\n")
			for _, line := range lines {
				fmt.Fprintf(&out, "<li>%s</li>\n", documentInline(strings.TrimPrefix(line, "- ")))
			}
			out.WriteString("</ul>\n")
		default:
			fmt.Fprintf(&out, "<p>%s</p>\n", documentInline(strings.Join(lines, " ")))
		}
	}
	return out.String()
}

func documentInline(value string) string {
	var out strings.Builder
	end := 0
	for _, match := range documentToken.FindAllStringIndex(value, -1) {
		out.WriteString(html.EscapeString(value[end:match[0]]))
		token := value[match[0]:match[1]]
		switch {
		case strings.HasPrefix(token, "`"):
			out.WriteString("<code>" + html.EscapeString(token[1:len(token)-1]) + "</code>")
		case strings.HasPrefix(token, "**"):
			out.WriteString("<strong>" + html.EscapeString(token[2:len(token)-2]) + "</strong>")
		default:
			label, target := token[1:len(token)-1], token[1:len(token)-1]
			if strings.HasPrefix(token, "[") {
				parts := strings.SplitN(token[1:len(token)-1], "](", 2)
				label, target = parts[0], parts[1]
			}
			switch {
			case target == "PRIVACY.md":
				target = "privacy.html"
			case target == "THIRD_PARTY_NOTICES.md":
				target = "notices.html"
			case target == "LICENSE":
				target = "LICENSE.txt"
			case strings.HasPrefix(target, "internal/app/web/static/"):
				target = "assets/" + strings.TrimPrefix(target, "internal/app/web/static/")
			case strings.HasPrefix(target, "docs/"):
				target = "https://github.com/amer8/gomod-lens/blob/main/" + target
			}
			parsed, err := url.Parse(target)
			if err != nil || parsed.Host != "" && parsed.Scheme == "" || parsed.Scheme != "" && parsed.Scheme != "https" && parsed.Scheme != "http" {
				out.WriteString(html.EscapeString(label))
			} else {
				fmt.Fprintf(&out, `<a href="%s">%s</a>`, html.EscapeString(target), html.EscapeString(label))
			}
		}
		end = match[1]
	}
	out.WriteString(html.EscapeString(value[end:]))
	return out.String()
}
