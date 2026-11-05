# Repository package and runtime boundaries

This repository currently uses independently locked npm installation roots, not npm workspaces. The root application still owns `src/`, while `packages/agent-runtime`, `deploy/cloudflare`, `deploy/vercel`, and selected probes have separate manifests and lockfiles. This documents the current structure; it is not a claim that a workspace migration is complete.

## Why the runtimes are isolated

The legacy root development environment uses a different generation of the Agents/Pi packages from the production adapters. The three Pi runtime targets must agree on `@earendil-works/chord`, `pi-ai`, and `pi-durable`; `npm run check:runtime-dependencies` verifies exact manifest and lockfile versions across those targets. The legacy root graph is intentionally excluded, not assumed compatible.

`deploy/cloudflare/agent-dependencies.ts` and `deploy/vercel/sandbox-dependencies.ts` use their local deployment's public package exports. Application and probe code must not import files through another target's `node_modules`. `npm run check:source-boundaries` checks source imports for that specific pattern; it is not a complete architectural dependency-graph checker.

Install runtime roots sequentially with `npm run setup:runtimes`. Do not run installs/build commands which execute `npm ci` concurrently with tests using the same installation directories: `npm ci` removes and recreates `node_modules`.

## Workspace migration is outstanding

A small local experiment showed that simply adding `packages/agent-runtime` to npm workspaces while retaining its standalone lockfile breaks the current `npm ci --prefix packages/agent-runtime` installation contract. A proper migration must redesign the lockfile/install topology, package exports and runtime resolution together, then verify Node, compiled workerd, Vercel, clean installation, packaging, licensing and upgrades. Do not replace isolated installs or pin all targets to the root SDK without these checks.

Independent lockfiles remain useful for probes and platform-specific dependencies, but they also require explicit consistency checks and increase installation cost. This repository does not currently have workspace-wide task orchestration, package exports for every internal module, or automated affected-project testing.
