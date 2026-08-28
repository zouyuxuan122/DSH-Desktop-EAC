# computer-user

Codex-style **computer use** for DeepSeek Harness (DSH): read the screen and drive the
mouse & keyboard — screenshot → analyze with [picturereader] → click/type/keypress/scroll/
drag → verify. **Windows only.**

- `computer_screenshot` captures the whole virtual screen (multi-monitor, DPI-aware) to a
  PNG file and returns its path — feed it straight into picturereader's `image_scan` /
  `image_ocr` to "see" the screen with any text-only model.
- 8 more `computer_*` tools operate the mouse & keyboard through bundled PowerShell +
  Win32 `SendInput` (no native modules, no compilation, works in the DSH/EAC host process).
- A settings card (「电脑操作 / Computer Use」) puts a **mode dropdown** up front —
  disabled / read-only / manual approval (`/computer`) / automatic — with the rest
  collapsed under a default-closed **高级设置 / Advanced** section.
- **Fully local — no external API calls**: screenshot (PowerShell), analysis
  (picturereader local scan/OCR), input (Win32 SendInput). Nothing leaves the machine.
  Read the workflow in [skills/computer-use.md](skills/computer-use.md) (locate the
  target window first, then OCR inside the window, then click once and verify).
- Verified on **DeepSeek Harness EAC** desktop (same DSH host kernel as the web app).

> 中文说明见 [README.zh.md](README.zh.md)。

## Works with pure text-only models + picturereader

computer-user **does not need a multimodal model or any external vision API**. Any
**pure text-only LLM** (e.g. DeepSeek V4 Flash) can drive the desktop end-to-end:

- `computer_screenshot` dumps the screen to a local PNG (no vision needed to capture).
- **picturereader** turns that PNG into structured text the text-only model can read:
  `image_scan` (layout/colors/regions), `image_ocr` (real text), `image_sample`
  (texture), all local (Windows OCR / PaddleOCR / RapidOCR — no cloud).
- The model "sees" via those descriptions, calls `computer_click` / `computer_type` /
  … at the reported coordinates, then screenshots again to verify.

So the loop is: screenshot (computer-user) → understand (picturereader) → act
(computer-user) → verify (both) — entirely with text tokens and zero external APIs.
See [skills/computer-use.md](skills/computer-use.md) for the locate-window → in-window
OCR → click-once workflow.

## Tools

| Tool | What it does |
|---|---|
| `computer_screenshot` | Save full virtual-screen PNG (region/scale optional) → `{path,width,height,virtual_offset,scale}` |
| `computer_click` | Click at `[x,y]` (click / right_click / double_click) |
| `computer_type` | Type arbitrary UTF-16 text — CJK included — via `SendInput` Unicode |
| `computer_keypress` | Key chord, e.g. `["ctrl","c"]`, `["alt","tab"]`; letters/digits use virtual keys so shortcuts work |
| `computer_scroll` | Wheel scroll at `[x,y]`: up / down / left / right, `clicks` notches |
| `computer_drag` | Press → interpolate → release, optional `hold_keys` |
| `computer_move_mouse` | Move cursor without clicking |
| `computer_wait` | Sleep `ms` (let UI settle) |
| `computer_get_cursor_position` | Read current cursor `[x,y]` |

Coordinates are **pixels relative to the virtual-screen origin** (all monitors combined;
`computer_screenshot` returns it as `virtual_offset`). `SetProcessDPIAware` keeps
coordinates aligned with physical pixels on scaled displays.

## Install

```bash
npm install computer-user
```

or in the DSH profile:

```bash
dsh plugin --profile web add computer-user
```

Then restart DSH (or use the EAC settings → Plugins → Manage screen). The tools appear for
any session; the settings card appears under Settings → Computer Use.

### Pair with picturereader (recommended)

```text
computer_screenshot → path
picturereader image_scan / image_ocr <path>   # look
computer_click / type / ...                   # act
computer_screenshot → image_compare           # verify
```

## Settings card

