# Third-party notices

Generated/reviewed against `package-lock.json` on 2026-11-14. This file records direct packages and design assets; `npm run licenses:check` validates every locked installed package has declared license metadata and emits the machine-readable inventory under `dist/compliance/`. Package license files remain authoritative.

DingBell source code is licensed under [MIT](LICENSE), as approved on 2026-10-29. Dependencies retain their respective licenses. Platform adapter inventories include the independent lockfiles in `packages/agent-runtime`, `deploy/cloudflare` and `deploy/vercel`.

## Root packages

| Package | Locked version | Declared license |
| --- | ---: | --- |
| @base-ui/react | 1.8.0 | MIT |
| @dicebear/core | 10.7.0 | MIT |
| @dicebear/styles | 10.6.0 | SEE LICENSE IN LICENSE.md (Micah style: CC BY 4.0) |
| @better-auth/drizzle-adapter | 1.7.7 | MIT |
| @earendil-works/pi-ai | 1.4.0 | MIT |
| @fontsource-variable/geist | 5.3.0 | OFL-1.1 |
| @fontsource/noto-sans-sc | 5.3.0 | OFL-1.1 |
| @hono/node-server | 2.1.4 | MIT |
| @hookform/resolvers | 7.0.1 | MIT |
| @json2csv/whatwg | 7.0.8 | MIT |
| @shadcn/react | 0.3.1 | MIT |
| @tanstack/react-query | 5.104.1 | MIT |
| @valibot/to-json-schema | 1.8.0 | MIT |
| async-mutex | 0.5.0 | MIT |
| better-auth | 1.7.7 | MIT |
| class-variance-authority | 0.7.1 | Apache-2.0 |
| cn | 0.4.0 | MIT |
| csv-parse | 7.0.3 | MIT |
| drizzle-orm | 0.45.4 | Apache-2.0 |
| eventsource-parser | 3.1.1 | MIT |
| hono | 4.13.13 | MIT |
| lucide-react | 1.54.0 | ISC |
| motion | 14.8.0 | MIT |
| react / react-dom | 19.3.0 | MIT |
| react-hook-form | 7.89.0 | MIT |
| react-router | 8.4.0 | MIT |
| react-resizable-panels | 4.15.2 | MIT |
| recharts | 3.10.1 | MIT |
| valibot | 1.5.0 | MIT |
| zod | 4.6.7 | MIT |

## Direct development packages

Cloudflare Vite plugin, Workers types, Miniflare, Wrangler, Vite, React Vite plugin, Tailwind CSS tooling, shadcn CLI, Drizzle Kit, Better Auth CLI packages, TypeScript and type packages declare MIT, Apache-2.0, or `MIT OR Apache-2.0` in their locked package metadata. Playwright declares Apache-2.0. Exact names, versions, resolved integrity and transitive packages are produced by `npm run licenses:check`; do not use this summary instead of that inventory for a release review.

## Design, fonts, and icons

- UI implementation uses shadcn/ui community code and `@shadcn/react` under MIT.
- The design baseline records the Obra shadcn/ui Community Edition Figma source: <https://www.figma.com/community/file/1514746685758799870>. Its applicable community-file attribution is CC BY 4.0; retain creator/source attribution when redistributing derived design materials. The downloaded Figma/community asset is not relicensed as MIT merely because generated UI code uses shadcn.
- Geist and Noto Sans SC are bundled from Fontsource packages under SIL Open Font License 1.1.
- Lucide icons are consumed through `lucide-react` under ISC.
- Account avatars use the DiceBear **Micah** style by Micah Lanier, licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). The attribution and license link are shown in the profile settings and embedded in every rendered avatar SVG. `@dicebear/core` is MIT; the style definition is not relicensed as MIT.
- Repository design exports under `design/` may contain derived layout descriptions. Review them separately before including them in a public release archive.

## External services

Cloudflare, Ozon, NVIDIA/model providers, Resend and any object storage are external services governed by their own terms and pricing. Their SDK license does not make the service open source or free.

## Release rule

Before distribution, run the locked inventory, inspect `UNKNOWN`/custom/copyleft/license-reference results, retain required license and NOTICE text, scan the exact release archive for secrets/customer data, and preserve DingBell's approved MIT license. This document is an engineering inventory, not legal advice.

## Portable runtime adapters (2026-10-29)

Pi AI, Pi Durable and Chord 1.5.2 declare MIT. Cloudflare agents 0.33.0 declares MIT. Vercel durable-harness 0.0.2, Sandbox 3.9.1 and Functions 3.10.4 declare Apache-2.0. The generated inventory is authoritative for exact transitive versions and terms. The legacy cloud runtime and its development probes were removed on 2026-11-14.
