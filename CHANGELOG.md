# Changelog

Notable changes to DingBell. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Only `main` and the most recent release are supported. Deployment and upgrade steps live in [docs/09-self-hosting.md](docs/09-self-hosting.md) and [docs/10-upgrade-and-rollback.md](docs/10-upgrade-and-rollback.md).

## [Unreleased]

### Added

- Shared, company-scoped TanStack Query key factories, with a source-level guard that fails when a page reintroduces a bespoke key or hides the tenant inside a stringified blob.
- Biome as a lint-only quality gate (`npm run lint`), wired into `check:release`; formatting stays opt-in so reviews are not buried in reflow.
- Runtime lockfile consistency and source-boundary checks for the isolated Cloudflare, Vercel and agent-runtime installations.
- Explicit Cloudflare and Vercel dependency bridges so partner packages are reached through their published exports instead of `node_modules` paths.
- Read-only SQLite-backed knowledge view, `just-bash` discovery scaffolding and an isolated Workers compatibility probe.
- Sync retry and backoff policy extracted from the runner with boundary tests.

### Changed

- Accounting input and response contracts now use Valibot everywhere; `zod` and the zod-to-valibot bridge are gone.
- The product sourcing form uses React Hook Form with the schema as the single source of field messages.

### Fixed

- Seven invalid `aria-label` usages on elements whose role cannot be named, restored with correct roles (`group`, `region`, `status`, `img`).
- The Ozon provider timeout test no longer waits for real wall-clock time while still asserting that 7,999 ms does not expire and 8,000 ms cancels the stream.

### Performance

- Cached fixture module transpilation and batched fixture migrations (each migration keeps its own transaction); the full suite dropped from roughly 13 to 9 minutes.

## [0.1.0] - 2026-10-30

Initial public snapshot: shared TypeScript business core with Cloudflare, Vercel and self-managed Node adapters; encrypted store credentials; conversation, product and order synchronization; AI reception with budget admission and a single-attempt sender; text knowledge publication; accounting center.

[Unreleased]: https://github.com/section9-lab/DingBell/compare/main...HEAD
