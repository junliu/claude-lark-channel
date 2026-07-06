#!/usr/bin/env node
// Entry point for the Lark channel MCP server.
// Wires: config → LarkClient → MCP channel → access gate → transport (webhook | ws).
//
// Run: node --experimental-strip-types server.ts
// Requires Node >= 22.6 (native TypeScript stripping) and LARK_APP_ID / LARK_APP_SECRET.
import { loadConfig, log } from './src/config.ts';
import { LarkClient } from './src/lark-client.ts';
import { LarkChannelServer } from './src/channel.ts';
import { AccessStore } from './src/access.ts';
import { makeGate } from './src/gate.ts';
import { WebhookTransport } from './src/transport-webhook.ts';
import { WsTransport } from './src/transport-ws.ts';
import type { LarkTransport } from './src/transport.ts';

async function main(): Promise<void> {
  const cfg = loadConfig();
  log(`starting Lark channel (transport=${cfg.transport})`);

  const lark = new LarkClient(cfg);
  const channel = new LarkChannelServer(lark);
  const access = new AccessStore();

  // Connect the MCP stdio channel FIRST so Claude Code sees the server come up promptly.
  await channel.connect();
  log(`access policy: ${access.policy}, allowlisted senders: ${access.listAllowed().length}`);

  const gate = makeGate({ access, lark, channel, now: () => Date.now() });

  const transport: LarkTransport =
    cfg.transport === 'ws' ? new WsTransport(cfg) : new WebhookTransport(cfg);
  await transport.start(gate);

  log('Lark channel ready.');
}

main().catch((err) => {
  log('fatal:', (err as Error)?.stack ?? String(err));
  process.exit(1);
});
