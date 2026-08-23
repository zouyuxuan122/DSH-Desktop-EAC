<div align="center">

# OffPeak · dsh-offpeak

**Peak-hour price guard for DeepSeek API tidal pricing**

Intercept your message before it's sent during peak hours — schedule it to run when it's cheaper.

[![npm version](https://img.shields.io/npm/v/dsh-offpeak)](https://www.npmjs.com/package/dsh-offpeak)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-DeepSeek%20Harness%20Web-4c8dff)](#)

*Read this in [中文](README.zh.md)*

</div>

---

## Why

DeepSeek moved to **peak/off-peak (tidal) API pricing** effective **2026-08-17** (Beijing time):

| Period | Hours (Beijing) | Output price vs. before |
|---|---|---|
| **Peak** | 09:00–12:00, 14:00–18:00 | up to **4.5×** |
| **Off-peak** | everything else | **half of peak** |

New per-million-token rates (¥):

| Model | Item | Peak | Off-peak |
|---|---|---|---|
| **V4 Flash** | input (cache miss) | 3 | 1.5 |
| | output | 9 | 4.5 |
| | input (cache hit) | 0.1 | 0.05 |
| **V4 Pro** | input (cache miss) | 9 | 4.5 |
| | output | 27 | 13.5 |
| | input (cache hit) | 0.3 | 0.15 |

If you mostly run long tasks with DeepSeek V4 Flash, sending them at 10:00 costs **3× more** than sending them at 19:00. OffPeak makes sure you *notice* that before you press send — not after.

## What it does

While your current model is DeepSeek V4 Flash / Pro and the Beijing clock is inside a peak window, pressing **Enter** (or clicking send) in the composer **intercepts the message before it is sent**. The text stays in the input box and a dialog appears:

- **Current price card** — peak vs. off-peak per-million-token rates for the model in use
- **Continue** — sends the message now, through the normal composer path (draft clearing, queue, notices all intact)
- **Schedule** — opens a time wheel with **only off-peak hours (0–8, 18–23)**; past times are removed, and after 23:00 the wheel rolls into the next day's 0–8; minutes run **00–59**. The command text and time are recorded, and the local server **automatically submits the command to the original session when the time arrives** — no browser needed at that moment
- **Don't remind me today** — no more popups until the next Beijing midnight
- **✕** — close without sending; the draft stays in the input box

> Running commands are **never interrupted**: if a task crosses into a peak window mid-execution, nothing pops up — the reminder appears on your *next* command inside peak hours.

## Demo

![Demo](docs/demo.png)

*Screenshot placeholder — replace with your own capture.*

## Install

Requires the **web profile** (`dsh web`).

```sh
dsh plugin --profile web add dsh-offpeak
```

**Manual install** (no pnpm needed):

1. Copy the package into the shared plugin directory:
   - Windows: `%USERPROFILE%\.dsh\profiles\node_modules\dsh-offpeak`
   - macOS / Linux: `~/.dsh/profiles/node_modules/dsh-offpeak`
2. Append to `$DSH_HOME/profiles/web/cordis.patch.yml`:

   ```yaml
   - insert:
       - id: offpeak
         name: 'dsh-offpeak'
         config:
           effectiveFrom: '2026-08-17'
           debug: false
   ```

3. Restart `dsh web`.

> The plugin is **dormant before `effectiveFrom`** (2026-08-17 — the day tidal pricing starts). Set it to today's date to try it out sooner.

## How it works

```
peak hours (Beijing 09:00–12:00 / 14:00–18:00), model = V4 Flash/Pro
        │
user presses Enter / clicks send ──► composer intercepts (client-side)
        │                                message stays in the input box
        ▼
   ┌─ dialog ─────────────────────────┐
   │ prices · command preview         │
   │ [Continue]         [Schedule]    │
   │ ☐ Don't remind me today          │
   └──────────────────────────────────┘
        │                                │
   Continue                        Schedule
        │                                │
        ▼                                ▼
 native composer submit          POST /ds-offpeak/schedule
 (message sent normally)         { text, atMs, sessionId }
                                   draft cleared
                                           │
                                server timer fires at atMs
                                           ▼
                              session.prompt → original session
                              (works with the browser closed)
```

- The interception is **client-side**: a capture-phase listener watches Enter on the composer textarea and clicks on the send button, checking a locally-computed Beijing clock plus the latest server state (peak windows, model, "don't remind today").
- **IME-safe**: Enter during Chinese/Japanese composition (`isComposing`) is never intercepted.
- **Server-side fallback**: if a message reaches the host through a non-intercepted path during peak, the session-event listener raises a non-blocking reminder instead.
- Peak/off-peak judgment uses `Asia/Shanghai` wall-clock time regardless of the machine's timezone.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `effectiveFrom` | `"2026-08-17"` | Tidal-pricing start date (Beijing); plugin is dormant before it |
| `debug` | `false` | Bypass `effectiveFrom`; enables `/ds-offpeak/debug-remind` |
| `peakWindows` | `09:00–12:00, 14:00–18:00` | Peak windows in minutes (`{ start, end }`), overridable |
| `profile` | auto (`web`) | Profile that owns the state file |

## Routes

| Method | Path | Purpose |
|---|---|---|
| GET | `/ds-offpeak/state` | Status: peak? model, price table, pending reminder, wheel options, tasks |
| POST | `/ds-offpeak/ack` | Acknowledge a fallback reminder |
| POST | `/ds-offpeak/dismiss` | Don't remind today |
| POST | `/ds-offpeak/schedule` | `{ text, atMs, sessionId }` — record a scheduled execution |
| POST | `/ds-offpeak/cancel` | `{ id }` — cancel a task |
| POST | `/ds-offpeak/execute` | `{ id }` — run a task immediately |
| POST | `/ds-offpeak/debug-remind` | Simulate a peak command (debug only) |

All writes accept **same-origin POSTs only**. State and tasks persist in `$DSH_HOME/profiles/<profile>/offpeak.json`.

## Security & privacy

- Interception happens **locally in the browser**; a message is never sent anywhere except through the normal composer path when you choose Continue.
- Scheduled commands are stored **locally** and re-submitted to the **same session** by the local server.
- Prices are hardcoded from the official announcement; **no network calls, no telemetry**.

## FAQ

**Why does the hour wheel skip 12–14?** 12:00–14:00 is technically off-peak, but it sits between the two peak windows. OffPeak plays it safe and only offers clearly-safe hours (0–8, 18–23).

**Does it block subagent / queued messages?** No — only the composer's own send gesture is intercepted.

**What if I close the dialog?** Nothing is sent; the draft stays in the input box.

**Multiple tabs?** Each tab intercepts independently; "don't remind today" is server-side and shared.

## Development

```
src/index.js     server half — peak detection, fallback reminder, scheduler, persistence
client/client.js browser half — interception, dialog, time wheel (zero-dependency DOM)
```

```sh
node --check src/index.js && node --check client/client.js
```

## License

[MIT](LICENSE) © christophersmith2737
