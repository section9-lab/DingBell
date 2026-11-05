# just-bash Workers compatibility probe

This isolated probe evaluates `just-bash` with synthetic files. It does not change the application's knowledge retrieval, citations, or outbound authorization. The probe's dependency is isolated from the production dependency graph.

From the repository root, with Node 24 and root dependencies installed:

```sh
npm ci --prefix probes/just-bash --ignore-scripts
node probes/just-bash/probe.mjs
```

The probe bundles the package's browser entry and runs it in Miniflare/workerd with `nodejs_compat`, like the current Cloudflare configuration. It checks Chinese and Russian literal matches, shell-metacharacter and option-looking query arguments, and the no-match exit status. Bundle output is created in a temporary directory and removed afterwards. The browser bundle imports `node:zlib`, so the bundler leaves that import external for the Workers compatibility runtime.

The probe also confirms that `chmod 444` does **not** prevent a shell redirect from modifying an `InMemoryFs` file. File mode metadata must not be used as a read-only authorization boundary; a separately enforced read-only filesystem or another verified design is required.

A passing probe is not production approval: it does not prove that the full Pi agent bundle builds, nor that cancellation, execution limits, tenant isolation, memory, deployment size, arbitrary agent commands, historical citations, or final send gates are correct. In particular, virtual Bash is not an OS-level security boundary. Network, host files, credentials and other Pi file tools must not become available by accident. Migrate authorization and evidence before changing the production retrieval path; do not remove legacy chunks or index data until existing executions and recovery are addressed.
