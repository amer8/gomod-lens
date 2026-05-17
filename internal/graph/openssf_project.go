package graph

import (
	"fmt"
	"strings"
)

// InferOpenSSFProjectIDs returns deps.dev project IDs likely to contain Scorecard
// data for module paths whose version metadata does not point to a source repo.
func InferOpenSSFProjectIDs(module string) []string {
	parts := strings.Split(module, "/")

	switch {
	case strings.HasPrefix(module, "github.com/"):
		if len(parts) >= 3 {
			return []string{fmt.Sprintf("github.com/%s/%s", parts[1], parts[2])}
		}
	case strings.HasPrefix(module, "gitlab.com/"):
		if len(parts) >= 3 {
			candidates := make([]string, 0, len(parts)-2)
			for i := len(parts); i >= 3; i-- {
				candidates = append(candidates, strings.Join(parts[:i], "/"))
			}
			return candidates
		}
	case strings.HasPrefix(module, "bitbucket.org/"):
		if len(parts) >= 3 {
			return []string{fmt.Sprintf("bitbucket.org/%s/%s", parts[1], parts[2])}
		}
	case strings.HasPrefix(module, "golang.org/x/"):
		if len(parts) >= 3 {
			return []string{fmt.Sprintf("github.com/golang/%s", parts[2])}
		}
	case strings.HasPrefix(module, "google.golang.org/"):
		if len(parts) >= 2 {
			switch parts[1] {
			case "grpc":
				return []string{"github.com/grpc/grpc-go"}
			case "protobuf":
				return []string{"github.com/protocolbuffers/protobuf-go"}
			case "genproto":
				return []string{"github.com/googleapis/go-genproto"}
			case "api":
				return []string{"github.com/googleapis/google-api-go-client"}
			}
		}
	case strings.HasPrefix(module, "k8s.io/"):
		if len(parts) >= 2 {
			return []string{fmt.Sprintf("github.com/kubernetes/%s", parts[1])}
		}
	case strings.HasPrefix(module, "sigs.k8s.io/"):
		if len(parts) >= 2 {
			return []string{fmt.Sprintf("github.com/kubernetes-sigs/%s", parts[1])}
		}
	case strings.HasPrefix(module, "nhooyr.io/"):
		if len(parts) >= 2 {
			if parts[1] == "websocket" {
				return []string{"github.com/coder/websocket"}
			}
			return []string{fmt.Sprintf("github.com/nhooyr/%s", parts[1])}
		}
	case strings.HasPrefix(module, "gopkg.in/"):
		if len(parts) >= 2 {
			pkgPart := trimGoPkgInVersion(parts[1])
			if len(parts) >= 3 {
				repoPart := trimGoPkgInVersion(parts[2])
				return []string{fmt.Sprintf("github.com/%s/%s", pkgPart, repoPart)}
			}
			switch pkgPart {
			case "yaml":
				return []string{"github.com/go-yaml/yaml"}
			case "check":
				return []string{"github.com/go-check/check"}
			case "ini":
				return []string{"github.com/go-ini/ini"}
			case "mgo":
				return []string{"github.com/go-mgo/mgo"}
			case "tomb":
				return []string{"github.com/go-tomb/tomb"}
			case "fsnotify":
				return []string{"github.com/fsnotify/fsnotify"}
			default:
				return []string{fmt.Sprintf("github.com/go-%s/%s", pkgPart, pkgPart)}
			}
		}
	}

	return nil
}

func trimGoPkgInVersion(part string) string {
	if index := strings.LastIndex(part, ".v"); index >= 0 {
		return part[:index]
	}
	return part
}
