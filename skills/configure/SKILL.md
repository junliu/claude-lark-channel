---
name: configure
description: Set up the Lark (Larksuite) channel — save the app credentials (App ID / App Secret / encrypt key / verify token), choose the transport, and review status. Use when the user pastes Lark app credentials, asks to configure Lark, asks "how do I set this up", or wants to check channel status.
user-invocable: true
disable-model-invocation: true
allowed-tools:
  - Read
  - Write
  - Bash(ls *)
  - Bash(mkdir *)
---

# Configure the Lark channel

You are helping the user configure the self-built **Lark (Larksuite international)** channel for
Claude Code. Credentials live in `<config-dir>/.env` (one `KEY=value` per line).

**Config dir** = `~/.claude/channels/lark/` by default, OR the value of the `LARK_CONFIG_DIR`
environment variable if it is set (used to keep config inside a project repo, or to run several
independent bots — one config dir per bot). To find the effective dir, check whether
`LARK_CONFIG_DIR` is set in the environment; if so use it (resolve relative paths against the CWD),
otherwise use `~/.claude/channels/lark/`. Everywhere below, "the config dir" means this resolved
path. NOTE: `LARK_CONFIG_DIR` itself must be a real env var / on the launch command — it cannot be
stored in `.env`, since it's what locates `.env`.

Arguments (optional): `$ARGUMENTS`

## Behavior

### No arguments — show status
1. Report the effective config dir (and whether it came from `LARK_CONFIG_DIR` or the default).
2. Read `<config-dir>/.env` if it exists.
3. Report which of these are set (show only whether present, never print secret values):
   `LARK_APP_ID`, `LARK_APP_SECRET`, `LARK_ENCRYPT_KEY`, `LARK_VERIFY_TOKEN`, `LARK_TRANSPORT`,
   `LARK_WEBHOOK_PORT`, `LARK_WEBHOOK_PATH`.
4. Read `<config-dir>/access.json` and report the current `policy` and number of
   allowlisted senders.
5. Tell the user the next steps they still need (see Setup checklist below).

### With arguments — save a value
Parse `$ARGUMENTS` as `KEY VALUE` (or a natural request like "set app id to cli_xxx"). Accept these keys:
- `app_id` → `LARK_APP_ID` (looks like `cli_...`)
- `app_secret` → `LARK_APP_SECRET`
- `encrypt_key` → `LARK_ENCRYPT_KEY`
- `verify_token` → `LARK_VERIFY_TOKEN`
- `transport` → `LARK_TRANSPORT` (must be `webhook` or `ws`)
- `webhook_port` → `LARK_WEBHOOK_PORT`
- `webhook_path` → `LARK_WEBHOOK_PATH`

Steps:
1. `mkdir -p <config-dir>` if needed.
2. Read the existing `<config-dir>/.env`, update or append the given key, and write it back (preserve other keys).
3. Confirm what was saved WITHOUT echoing secret values back.
4. Remind the user to restart Claude Code (or `/reload-plugins`) for the channel server to pick up
   the new value.

### `clear` — remove a value
If the user says `clear <key>` or `clear all`, remove that key (or all keys) from `.env`.

## Setup checklist (share this when relevant)

1. **Create the app**: https://open.larksuite.com/app → Create custom app → note **App ID** &
   **App Secret**. Add the **Bot** feature.
2. **Scopes** (minimum for DMs): `im:message.p2p_msg:readonly` + `im:message:send_as_bot`.
   For group @mentions also add `im:message.group_at_msg:readonly`.
3. **Event subscription**: subscribe to `im.message.receive_v1`.
   - **Webhook mode (default)**: set the Request URL to `https://<your-public-host><LARK_WEBHOOK_PATH>`
     (default path `/webhook/event`), set an **Encrypt Key** and **Verification Token**, and save
     those into `.env` as `LARK_ENCRYPT_KEY` / `LARK_VERIFY_TOKEN`. You need a public HTTPS URL
     (server public address, or a tunnel like `cloudflared`/`ngrok`).
   - **WS mode (optional)**: set `LARK_TRANSPORT=ws`. Only works if the app's Developer Console
     exposes a "long connection" subscription mode (not always available on Larksuite international).
4. **Publish** the app version and have the tenant admin approve it.
5. Restart Claude Code so the `lark` MCP server starts, then DM the bot to begin pairing.

## Security notes
- Never print secret values back to the chat; only report whether a key is set.
- This command edits local credential files only. It does not send anything to Lark.
