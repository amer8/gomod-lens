package main

import (
	"strings"
	"testing"
)

func TestPublicDocumentEscapesMarkupAndKeepsLinksInDeployment(t *testing.T) {
	body := documentMarkdown("# Privacy\n\n<script>alert('x')</script> [unsafe](javascript:alert) [remote](//evil.example/path)\n\n[Notices](THIRD_PARTY_NOTICES.md) and [license](internal/app/web/static/licenses/Go.txt).\n\n| Material | License |\n| --- | --- |\n| `runtime` | **BSD** |")
	for _, unsafe := range []string{"<script>", `href="javascript:`, `href="//evil`} {
		if strings.Contains(body, unsafe) {
			t.Errorf("unsafe document markup: %s", unsafe)
		}
	}
	for _, want := range []string{`<h1 id="privacy">`, `href="notices.html"`, `href="assets/licenses/Go.txt"`, "<th>Material</th>", "<code>runtime</code>", "<strong>BSD</strong>", "&lt;script&gt;"} {
		if !strings.Contains(body, want) {
			t.Errorf("missing document content: %s", want)
		}
	}
}
