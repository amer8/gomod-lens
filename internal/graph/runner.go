//go:build !js || !wasm

package graph

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"strings"
)

// Runner executes commands for module analysis.
type Runner interface {
	Run(ctx context.Context, dir string, env []string, name string, args ...string) ([]byte, error)
}

// CommandRunner runs commands on the host system.
type CommandRunner struct{}

// Run executes a command in dir with env appended to the current process environment.
func (CommandRunner) Run(ctx context.Context, dir string, env []string, name string, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), env...)

	var output bytes.Buffer
	cmd.Stdout = &output
	cmd.Stderr = &output

	if err := cmd.Run(); err != nil {
		return nil, &CommandError{
			Command: strings.Join(append([]string{name}, args...), " "),
			Output:  strings.TrimSpace(output.String()),
			Err:     err,
		}
	}

	return output.Bytes(), nil
}

// CommandError captures a failed command, its combined output, and the cause.
type CommandError struct {
	Command string
	Output  string
	Err     error
}

// Error formats the command failure and any captured output.
func (e *CommandError) Error() string {
	if e.Output == "" {
		return fmt.Sprintf("%s: %v", e.Command, e.Err)
	}
	return fmt.Sprintf("%s: %v: %s", e.Command, e.Err, e.Output)
}

// Unwrap returns the underlying command execution error.
func (e *CommandError) Unwrap() error {
	return e.Err
}
