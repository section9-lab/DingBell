# Security policy

DingBell handles store API credentials, customer conversations and outbound message authority. Please report security problems privately; do not open a public issue.

## Reporting a vulnerability

Use GitHub's **private vulnerability reporting** ("Security" → "Advisories" → "Report a vulnerability") on this repository. If that is unavailable, open an issue that contains **no** exploit details and ask the maintainers for a private channel.

Please include the affected version or commit, the deployment target (Cloudflare, Vercel, self-managed Node), reproduction steps with synthetic data, and the impact you believe it has.

Maintainers will acknowledge the report, agree on a disclosure window, and credit reporters who want attribution. Please do not access other tenants' data, run destructive tests against infrastructure you do not own, or test against real customer accounts.

## Supported versions

Only the `main` branch and the most recent release receive fixes. Forked or modified deployments are supported through documentation, not security patches applied to private variants.

## In scope

- Authentication, session handling, invitations, membership and role enforcement
- Tenant, company, store and product isolation, including late authorization checks
- Encryption of store credentials and model connections, and secret leakage into logs, browser assets or build output
- Outbound message authority: duplicate sends, replay after unknown outcomes, prompt-injected tool use
- Knowledge publication, citation and retrieval authorization
- Migration and upgrade paths that could drop, rewrite or expose business records
- Dependency, build-supply-chain and release-script integrity

## Out of scope

- Vulnerabilities in Ozon, a model provider, Cloudflare, Vercel or another third party. Report those upstream.
- Model answer quality, factual accuracy or hallucination when every authorization control behaved correctly. These are product-quality issues; use the normal issue tracker.
- Findings that require a compromised operating system, browser extension, or operator who has already been granted the deployment secrets.
- Denial of service based only on unbounded local test tooling.

## Known boundaries

The project documents, rather than hides, its limits. Treat the following as design constraints, not newly discovered bugs, unless you can show an authorization or data-loss impact:

- Virtual Bash (`just-bash`) is a simulated shell over an in-memory copy of published knowledge. It is not an OS or container security boundary, and file modes are not an authorization mechanism.
- Local synthetic tests do not establish real Ozon delivery, provider pricing, model quality or cloud capacity.
- Seeded demo data, `.dev.vars.example` and probe fixtures are not production secrets.

See [production hardening boundaries](docs/16-production-hardening.md) and [repository package boundaries](docs/18-monorepo.md) for the current evidence limits.
