# dsh-dock-settings

Skills & MCP management for the DeepSeek Harness web GUI — a "Skills 与 MCP"
section in the settings page.

- **Skills**: lists every discovered user skill from `~/.dsh/skills` and
  `~/.agents/skills` (bundle dirs with `SKILL.md` and flat `.md` files), with
  source badges (EAC-managed vs user-owned) and an "open folder" action via
  the desktop shell bridge.
- **MCP**: table of `@deepseek-ai/dsh-mcp-client` rows in the profile's
  `cordis.patch.yml` — add / edit / toggle / delete servers (stdio and
  streamable-http forms). Saving rewrites only the MCP rows, preserving every
  other patch block verbatim, then offers a one-click web-service restart.

Host half registers `/api/dsh-dock` (`skills.list`, `mcp.list`, `mcp.save`).
MIT License.
