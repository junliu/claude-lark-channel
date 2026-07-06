# Access control

The Lark channel gates **every inbound message** before it reaches Claude Code. This document
explains the model and the operator commands.

## The gate (in order, per message)

1. **Dedup** — Lark may push the same event more than once. Messages are deduplicated by
   `message_id`; repeats are dropped.
2. **Allowlist check on the SENDER** — the message is checked against the `allowed` list using the
   sender's **`open_id` (`ou_...`)**, *not* the `chat_id`.

   > Why sender, not chat: in a group, gating by room would let **anyone** in an allowlisted group
   > inject messages into Claude Code. Gating on the individual sender prevents that.

3. **Permission interception** — if the text matches `yes <id>` / `no <id>` (the `<id>` is Claude
   Code's 5-letter request id, alphabet `[a-km-z]`, no `l`), it is turned into a permission decision
   and forwarded to Claude Code, not treated as a chat message.
4. **Forward** — anything else is pushed to Claude Code as a `<channel source="lark" ...>` event.

## Policy

`<config-dir>/access.json` (default `~/.claude/channels/lark/access.json`, or `$LARK_CONFIG_DIR` if
set) holds `policy`:

- **`allowlist`** (recommended, default) — only senders in `allowed` can drive Claude Code. Strangers
  get a pairing code instead.
- **`public`** — anyone who can DM the bot can drive Claude Code. **Testing only.** Avoid this on any
  machine with real project access.

## Pairing flow

1. A stranger DMs the bot (or sends `pair`).
2. The bot replies with a short **pairing code** (6 chars, uppercase, ~15 min TTL), and records
   `pending[CODE] = { openId, chatId }`.
3. The **operator** approves it locally: `/lark:access pair <CODE>`.
4. That sender's `open_id` is added to `allowed`; the pending entry is removed.
5. The sender DMs again and is now allowed.

## Operator commands (`/lark:access`)

| Command | Effect |
| --- | --- |
| `/lark:access list` | Show policy, allowlisted open_ids, and pending codes. |
| `/lark:access pair <CODE>` | Approve a pending pairing code. |
| `/lark:access allow <open_id>` | Add a sender open_id directly. |
| `/lark:access remove <open_id>` | Remove a sender open_id. |
| `/lark:access policy <allowlist\|public>` | Set the access policy. |

## Anti-injection rule

The `/lark:access` and `/lark:configure` skills **only act when invoked directly by the local
operator in the terminal**. They must refuse if reached from channel content (anything that arrived
inside a `<channel source="lark" ...>` tag). This prevents a remote Lark user from escalating their
own access by getting Claude to "helpfully" run the command. Both skills also set
`disable-model-invocation: true` so Claude does not auto-invoke them.

## State file

`<config-dir>/access.json` (default `~/.claude/channels/lark/access.json`, or `$LARK_CONFIG_DIR`):

```jsonc
{
  "policy": "allowlist",
  "allowed": ["ou_abc123..."],
  "pending": {
    "ABC123": { "openId": "ou_...", "chatId": "oc_...", "messageId": "om_...", "ts": 1700000000000 }
  }
}
```

The running MCP server reads this at startup. After editing it (via the skill or by hand), restart
Claude Code or `/reload-plugins` if a change does not take effect.
