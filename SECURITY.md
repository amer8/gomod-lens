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

The application runs as static HTML, JavaScript and Go/WASM. It has no
application backend and does not run the Go toolchain on a server. It sends
public module paths and versions from the visitor's browser to the Go module
mirror, deps.dev, OSV and GitHub Search. Do not enter private module paths or
other sensitive identifiers. See [PRIVACY.md](PRIVACY.md) for external requests
and browser caching.
