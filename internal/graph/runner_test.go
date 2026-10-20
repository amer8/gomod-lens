package graph

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"
)

func TestCommandRunnerKeepsDiagnosticsOutOfSuccessfulJSON(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	for _, mode := range []string{"success", "failure"} {
		output, err := (CommandRunner{}).Run(context.Background(), t.TempDir(), []string{"GOMOD_LENS_RUNNER_FIXTURE=" + mode}, executable, "-test.run=^TestCommandRunnerOutputFixture$")
		if mode == "success" {
			if err != nil || string(output) != "{\"Path\":\"example.org/root\"}\n" {
				t.Fatalf("successful JSON was corrupted by diagnostics: %q, %v", output, err)
			}
			continue
		}
		var commandError *CommandError
		if !errors.As(err, &commandError) || !strings.Contains(commandError.Output, "example.org/root") || !strings.Contains(commandError.Output, "diagnostic") {
			t.Fatalf("command failure lost its output: %v", err)
		}
	}
}

func TestCommandRunnerOutputFixture(t *testing.T) {
	mode := os.Getenv("GOMOD_LENS_RUNNER_FIXTURE")
	if mode != "success" && mode != "failure" {
		return
	}
	fmt.Fprintln(os.Stdout, `{"Path":"example.org/root"}`)
	fmt.Fprintln(os.Stderr, "diagnostic")
	if mode == "failure" {
		os.Exit(1)
	}
	os.Exit(0)
}
