# dsh-tdai-memory

[![中文文档](https://img.shields.io/badge/%E4%B8%AD%E6%96%87%E6%96%87%E6%A1%A3-blue)](README.zh.md)

**GitHub**: [Scorp1o117/dsh-tdai-memory](https://github.com/Scorp1o117/dsh-tdai-memory) · **npm**: [dsh-tdai-memory](https://www.npmjs.com/package/dsh-tdai-memory)

A port of **TencentDB Agent Memory** (Tencent Cloud's open-source four-layer
memory system, originally an OpenClaw plugin) into DeepSeek Harness.

## Features

- **L0 conversation capture**: every turn (turn end, request boundary) is
  written to raw conversation storage (JSONL + SQLite + FTS + vectors)
- **L1 structured memory**: a background pipeline uses an LLM to extract
  facts / preferences / events (persona / episodic / instruction) from
  conversations, stored in `records/` + SQLite + FTS + vectors
- **L2 scenes / L3 persona**: scene blocks and user profile generation
  (pipeline-scheduled)
- **Automatic recall injection**: on every prompt assembly, relevant memories
  and the user profile are retrieved by the current user message and injected
  as dynamic context (the model "just remembers")
- **Tools**: `tdai_memory_search` (L1 structured search),
  `tdai_conversation_search` (L0 raw-text search)

The data directory reuses the existing `~/.memory-tencentdb/memory-tdai`, so
**previously accumulated memories carry over seamlessly**.

## Architecture (porting approach)

| Layer | Content |
|---|---|
| Core | The host-neutral core of `tdai-memory-openclaw-plugin` (`src/core`, `src/utils`), tsc-compiled to ESM (`dist-dsh/`), zero changes |
| Host adapter | `StandaloneHostAdapter` (official standalone mode, direct OpenAI-compatible calls) |
| dsh shell | `index.js`: config mapping, `session/event` + `session/flush` capture, `system-prompt/assemble` recall injection on `agent.ctx`, tool registration, lifecycle |
| Fallback | `recall-inject.js`: preset-row recall injection (used when mounted inside an agent preset) |

Hard-won wiring details:

- **Capture**: `session/flush` listener (await semantics; must complete before
  headless exits); `turn/start` timestamps as the L0 cursor floor; turn-id dedup
- **Headless one-shot runs**: wait for `core.handleSessionEnd()` inside flush
  (L1 extraction finishes before exit; otherwise the 5s shutdown timeout kills it)
- **Recall injection**: must be registered on **`agent.ctx`** (assembly runs in
  the agent scope; root listeners never see it); attach one tick after
  `session/created` by resolving the agent from the `agents` service

## Configuration (profile patch + settings)

Configuration is **settings-namespace driven**: the profile patch is the base
layer, and the `tdai-memory:` section of `$DSH_HOME/settings.yaml` overrides it
(LLM/embedding keys live in settings.yaml). The **Web UI Settings → 记忆**
section edits every field (v0.2.0, write-only keys); TdaiCore is built at
startup, so changes apply **after a restart**.

```yaml
# $DSH_HOME/settings.yaml
tdai-memory:
  llm:
    apiKey: 'sk-...'
  embedding:
    apiKey: 'local-no-key'
```

```yaml
# profile patch (base layer)
- id: tdai-memory
  name: 'dsh-tdai-memory'
  config:
    extraction:
      enabled: true
      enableDedup: false      # dedup LLM output parsing is flaky; off by default
    llm:                      # L1/L2/L3 extraction model (OpenAI-compatible)
      baseUrl: 'https://opencode.ai/zen/go/v1'
      model: 'mimo-v2.5'      # deepseek-v4-flash produces invalid extraction JSON
    embedding:                # vectors (OpenAI-compatible /v1/embeddings)
      baseUrl: 'http://127.0.0.1:8088/v1'
      model: 'Qwen3-Embedding-0.6B'
      dimensions: 1024
      sendDimensions: false
```

## Known trade-offs

- **Extraction model**: `mimo-v2.5` extracts correctly but takes 20-30s per
  call (background execution, does not block the conversation);
  `deepseek-v4-flash` is fast but its JSON output is non-compliant (extracts 0)
- **dedup**: LLM conflict-detection output parsing is unstable (once caused
  stored=0); off by default; enable only with a more reliable model
- **L1 memory vectors**: written with storage (8088 embedding is fast); L0
  vectors run as a background task, drained by `destroy()` on headless exit
- **Upgrades**: after pulling new upstream code, rerun
  `npx tsc -p dsh-tsconfig.json` in the tdai project dir (output in `dist-dsh/`)

## License

MIT
