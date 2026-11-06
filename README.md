# @latheefwac/strapi-provider-upload-multi-cloud

A Strapi 5 upload provider with a unified interface over **AWS S3**, **Google Cloud Storage** and **Azure Blob Storage**.

## Features
- One provider, three drivers behind a common `StorageDriver` interface.
- Buffer **and** streaming uploads; object metadata; correct MIME + Cache-Control.
- Public/CDN URLs **or** signed (private) URLs — independent of filename rules.
- **Atomic, collision-safe filename allocation** (conditional writes; never `exists()`-then-`upload()`).
- Identity-first auth (IAM role / ADC / Managed Identity); static credentials optional.
- Startup config validation (zod) with actionable errors; no silent fallback between clouds.
- Exposes a shared storage core at `@latheefwac/strapi-provider-upload-multi-cloud/storage` for programmatic use.

## Provider contract
`init(providerOptions)` returns `{ upload, uploadStream, delete, checkFileSize, getSignedUrl, isPrivate }`.
Authored as `module.exports = {...}` (CommonJS) — **not** `export default`, which would compile to `module.exports.default` and break `provider.init()`.

## Usage
Register in `config/plugins.ts` under `upload.config.provider: '@latheefwac/strapi-provider-upload-multi-cloud'` with `providerOptions`. See the repo root `README.md` and `.env.example` for the full option reference and per-cloud setup.

## Scripts
```bash
npm run build       # tsc → dist (CJS + d.ts)
npm test            # vitest (67 tests; builds first)
npm run typecheck   # tsc --noEmit
```

Key design notes (collision safety, key↔url strategy, signing) are in the root `README.md` (§6, §7) and `docs/`.

MIT.
