# Security Policy

## Supported Versions

go.mod Lens is currently pre-1.0. Security fixes target `main` and the latest tagged release once releases exist.

## Reporting a Vulnerability

Please do not open a public issue with exploit details.

Use GitHub private vulnerability reporting for this repository if it is enabled. If private reporting is not available, open a minimal public issue titled "Security contact request" without sensitive details, and the maintainer can arrange a private channel.

Helpful reports include:

- affected version or commit
- reproduction steps
- impact and affected environment
- any relevant logs or screenshots

## Deployment Note

The Go server shells out to the Go toolchain and resolves remote modules. Avoid
exposing an unauthenticated server instance to the public internet without
additional request limits, network controls, and hardening.

The static GitHub Pages build does not run the Go toolchain on a server, but it
does send public module paths and versions from the visitor's browser to the Go
module mirror, deps.dev, and GitHub Search. Do not use either deployment mode
with private module paths or other sensitive identifiers.
