import { join, resolve as pathResolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

/**
 * Build the computer_* tools. Coordinate system: pixels relative to the
 * multi-monitor VIRTUAL SCREEN ORIGIN (returned by computer_screenshot as
 * `virtual_offset`). All screen-reading/automation is delegated to bundled
 * PowerShell scripts (capture.ps1 / input.ps1) with zero native dependencies.
 *
 * @param {{runPs:(script:string,payload:object,opts?:object)=>Promise<object>, getConfig:()=>object, approvedSessions?:Set<string>, sessionId?:string, setMode?:(mode:string)=>Promise<void>}} deps
 * @returns {Array<object>} tool definitions ready for ctx.tools.register
 */

const COORD = {
  type: 'array',
  minItems: 2,
  maxItems: 2,
  items: { type: 'number' },
  description: '相对多屏虚拟屏原点的像素坐标 [x, y]（原点是 computer_screenshot 返回的 virtual_offset）',
};

const HEAD =
  '先调用 computer_screenshot 获取当前屏幕（>0.8 缩放即可），再用 picturereader 的 image_scan / image_ocr 分析，最后才执行本次操作。';

/** Tools that are always safe (no side effects on the user's desktop). */
const READONLY_TOOLS = new Set([
  'computer_screenshot',
  'computer_get_cursor_position',
  'computer_wait',
]);

const MODES = ['disabled', 'readonly', 'manual', 'auto'];

/**
 * Mode gate: decide whether a tool call is allowed based on the current mode
 * and the session's approval state.
 *
 * Returns void if allowed, or throws with `awaitingApproval=true` if
 * the user needs to approve via /computer first.
 */
function modeGate(cfg, toolName, approvedSessions, sessionId) {
  const mode = cfg.mode ?? 'manual';
  if (mode === 'disabled') {
    throw new Error('computer-user 已禁用：请在「设置 → 电脑操作」切换模式后再使用');
  }
  if (mode === 'readonly' && !READONLY_TOOLS.has(toolName)) {
    throw new Error(`computer-user 只读模式：${toolName} 不允许执行，仅截图/读光标/等待可用`);
  }
  if (mode === 'manual' && !READONLY_TOOLS.has(toolName)) {
    const approved = sessionId && approvedSessions && approvedSessions.has(sessionId);
    if (!approved) {
      const e = new Error(
        '需要批准：当前为手动批准模式。请在对话框输入 /computer 批准后重试（批准后本轮及后续轮次均可使用）。'
      );
      e.awaitingApproval = true;
      throw e;
    }
  }
  // mode === 'auto' or readonly tool or approved manual → allow
}

/**
 * Validate a mode value against the allowed enum.
 * @returns the validated mode string.
 */
function validateMode(value) {
  if (typeof value !== 'string' || !MODES.includes(value)) {
    throw new Error(`computer_set_mode: mode 必须是 ${MODES.join('/')} 之一`);
  }
  return value;
}

function textOut(schema, prefixLines) {
  const props = schema.properties ?? {};
  const required = (schema.required ?? []).filter((k) => k in props);
  return {
    schema: { type: 'object', additionalProperties: true, properties: props, required },
    render: (_args, value) => {
      const head = prefixLines === undefined ? [] : (typeof prefixLines === 'function' ? prefixLines(value) : prefixLines);
      const lines = [...head];
      if (value && typeof value === 'object') {
        for (const [k, v] of Object.entries(value)) {
          if (k === 'ok') continue;
          if (v === undefined || v === null) continue;
          lines.push(`${k}: ${JSON.stringify(v)}`);
        }
      }
      return [{ type: 'text', text: lines.join('\n') }];
    },
  };
}

export function createComputerTools({ runPs, getConfig, approvedSessions, sessionId, setMode }) {
  if (typeof runPs !== 'function') throw new Error('computer-user: runPs is required');
  if (typeof getConfig !== 'function') throw new Error('computer-user: getConfig is required');

  const gate = (toolName) => modeGate(getConfig(), toolName, approvedSessions, sessionId);

  // -- computer_screenshot ---------------------------------------------------
  const computerScreenshot = {
    name: 'computer_screenshot',
    description: [
      'Capture the whole virtual screen (all monitors) to a PNG file and return its path, so ' +
      'picturereader\'s image_scan / image_ocr can analyze it (the look step of computer use).',
      `${HEAD}`,
      'Parameters: path (optional — where to save; when empty a unique file is written under the configured screenshot_dir, defaulting to the OS temp dir), region (optional [x0,y0,x1,y1] fractions in 0..1 to capture a sub-area), scale (optional 0.1..1 to downscale the saved image).',
      'Returns { path, width, height, virtual_offset:[x,y], scale }. virtual_offset is the virtual-screen origin you must add to a monitor\'s local pixel when targeting that monitor.',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: true,
      properties: {
        path: { type: 'string', description: 'Optional absolute or cwd-relative output path for the PNG. When empty a unique file is created under the configured screenshot_dir (default: OS temp).' },
        region: { type: 'array', minItems: 4, maxItems: 4, items: { type: 'number' }, description: 'Optional [x0, y0, x1, y1] fractions (0..1) to capture only a sub-area of the virtual screen.' },
        scale: { type: 'number', description: 'Optional 0.1..1 downscale for the saved image (default: the configured default_scale, 1 = full resolution).' },
      },
      required: [],
    },
    output: textOut({
      required: ['path', 'width', 'height', 'virtual_offset', 'scale'],
    }, ['screenshot saved (feed path to picturereader image_scan / image_ocr)']),
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      gate('computer_screenshot');
      if (exec?.signal?.aborted) throw new Error('computer_screenshot: cancelled');
      const cfg = getConfig();
      const cwd = exec?.agent?.session?.header?.cwd ?? process.cwd();
      const dir = cfg.screenshot_dir?.trim() ? pathResolve(cwd, cfg.screenshot_dir) : join(tmpdir(), 'computer-user');
      const outPath = args && args.path
        ? pathResolve(cwd, String(args.path))
        : join(dir, `shot-${Date.now()}-${randomBytes(4).toString('hex')}.png`);
      const payload = {
        outPath,
        region: Array.isArray(args?.region) && args.region.length === 4 ? args.region : undefined,
        scale: typeof args?.scale === 'number' ? args.scale : cfg.default_scale,
      };
      return runPs('capture.ps1', payload, { signal: exec?.signal });
    },
  };

  // -- side-effecting tools --------------------------------------------------
  const computerClick = {
    name: 'computer_click',
    description: [`Click at a coordinate. ${HEAD}`, 'Parameters: coordinate (required [x,y] pixels, relative to the virtual-screen origin), action (optional: click [default] | right_click | double_click).', 'Returns the clicked coordinate.'],
    parameters: {
      type: 'object', additionalProperties: true,
      properties: {
        coordinate: { ...COORD, description: 'Relative to virtual-screen origin from computer_screenshot.virtual_offset.' },
        action: { type: 'string', enum: ['click', 'right_click', 'double_click'], description: 'Default click.' },
      },
      required: ['coordinate'],
    },
    output: textOut({ required: ['clicked'] }),
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      gate('computer_click');
      const res = await runPs('input.ps1', { action: 'click', coordinate: args.coordinate, action2: args.action ?? 'click' }, { signal: exec?.signal });
      return { clicked: res.cursor };
    },
  };

  const computerType = {
    name: 'computer_type',
    description: [`Type arbitrary UTF-16 text (supports Chinese) at the current focus. ${HEAD}`, 'Parameters: text (required string), send_enter (optional bool — press Enter after typing).', 'Input uses SendInput KEYEVENTF_UNICODE, so any character, including CJK, is entered reliably.' ],
    parameters: {
      type: 'object', additionalProperties: true,
      properties: { text: { type: 'string' }, send_enter: { type: 'boolean' } },
      required: ['text'],
    },
    output: textOut({ required: ['chars'] }),
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      gate('computer_type');
      const cfg = getConfig();
      const res = await runPs('input.ps1', {
        action: 'type', text: String(args.text), sendEnter: !!args.send_enter,
        typingIntervalMs: cfg.typing_interval_ms || 0,
      }, { signal: exec?.signal });
      return { chars: res.chars };
    },
  };

  const computerKeypress = {
    name: 'computer_keypress',
    description: [`Send a key chord (e.g. ["ctrl","c"], ["alt","tab"]). ${HEAD}`, 'Parameters: keys (required array of key names: ctrl/control, shift, alt, super/win/cmd, enter, tab, esc, space, backspace, delete, home, end, pageup, pagedown, up/down/left/right, f1..f24, single letters/digits, or single punctuation chars).'],
    parameters: {
      type: 'object', additionalProperties: true,
      properties: { keys: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Key names pressed together (modifiers first).' } },
      required: ['keys'],
    },
    output: textOut({ required: ['keys'] }),
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      gate('computer_keypress');
      const res = await runPs('input.ps1', { action: 'keypress', keys: args.keys }, { signal: exec?.signal });
      return { keys: res.keys };
    },
  };

  const computerScroll = {
    name: 'computer_scroll',
    description: [`Scroll at a coordinate. ${HEAD}`, 'Parameters: coordinate (required [x,y]), direction (optional: down [default] | up | left | right), clicks (optional number of wheel notches, default from config scroll_units).'],
    parameters: {
      type: 'object', additionalProperties: true,
      properties: {
        coordinate: COORD,
        direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
        clicks: { type: 'number' },
      },
      required: ['coordinate'],
    },
    output: textOut({ required: ['scrolled'] }),
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      gate('computer_scroll');
      const cfg = getConfig();
      const clicks = typeof args.clicks === 'number' && args.clicks > 0 ? args.clicks : (cfg.scroll_units || 1);
      await runPs('input.ps1', { action: 'scroll', coordinate: args.coordinate, direction: args.direction ?? 'down', clicks }, { signal: exec?.signal });
      return { scrolled: `${args.direction ?? 'down'} ${clicks} tick(s) at [${args.coordinate}]` };
    },
  };

  const computerDrag = {
    name: 'computer_drag',
    description: [`Drag from start to end (press, interpolate, release). ${HEAD}`, 'Parameters: start_coordinate (required [x,y]), end_coordinate (required [x,y]), hold_keys (optional array, e.g. ["shift"] pressed while dragging).'],
    parameters: {
      type: 'object', additionalProperties: true,
      properties: {
        start_coordinate: COORD,
        end_coordinate: COORD,
        hold_keys: { type: 'array', items: { type: 'string' } },
      },
      required: ['start_coordinate', 'end_coordinate'],
    },
    output: textOut({ required: ['from', 'to'] }),
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      gate('computer_drag');
      const res = await runPs('input.ps1', { action: 'drag', from: args.start_coordinate, to: args.end_coordinate, holdKeys: args.hold_keys ?? [] }, { signal: exec?.signal });
      return { from: res.from, to: res.to };
    },
  };

  const computerMoveMouse = {
    name: 'computer_move_mouse',
    description: [`Move the mouse cursor to a coordinate (without clicking). ${HEAD}`, 'Parameters: coordinate (required [x,y]).', 'Use computer_get_cursor_position to read the resulting position.'],
    parameters: {
      type: 'object', additionalProperties: true,
      properties: { coordinate: COORD },
      required: ['coordinate'],
    },
    output: textOut({ required: ['moved_to'] }),
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      gate('computer_move_mouse');
      const res = await runPs('input.ps1', { action: 'move', coordinate: args.coordinate }, { signal: exec?.signal });
      return { moved_to: res.cursor };
    },
  };

  const computerWait = {
    name: 'computer_wait',
    description: ['Wait for a short period (e.g. let a UI animation settle). No side effects.', 'Parameters: ms (required, duration in milliseconds).'],
    parameters: { type: 'object', additionalProperties: true, properties: { ms: { type: 'number' } }, required: ['ms'] },
    output: textOut({ required: ['waited'] }),
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      gate('computer_wait');
      const ms = Math.max(0, Number(args.ms) || 0);
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, ms);
        exec?.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('computer_wait: cancelled')); }, { once: true });
      });
      return { waited: ms };
    },
  };

  const computerGetCursorPosition = {
    name: 'computer_get_cursor_position',
    description: ['Read the current mouse cursor position as virtual-screen pixels [x, y].', 'Useful to verify the result of computer_move_mouse / computer_click. No side effects.'],
    parameters: { type: 'object', additionalProperties: true, properties: {}, required: [] },
    output: textOut({ required: ['x', 'y'] }),
    isConcurrencySafe: () => false,
    async execute(_args, exec) {
      gate('computer_get_cursor_position');
      const res = await runPs('input.ps1', { action: 'getpos' }, { signal: exec?.signal });
      return { x: res.cursor[0], y: res.cursor[1] };
    },
  };

  // -- computer_set_mode: AI may change the runtime mode (if enabled) -------
  const computerSetMode = {
    name: 'computer_set_mode',
    description: [
      'Change the runtime mode to one of: disabled / readonly / manual / auto.',
      'Only works when the setting「AI 可自行修改运行模式」(ai_can_change_mode) is on; otherwise this tool refuses.',
      'Settings card dropdown stays in sync: the new mode is written to the computer-user settings namespace (same store the dropdown reads).',
      'Parameters: mode (required, one of disabled/readonly/manual/auto).',
    ].join(' '),
    parameters: {
      type: 'object', additionalProperties: true,
      properties: {
        mode: { type: 'string', enum: MODES, description: '目标运行模式：disabled/readonly/manual/auto' },
      },
      required: ['mode'],
    },
    output: textOut({ required: ['mode', 'changed_by'] }),
    isConcurrencySafe: () => false,
    async execute(args, _exec) {
      if (typeof setMode !== 'function') throw new Error('computer_set_mode: 设置服务不可用');
      const cfg = getConfig();
      if (cfg.mode === 'disabled') {
        throw new Error('computer-user 已禁用：无法在禁用模式下修改运行模式（需用户在设置中先解除禁用）');
      }
      if (cfg.ai_can_change_mode !== true) {
        throw new Error('computer_set_mode: 当前未允许 AI 修改运行模式（设置「AI 可自行修改运行模式」未开启）');
      }
      const mode = validateMode(args.mode);
      await setMode(mode);
      return { mode, changed_by: 'ai' };
    },
  };

  const tools = [
    computerScreenshot,
    computerClick,
    computerType,
    computerKeypress,
    computerScroll,
    computerDrag,
    computerMoveMouse,
    computerWait,
    computerGetCursorPosition,
    computerSetMode,
  ];

  for (const tool of tools) {
    if (Array.isArray(tool.description)) tool.description = tool.description.join(' ');
  }

  return tools;
}

export default createComputerTools;
