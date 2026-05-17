package main

import (
	"flag"
	"fmt"
	"io"
	"io/fs"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

const (
	wasmArtifact   = "dist/assets/gomod-lens.wasm"
	wasmRuntime    = "dist/assets/wasm_exec.js"
	wasmEntrypoint = "./cmd/wasm"
	vendorSource   = "internal/app/web/static/vendor"
	vendorTarget   = "dist/assets/vendor"
	mascotSource   = "internal/app/web/static/gopher-63.svg"
	mascotTarget   = "dist/assets/gopher-63.svg"
	defaultGo      = "go"
)

type builder struct {
	root       string
	goCmd      string
	goCache    string
	goModCache string
}

func main() {
	log.SetFlags(0)

	rootFlag := flag.String("root", ".", "repository root")
	goFlag := flag.String("go", getenv("GO", defaultGo), "Go command")
	flag.Parse()

	root, err := filepath.Abs(*rootFlag)
	if err != nil {
		log.Fatalf("resolve repository root: %v", err)
	}
	if err := requireFile(filepath.Join(root, "go.mod")); err != nil {
		log.Fatal(err)
	}

	b := builder{
		root:       root,
		goCmd:      *goFlag,
		goCache:    rootedPath(root, getenv("GOCACHE", filepath.Join(root, ".gocache"))),
		goModCache: rootedPath(root, getenv("GOMODCACHE", filepath.Join(root, ".gomodcache"))),
	}

	if err := b.run(); err != nil {
		log.Fatal(err)
	}
}

func (b builder) run() error {
	if err := os.MkdirAll(filepath.Join(b.root, "dist", "assets"), 0o755); err != nil {
		return fmt.Errorf("create static asset directory: %w", err)
	}
	if err := os.MkdirAll(b.goCache, 0o755); err != nil {
		return fmt.Errorf("create GOCACHE: %w", err)
	}
	if err := os.MkdirAll(b.goModCache, 0o755); err != nil {
		return fmt.Errorf("create GOMODCACHE: %w", err)
	}

	if err := b.buildWithGo(); err != nil {
		return err
	}
	if err := copyDirectory(filepath.Join(b.root, vendorSource), filepath.Join(b.root, vendorTarget)); err != nil {
		return fmt.Errorf("copy browser vendor assets: %w", err)
	}
	if err := copyFile(filepath.Join(b.root, mascotSource), filepath.Join(b.root, mascotTarget)); err != nil {
		return fmt.Errorf("copy mascot asset: %w", err)
	}
	return b.reportArtifacts()
}

func (b builder) buildWithGo() error {
	cmd := b.command(b.goCmd,
		"build",
		"-trimpath",
		"-ldflags", "-s -w",
		"-o", filepath.Join(b.root, wasmArtifact),
		wasmEntrypoint,
	)
	cmd.Env = mergeEnv(cmd.Env, map[string]string{
		"GOOS":   "js",
		"GOARCH": "wasm",
	})
	if err := runCommand(cmd); err != nil {
		return err
	}

	goRoot, err := commandOutput(b.command(b.goCmd, "env", "GOROOT"))
	if err != nil {
		return err
	}
	return copyFile(filepath.Join(strings.TrimSpace(goRoot), "lib", "wasm", "wasm_exec.js"), filepath.Join(b.root, wasmRuntime))
}

func (b builder) command(name string, args ...string) *exec.Cmd {
	cmd := exec.Command(name, args...)
	cmd.Dir = b.root
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Env = mergeEnv(os.Environ(), map[string]string{
		"GOCACHE":    b.goCache,
		"GOMODCACHE": b.goModCache,
	})
	return cmd
}

func (b builder) reportArtifacts() error {
	for _, artifact := range []string{wasmArtifact, wasmRuntime} {
		path := filepath.Join(b.root, artifact)
		info, err := os.Stat(path)
		if err != nil {
			return fmt.Errorf("stat %s: %w", artifact, err)
		}
		fmt.Printf("built %s (%s)\n", filepath.ToSlash(artifact), humanSize(info.Size()))
	}
	return nil
}

func commandOutput(cmd *exec.Cmd) (string, error) {
	cmd.Stdout = nil
	output, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("%s: %w", strings.Join(cmd.Args, " "), err)
	}
	return string(output), nil
}

func runCommand(cmd *exec.Cmd) error {
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("%s: %w", strings.Join(cmd.Args, " "), err)
	}
	return nil
}

func copyFile(source, target string) error {
	input, err := os.Open(source)
	if err != nil {
		return fmt.Errorf("open %s: %w", source, err)
	}
	defer input.Close()

	info, err := input.Stat()
	if err != nil {
		return fmt.Errorf("stat %s: %w", source, err)
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return fmt.Errorf("create %s: %w", filepath.Dir(target), err)
	}

	output, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, info.Mode().Perm())
	if err != nil {
		return fmt.Errorf("create %s: %w", target, err)
	}
	if _, err := io.Copy(output, input); err != nil {
		_ = output.Close()
		return fmt.Errorf("copy %s to %s: %w", source, target, err)
	}
	if err := output.Close(); err != nil {
		return fmt.Errorf("close %s: %w", target, err)
	}
	return nil
}

func copyDirectory(source, target string) error {
	if err := os.RemoveAll(target); err != nil {
		return fmt.Errorf("remove %s: %w", target, err)
	}

	return filepath.WalkDir(source, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}

		relative, err := filepath.Rel(source, path)
		if err != nil {
			return fmt.Errorf("resolve %s relative to %s: %w", path, source, err)
		}
		destination := filepath.Join(target, relative)

		info, err := entry.Info()
		if err != nil {
			return fmt.Errorf("stat %s: %w", path, err)
		}
		if entry.IsDir() {
			if err := os.MkdirAll(destination, info.Mode().Perm()); err != nil {
				return fmt.Errorf("create %s: %w", destination, err)
			}
			return nil
		}
		if !info.Mode().IsRegular() {
			return fmt.Errorf("unsupported vendor asset type: %s", path)
		}
		return copyFile(path, destination)
	})
}

func mergeEnv(env []string, overrides map[string]string) []string {
	indexes := make(map[string]int, len(env))
	for i, item := range env {
		key, _, ok := strings.Cut(item, "=")
		if ok {
			indexes[key] = i
		}
	}
	for key, value := range overrides {
		if index, ok := indexes[key]; ok {
			env[index] = key + "=" + value
			continue
		}
		env = append(env, key+"="+value)
	}
	return env
}

func getenv(key, fallback string) string {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	return value
}

func rootedPath(root, path string) string {
	if filepath.IsAbs(path) {
		return path
	}
	return filepath.Join(root, path)
}

func requireFile(path string) error {
	info, err := os.Stat(path)
	if err != nil {
		return fmt.Errorf("required file not found: %s", path)
	}
	if info.IsDir() {
		return fmt.Errorf("required file is a directory: %s", path)
	}
	return nil
}

func humanSize(size int64) string {
	const unit = 1024
	if size < unit {
		return fmt.Sprintf("%d B", size)
	}
	value := float64(size)
	for _, suffix := range []string{"KiB", "MiB", "GiB"} {
		value /= unit
		if value < unit {
			return fmt.Sprintf("%.1f %s", value, suffix)
		}
	}
	return fmt.Sprintf("%.1f TiB", value/unit)
}
