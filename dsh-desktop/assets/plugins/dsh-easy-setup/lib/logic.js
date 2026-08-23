/**
 * dsh-easy-setup — pure logic (no framework imports; unit-tested directly).
 *
 * resolvePersonaPath answers "which soul.md does the persona editor edit":
 * the user's settings.yaml override (written when the soul-md settings
 * section is edited in the Web UI) wins, then the composition layer in the
 * web profile's cordis.patch.yml, then the plain default `<home>/soul.md`.
 *
 * buildMigrationPrompt renders the instruction the one-click migration flow
 * drops into a fresh session whose workspace is a Codex / Claude Code
 * directory: the agent itself copies skills into the global skills dir,
 * appends mcp-client rows to the profile patch file, and folds memory files
 * into soul.md — every step visible in the conversation as tool calls.
 */

/** Unquote a YAML scalar ('x', "x", x). */
function scalar(value) {
	const text = String(value).trim();
	if ((text.startsWith("'") && text.endsWith("'")) || (text.startsWith('"') && text.endsWith('"'))) {
		return text.slice(1, -1);
	}
	return text;
}

/** Read `<ns>.<key>` from a flat settings.yaml (two-level: namespace + key). */
function settingsValue(text, ns, key) {
	if (!text) return undefined;
	let inNs = false;
	for (const line of text.split(/\r?\n/)) {
		if (/^\s*#/.test(line) || line.trim() === '') continue;
		if (!/^\s/.test(line)) inNs = line.trim() === `${ns}:`;
		else if (inNs) {
			const match = line.match(new RegExp(`^\\s+${key}\\s*:\\s*(.+?)\\s*$`));
			if (match) return scalar(match[1]);
		}
	}
	return undefined;
}

/** Read `config.<key>` from the cordis.patch.yml insert block whose id is `id`. */
function patchConfigValue(text, id, key) {
	if (!text) return undefined;
	const lines = text.split(/\r?\n/);
	// Split into `- insert:` blocks; blocks start at column 0 with "- insert:".
	const blocks = [];
	let current = null;
	for (const line of lines) {
		if (/^- insert:\s*$/.test(line)) {
			current = [line];
			blocks.push(current);
		} else if (current !== null) {
			// Stop collecting at the next top-level array item (any "- " at column 0).
			if (/^- /.test(line)) current = null;
			else current.push(line);
		}
	}
	for (const block of blocks) {
		const joined = block.join('\n');
		if (!new RegExp(`(^|\\n)\\s*- id:\\s*${id}\\s*(\\n|$)`).test(joined)) continue;
		const match = joined.match(new RegExp(`^\\s+${key}\\s*:\\s*(.+?)\\s*$`, 'm'));
		if (match) return scalar(match[1]);
	}
	return undefined;
}

/** True for Windows drive / POSIX absolute paths. */
function isAbsolute(p) {
	return /^([A-Za-z]:[\\/]|\/|\\\\)/.test(p);
}

/** Normalize separators to forward slashes and join onto the home. */
function under(home, p) {
	return `${String(home).replace(/[\\/]+$/, '')}/${String(p).replace(/[\\/]+/g, '/')}`;
}

/**
 * Resolve the soul.md path the persona editor should edit.
 * @param {{home: string, settingsText?: string, patchText?: string}} input
 * @returns the absolute persona file path (forward slashes).
 */
export function resolvePersonaPath({ home, settingsText = '', patchText = '' }) {
	const fromSettings = settingsValue(settingsText, 'soul-md', 'path');
	const fromPatch = patchConfigValue(patchText, 'soul-md', 'path');
	const configured = fromSettings ?? fromPatch ?? 'soul.md';
	return isAbsolute(configured) ? configured.replace(/\\/g, '/') : under(home, configured);
}

/**
 * Render the one-click migration instruction for a fresh session whose
 * workspace is the Codex / Claude Code directory to adopt. The workspace may
 * be an ordinary project folder (dot-dirs inside) OR the tool's install /
 * config dir itself (e.g. ~/.codex, ~/.claude selected directly), so every
 * scan covers both the nested dot-dir layout and the root-level layout.
 * @param {{home: string}} input the dsh home (forward slashes).
 * @returns the prompt text (Chinese; the agent works through tool calls).
 */
export function buildMigrationPrompt({ home }) {
	const h = String(home).replace(/\\/g, '/');
	return [
		'一键夺舍：请把当前工作区里另一款 AI 编程工具（Claude Code / Codex / 其他 Agents 兼容工具）的配置全部迁移到 DSH。工作区可能是普通项目目录，也可能直接是那款工具的安装/配置目录（如 ~/.codex、~/.claude 本身），两种布局都要扫。全程用工具调用完成，只读源文件、不要修改或移动任何原有文件：',
		'',
		'1) 技能（Skills）迁移',
		'   - 扫描工作区下的技能目录：.claude/skills/*/SKILL.md、.codex/skills/*/SKILL.md、.agents/skills/*/SKILL.md，以及工作区根目录的 skills/*/SKILL.md（当工作区就是 ~/.codex 或 ~/.claude 时技能就在根级 skills/ 下）（有哪些扫哪些，没有就跳过）',
		`   - 把每个技能目录完整复制到 DSH 全局技能目录 ${h}/skills/<技能名>/（目标已存在同名技能则跳过并记录）`,
		'',
		'2) MCP 服务器迁移',
		'   - 依次查找并读取：工作区下的 .mcp.json（项目级）；工作区根目录的 config.toml（Codex 全局配置，解析其中 [mcp_servers] 段）；工作区下的 .codex/config.toml；若工作区是 ~/.claude 或 ~/.codex 本身，则还要读其上级目录的 .claude.json（Claude 全局配置，解析顶层 mcpServers 字段）（有哪些读哪些）',
		`   - 把每个服务器转换为 DSH 的 MCP 插件行，追加到 ${h}/profiles/web/cordis.patch.yml 末尾（同 id 已存在则跳过）。stdio 型（有 command）格式：`,
		"       - insert:",
		'           - id: mcp-<服务器名>',
		"             name: '@deepseek-ai/dsh-mcp-client'",
		'             config:',
		'               transport: stdio',
		'               serverName: <服务器名>',
		'               command: <启动命令>',
		'               args: [<参数列表>]',
		'   - http 型（有 url 无 command）改用 transport: streamable-http 并写 url 字段',
		'',
		'3) 记忆与人设迁移',
		'   - 读取工作区下的 CLAUDE.md、AGENTS.md（含 .claude/CLAUDE.md，有哪些读哪些）',
		`   - 把内容追加到 ${h}/soul.md 末尾，先加一行一级标题「# 迁移自旧工具的记忆」，不要覆盖或改动 soul.md 已有内容`,
		'   - 注意：soul.md 会被当作提示词模板渲染，写入的内容里绝对不能出现成对双花括号定界符（变量语法，无转义）；如原文包含，改写成单花括号或文字描述',
		'',
		'4) 最后给出汇总：列出生成了哪些技能、MCP 行与记忆合并结果，跳过了什么及原因，并提醒我重启 DSH 服务后全部生效。',
	].join('\n');
}