The settings card (「电脑操作 / Computer Use」) uses the DSH settings-panel design
language — bordered card groups, capsule buttons, 32px inputs, chevron selects,
rotating-chevron disclosure — and guards `scope.load()` for hosts without a load
surface (EAC desktop shells).

- **Mode dropdown** at the top of the card:
  - `disabled` — every `computer_*` tool refuses.
  - `readonly` — only screenshot / cursor-read / wait are allowed.
  - `manual` — side-effecting tools need the session approved first via the `/computer`
    slash command (one approval unlocks the session for later turns).
  - `auto` — the LLM freely calls all tools.
- **AI may change mode itself** checkbox (below the dropdown, not in Advanced):
  off by default; when on, the AI can switch modes via `computer_set_mode` — changes are
  written to the same settings namespace, so the dropdown stays in sync both ways.
- **高级设置 / Advanced** (collapsed by default): screenshot output dir, default scale,
  typing interval, scroll units, **Reject code-as-text output (output guard, default on)**,
  debug logging.

**Output guard** is a host-side filter on the LLM stream: if the model writes a fake
tool-call / XML markup as *conversation text* (e.g. `computer_click({…})` or `<invoke …>`
typed out instead of a real call), that chunk is stripped and replaced with a one-time
coaching note; outputting the exact same text a second time passes through unblocked.
Turn it off in Advanced when you intentionally want code snippets in replies.

## Safety

- **Locate the target window first** (DPI-aware GetWindowRect — see
  [skills/computer-use.md](skills/computer-use.md)); desktop icons/background confuse
  both OCR and clicks. Only work inside the target window.
- Always `computer_screenshot` first and analyze it (picturereader) before acting.
- Click once, screenshot to verify; never blind click repeatedly (many UIs toggle).
- Use `manual` mode with the `/computer` command to keep a human in the loop.
- If injected input is silently dropped, check security software (some AV suites filter
  simulated input).

## Verification & known limits

- `node --test` unit suite: 39/39 green (tool registration, gates, arg validation,
  output guard).
- Real-machine safe-window smoke (throwaway window + cmd.exe, never the user's apps):
  screenshot PNG correct; cursor read/move round-trip exact; typing `hello 中文 123!`
  read back verbatim; keypress Home/End navigation + insert verified (`HEADzzzTAIL`);
  double-click word selection, click-to-clear, drag selection all asserted via control state.
- Headless integration: both `computer_screenshot` and `computer_get_cursor_position`
  called successfully by the model inside a real `dsh --profile headless` session.
- Headless real-scenario: model autonomously executed a 5-step task
  (screenshot → image_scan → type "hello" → screenshot → image_ocr) inside
  `dsh --profile headless`, coordinating picturereader and computer-user tools.
  OCR confirmed the typed text appeared on screen.
- **Wheel verified**: all 9 tools (screenshot / click / type / keypress / scroll / drag /
  move_mouse / wait / get_cursor_position) fully end-to-end verified. Wheel scroll position
  changed and MouseWheel events fired correctly. Note: always-on-top IME toolbars (e.g.
  Sogou Input floating bar) or other overlay windows can absorb wheel events if the cursor
  lands on them — move the cursor to a clear area first (same as any cursor-based input).
- EAC compatibility: loads side-by-side with picturereader in the same host; static scan of
  all built-in plugins shows zero `computer_*` / `computer-user` namespace collisions.

## Development

```text
src/capture.ps1    DPI-aware multi-monitor screenshot (System.Drawing)
src/input.ps1      SendInput mouse/keyboard backend
src/ps.js          PowerShell runner (base64 JSON, timeout, abort)
src/tools.js       the 9 computer_* tool definitions + enabled/confirm gates
src/config.js      settings namespace schema
src/index.js       plugin entry (register tools + settings, hot reload)
client.js          Web settings card (ModuleLoader bundle, zh/en)
scripts/           real-machine smoke scripts (safe-window)
tests/             node:test unit tests
```

## License

MIT
