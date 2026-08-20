# Third-party notices

## TencentDB Agent Memory core (vendored in `vendor/tdai`)

`vendor/tdai` is a TypeScript-compiled copy of the host-neutral core of
[TencentCloud/TencentDB-Agent-Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory)
(`tdai-memory-openclaw-plugin`, npm: `@tencentdb-agent-memory/memory-tencentdb`),
compiled with `tsc -p dsh-tsconfig.json` (see the upstream repo for source).
Its runtime dependencies are declared in this package's `dependencies`.

MIT License — Copyright (c) 2026 TencentCloud

## Runtime dependencies

- `ai` / `@ai-sdk/openai` — Vercel AI SDK (Apache-2.0)
- `@node-rs/jieba` — Rust jieba bindings (MIT)
- `sqlite-vec` — vector search extension for SQLite (Apache-2.0 / MIT)
- `json5` — JSON5 parser (MIT)
- `undici` — HTTP client (MIT)
- `@tencentdb-agent-memory/tcvdb-text` — TencentDB text utilities (MIT)
