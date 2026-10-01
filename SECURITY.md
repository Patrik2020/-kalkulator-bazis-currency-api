# Security Policy

## Supported version

The current `main` branch is the supported production version.

## Reporting a vulnerability

Please do not publish exploit details in a public issue before a fix is available.

If you discover a security problem, contact the repository owner privately through the contact details published by Kalkulátor Bázis. Include:

- affected endpoint or file;
- reproduction steps;
- expected and actual behavior;
- impact assessment;
- any suggested mitigation.

## Production security baseline

The API is intentionally public and read-only. It does not rely on CORS as authentication.

Production should use:

- HTTPS at the hosting edge;
- strict CORS for browser callers;
- per-client rate limiting with trusted proxy handling;
- `DOCS_ENABLED=false` unless public API documentation is intentionally exposed;
- `TRUST_PROXY=true` only when running behind the trusted Render proxy;
- environment variables for runtime configuration; secrets must never be committed;
- dependency lockfile, automated dependency updates and CI security scanning.
