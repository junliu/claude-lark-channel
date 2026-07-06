# Lark channel for Claude Code

A self-built **[Channel](https://code.claude.com/docs/en/channels.md)** plugin that lets you drive
Claude Code from **Lark (Larksuite international, `open.larksuite.com`)** and receive its replies —
the same way the official Telegram / Discord channel plugins work. Anthropic ships Telegram, Discord,
and iMessage channels, but not Lark; this fills that gap.

> **Domain**: Lark international = `open.larksuite.com` (SDK `Domain.Lark`). Feishu/China =
> `open.feishu.cn` (`Domain.Feishu`). They are separate tenants — an app created on one is not
> usable on the other. This plugin targets **Lark international**.

## Features

- **Two-way messaging** — DM the bot; the message arrives in Claude Code as a `<channel>` event, and
  Claude replies back via the `reply` tool.
- **Access control** — allowlist keyed on the **sender's open_id** (not chat), with a pairing flow
  for onboarding new users.
- **Permission relay** — approve Claude's tool calls from Lark by replying `yes <id>` / `no <id>`.
- **Switchable transport** — Webhook (default, always works) or WebSocket long connection (optional,
  no public URL — if your Larksuite console exposes it).

## Requirements

- **Node.js ≥ 22.6** (uses native TypeScript stripping via `--experimental-strip-types`; no build step).
- A Lark custom app with the Bot feature enabled.

## Install

```bash
cd claude-lark-channel
npm install
```

Then load it as a plugin (dev):

```bash
claude --plugin-dir ./claude-lark-channel
# validate structure:
claude plugin validate ./claude-lark-channel
```

## Lark app setup (one-time, in the Developer Console)

1. https://open.larksuite.com/app → **Create custom app** → note **App ID** (`cli_...`) & **App Secret**.
2. **Add features → Bot** → enable.
3. **Permissions / Scopes** (minimum for DMs): `im:message.p2p_msg:readonly` + `im:message:send_as_bot`.
   Add `im:message.group_at_msg:readonly` for group @mentions.
4. **Events & Callbacks** → subscribe to `im.message.receive_v1`.
   - **Webhook (default):** Request URL = `https://<your-public-host>/webhook/event`; set an
     **Encrypt Key** and **Verification Token**.
   - **WS (optional):** if the console offers a "long connection" subscription mode, you can use it
     instead of a public URL (see caveat below).
5. **Create a version → publish** → tenant admin approves (usually self-approvable in your own tenant).

## Configure the plugin

Use the slash command (recommended), which writes `<config-dir>/.env` (default
`~/.claude/channels/lark/.env`; see the config dir below):

```
/lark:configure app_id cli_xxxxxxxx
/lark:configure app_secret xxxxxxxx
/lark:configure encrypt_key xxxxxxxx        # webhook mode
/lark:configure verify_token xxxxxxxx       # webhook mode
/lark:configure transport webhook           # or: ws
```

Or write `<config-dir>/.env` directly (see the config dir below):

```dotenv
LARK_APP_ID=cli_xxxxxxxx
LARK_APP_SECRET=xxxxxxxx
LARK_ENCRYPT_KEY=xxxxxxxx      # webhook only
LARK_VERIFY_TOKEN=xxxxxxxx     # webhook only
LARK_TRANSPORT=webhook         # webhook (default) | ws
LARK_WEBHOOK_PORT=3000         # webhook only
LARK_WEBHOOK_PATH=/webhook/event
```

### Config dir & running multiple bots

The plugin reads `.env` and `access.json` from a **config dir**:

- **Default:** `~/.claude/channels/lark/`
- **Override:** set the `LARK_CONFIG_DIR` env var. Relative paths resolve against the process CWD.
  This must be a real env var / on the launch command — it **cannot** live in `.env` (it's what
  locates `.env`).

Two things this enables:

1. **Keep config in a project repo** — point `LARK_CONFIG_DIR` at a folder in your repo. The bundled
   `.gitignore` already excludes `.env` and `access.json`, so the **App Secret and allowlist never
   get committed**. Copy `.env.example` → `.env` to start.

2. **Run several independent bots on one machine** — give each Claude Code instance its own
   `LARK_CONFIG_DIR` (its own `.env` + `access.json`):

   ```bash
   LARK_CONFIG_DIR=/path/to/bot-a claude --plugin-dir ... --dangerously-load-development-channels plugin:lark@inline
   LARK_CONFIG_DIR=/path/to/bot-b claude --plugin-dir ... --dangerously-load-development-channels plugin:lark@inline
   ```

   > **Hard constraint:** each bot must use a **different Lark app**. A single Lark app allows only
   > **one** long connection (WS) — pointing two instances at the same app makes them fight over the
   > connection and messages get dropped. One config dir → one Lark app → one instance.

## Run

The MCP server starts automatically when the plugin loads (see `.mcp.json`). For **webhook** mode,
expose the local port to the public Request URL, e.g.:

```bash
cloudflared tunnel --url http://localhost:3000
# then set the Lark Request URL to https://<tunnel-host>/webhook/event
```

To run the server standalone for a smoke test:

```bash
LARK_APP_ID=cli_xxx LARK_APP_SECRET=xxx npm start
```

## Usage

1. **DM the bot** in Lark. If you're not on the allowlist, the bot replies with a **pairing code**.
2. The operator runs `/lark:access pair <CODE>` in Claude Code to approve you.
3. DM the bot again — your message now shows up in Claude Code as
   `<channel source="lark" chat_id="oc_..." message_id="om_...">...</channel>`, and Claude replies
   back into Lark.
4. When Claude asks to run a tool, the bot forwards a permission prompt; reply `yes <id>` or
   `no <id>` from Lark to allow/deny.

Manage access anytime: `/lark:access list | pair <code> | allow <open_id> | policy <allowlist|public>`.
See [ACCESS.md](./ACCESS.md).

## Transport caveat (WS)

WebSocket long connection avoids needing a public URL, but the **Larksuite international Developer
Console may not expose the "long connection" subscription mode** for every app (community report
[openclaw #51663](https://github.com/openclaw/openclaw/issues/51663)). If `LARK_TRANSPORT=ws` errors
on connect, switch back to `webhook`. This plugin defaults to webhook for that reason.

## Project layout

```
claude-lark-channel/
├── .claude-plugin/plugin.json   # plugin metadata
├── .mcp.json                    # starts the MCP server (node --experimental-strip-types server.ts)
├── server.ts                    # entry point: wires config → client → channel → gate → transport
├── src/
│   ├── config.ts                # env/paths + inbound message type
│   ├── lark-client.ts           # send / reply via @larksuiteoapi/node-sdk
│   ├── transport.ts             # transport interface + event → LarkInboundMessage
│   ├── transport-webhook.ts     # default (Express + EventDispatcher)
│   ├── transport-ws.ts          # optional (WSClient)
│   ├── access.ts                # allowlist / pairing / policy
│   ├── permission.ts            # yes/no <id> parsing + permission_request schema
│   ├── channel.ts               # MCP channel: capability, reply tool, permission relay
│   └── gate.ts                  # dedup → allowlist → permission → forward
└── skills/
    ├── configure/SKILL.md       # /lark:configure
    └── access/SKILL.md          # /lark:access
```

## References

- Claude Code Channels: https://code.claude.com/docs/en/channels.md ·
  reference https://code.claude.com/docs/en/channels-reference.md
- Official channel plugins (Telegram/Discord): https://github.com/anthropics/claude-plugins-official
- Lark SDK: https://github.com/larksuite/node-sdk
- Lark `im.message.receive_v1`: https://open.larksuite.com/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/events/receive
