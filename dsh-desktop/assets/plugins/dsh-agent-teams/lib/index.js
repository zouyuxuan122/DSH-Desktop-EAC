/**
 * AgentTeams for DeepSeek Harness.
 *
 * A host-plane plugin that registers the `agent_teams_*` tools and one usage
 * section into the global system prompt. After installation any session can
 * run multi-agent teamwork through natural language (e.g. "use AgentTeams to research X"):
 * the model creates a team (it becomes the captain), spawns members as
 * durable continuable subagents, breaks the goal into tasks with
 * dependencies, wakes members with messages, relays reports, and collects
 * results.
 *
 * Installation (bundle): `dsh plugin --profile <name> add @nanmicoder/dsh-agent-teams`
 * (or a local path). The bundle patch mounts this plugin row into the host
 * composition; the tools register into the shared `tools` registry and the
 * usage section into the global system prompt, so the plugin needs no realm.
 *
 * @module dsh-agent-teams
 */
import z from '@deepseek-ai/schemastery';
import { registerAgentTeamsTools } from "./tools.js";
import { installAgentTeamsGestureBoundary, registerAgentTeamsCommand } from "./command.js";
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectArchivedTeamsActivity, collectTeamsActivity } from "./snapshot.js";
/** Web-server service key candidates, newest first. */
const WEB_SERVER_KEYS = ['webServer', 'httpServer'];
/** Workspace registry service key candidates, newest first. */
const WORKSPACE_KEYS = ['workspaceRegistry', 'workspace'];
export const name = 'agent-teams';
export const inject = ['tools', 'llm', 'subagents', 'systemPrompt', 'agents'];
export const Config = z.object({
    stateDir: z.string().default('.agent-teams'),
    memberProvider: z.string().default('spawn'),
    memberModel: z.string(),
    memberMaxDepth: z.natural().default(1),
    maxMembers: z.natural().min(1).default(8),
    promptSectionOrder: z.natural().default(117),
    slashCommand: z.boolean().default(true),
});
/** The model-facing usage policy: when and how to drive AgentTeams. */
function usageSectionText(toolNames) {
    return `When the user asks to run something with AgentTeams (e.g. "use AgentTeams to do X"), or an activation message from the /agent-teams slash command arrives, you are the captain of a multi-agent team. Follow this protocol:
1. Call agent_teams_create with a team name and the goal as description. You become the captain and may lead one team at a time.
2. Call agent_teams_add_member once per role the goal needs (researcher, engineer, reviewer, ...). Members are durable subagents: they wait for your messages, then work a full turn. By default a member on your current provider/model snapshots your current reasoning effort; a member routed to a different provider or model automatically uses that target model's default effort. Never ask the user to choose these per member; only pass provider/model when the user explicitly requests a different route for that role, and reasoning_effort only when the user explicitly requests a particular effort ("default" explicitly selects the target model's default).
3. Break the goal into tasks with agent_teams_create_task and wire dependencies. Assign role-specific work when useful; unassigned ready work belongs to the shared pool. The scheduler automatically claims one ready task for each truly idle member and wakes it, including across later rounds.
4. Lead by delegation: monitor with agent_teams_status, send guidance with agent_teams_send_message, and let idle teammates execute ready work. Do not duplicate a teammate's work merely because its turn is slow. If the user requires every member to contribute or report, create one task per required contribution (or message each member directly); never wait for an unassigned member to produce work it was never given.
5. If the user explicitly asks to pause a running member, its open attempt remains parked after interruption; after answering the user, send that same member guidance with agent_teams_send_message so it continues the same attempt. Do not interrupt members for an ordinary user question that did not request a pause. If work must change owner, restart from scratch, or be taken over, call agent_teams_reassign_task first. Reassign to another idle member, retry with the same member, or use assignee=captain before doing it yourself. Reassignment revokes the old attempt and waits for that member to quiesce, preventing late results from overwriting the new attempt.
6. Tasks carry attempt_id capabilities. Members must use the current attempt_id for updates; stale-attempt errors mean ownership changed. Check status after progress notifications until every required task is terminal and every member is idle/ready; do not busy-poll or require reports from members with no assigned work.
7. Present the team's results to the user, then agent_teams_delete the team unless the user wants to keep working with it.

Tools: ${toolNames}`;
}
export function apply(ctx, config) {
    const resolved = {
        stateDir: config.stateDir ?? '.agent-teams',
        memberProvider: config.memberProvider ?? 'spawn',
        memberModel: config.memberModel,
        memberMaxDepth: config.memberMaxDepth ?? 1,
        maxMembers: config.maxMembers ?? 8,
    };
    // Provider registration is a sibling plugin's effect (`subagent-spawn` /
    // `subagent-fork` rows), which can land after this mount under the Loader's
    // concurrent activation — so capability validation happens at the first
    // member spawn (`spawnMember`), the earliest point the provider list is
    // settled, rather than here.
    const toolNames = [
        'agent_teams_create',
        'agent_teams_add_member',
        'agent_teams_remove_member',
        'agent_teams_create_task',
        'agent_teams_reassign_task',
        'agent_teams_claim_task',
        'agent_teams_update_task',
        'agent_teams_send_message',
        'agent_teams_status',
        'agent_teams_delete',
    ].join(', ');
    ctx.systemPrompt.section({
        name: 'agent-teams:usage',
        order: config.promptSectionOrder ?? 117,
        text: usageSectionText(toolNames),
    });
    registerAgentTeamsTools(ctx, resolved);
    // Deterministic activation surfaces: the closed-namespace `/agent-teams`
    // host command (surfaces in the Web GUI slash menu via the Harness
    // ui-commands client) and the plain-text gesture boundary for surfaces
    // without command adjudication (headless CLI). Both default on; a profile
    // can disable them to keep the natural-language trigger exclusive.
    //
    // `commands` is registered lazily (not a required inject): it ships in the
    // base bundle of every standard profile, but a minimal composition that
    // omits the command registry keeps the plugin fully functional — the fiber
    // never pends on it and simply never gains the slash command.
    if (config.slashCommand ?? true) {
        ctx.inject(['commands'], (commandCtx) => {
            registerAgentTeamsCommand(commandCtx);
        });
        installAgentTeamsGestureBoundary(ctx);
    }
    // The activity panel data/artwork routes need the Web server and the
    // workspace registry, which headless profiles do not mount; under
    // concurrent activation they may also bind after this plugin. Register the
    // routes lazily: try now, then on each service binding event. In a webless
    // profile the plugin stays tool-only and never blocks boot.
    let webRegistered = false;
    const registerWebSurface = () => {
        if (webRegistered)
            return;
        const webServer = (ctx.get(WEB_SERVER_KEYS[0]) ?? ctx.get(WEB_SERVER_KEYS[1]));
        const workspaceRegistry = (ctx.get(WORKSPACE_KEYS[0]) ?? ctx.get(WORKSPACE_KEYS[1]));
        if (webServer === undefined || workspaceRegistry === undefined)
            return;
        webRegistered = true;
        // Activity panel data route: the browser floater polls this for team
        // snapshots (disk truth + live subagent activity). Mirrors the Claude
        // Code desktop watcher's server-side snapshot pattern.
        ctx.effect(() => webServer.register({
            kind: 'exact',
            path: '/plugins/dsh-agent-teams/state',
            handler: async (req, res) => {
                const url = new URL(req.url ?? '/', 'http://x');
                const roots = workspaceRegistry.list().map((workspace) => ({
                    workspace: workspace.title,
                    stateRoot: join(workspace.path, resolved.stateDir),
                }));
                // ?archived=1 serves teams moved to archive/ (post-delete review).
                const snapshots = url.searchParams.get('archived') === '1'
                    ? await collectArchivedTeamsActivity(ctx, roots)
                    : await collectTeamsActivity(ctx, roots);
                const body = JSON.stringify({ teams: snapshots });
                res.writeHead(200, {
                    'content-type': 'application/json; charset=utf-8',
                    'cache-control': 'no-store',
                });
                res.end(body);
            },
        }), 'agent-teams: activity route');
        // Whale mascot artwork: serve the packaged V2 role/action images to the
        // activity panel. An explicit allowlist guards the route (no path
        // traversal); the images ship with the bundle (files: assets/).
        const artDir = fileURLToPath(new URL('../assets/agent-teams/', import.meta.url));
        const ART_ALLOWLIST = new Set([
            'team-lead-v2.png',
            'member-researcher-v2.png', 'member-engineer-v2.png',
            'member-qa-v2.png', 'member-designer-v2.png',
            'member-security-v2.png', 'member-docs-v2.png',
            'member-data-v2.png', 'member-operator-v2.png',
            'action-working-v2.png', 'action-thinking-v2.png',
            'action-reporting-v2.png', 'action-celebrating-v2.png',
            'action-sleeping-v2.png', 'action-sending-v2.png',
        ]);
        ctx.effect(() => webServer.register({
            kind: 'prefix',
            path: '/plugins/dsh-agent-teams/assets',
            handler: async (req, res) => {
                let name;
                try {
                    name = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname.split('/').pop() ?? '');
                }
                catch {
                    // Malformed percent-encoding: treat as an unknown asset, not a 400.
                    res.writeHead(404);
                    res.end();
                    return;
                }
                if (!ART_ALLOWLIST.has(name)) {
                    res.writeHead(404);
                    res.end();
                    return;
                }
                try {
                    const data = await readFile(join(artDir, name));
                    res.writeHead(200, {
                        'content-type': 'image/png',
                        'cache-control': 'public, max-age=86400',
                    });
                    res.end(data);
                }
                catch (error) {
                    ctx.logger.warn(`agent-teams: artwork read failed for ${name}: ${String(error)}`);
                    res.writeHead(404);
                    res.end();
                }
            },
        }), 'agent-teams: artwork route');
    };
    registerWebSurface();
    ctx.on('internal/service', (name) => {
        if (WEB_SERVER_KEYS.includes(name)
            || WORKSPACE_KEYS.includes(name)) {
            registerWebSurface();
        }
    });
}
