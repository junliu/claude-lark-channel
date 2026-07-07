// Shared config + paths for the Lark channel plugin.
// Credentials and access state live under the config dir (default ~/.claude/channels/lark/,
// overridable via LARK_CONFIG_DIR so you can keep config in a project repo or run several
// independent bots side by side — one config dir per bot/instance).
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

export const CHANNEL_NAME = 'lark';

// Base state dir. LARK_CONFIG_DIR (if set) wins — resolved relative to CWD when not absolute —
// otherwise fall back to ~/.claude/channels/lark/. Each instance pointed at a distinct dir gets
// its own .env + access.json (and must use a distinct Lark app: one app = one long connection).
function resolveStateDir(): string {
  const override = process.env.LARK_CONFIG_DIR?.trim();
  if (override) return isAbsolute(override) ? override : resolve(process.cwd(), override);
  return join(homedir(), '.claude', 'channels', CHANNEL_NAME);
}

export const STATE_DIR = resolveStateDir();
export const ENV_FILE = join(STATE_DIR, '.env');
export const ACCESS_FILE = join(STATE_DIR, 'access.json');

// Minimal .env loader (KEY=VALUE lines) — avoids a dotenv dependency.
// Values already present in process.env win, so `LARK_APP_ID=... node server.ts` overrides the file.
function loadEnvFile(path: string): void {
  if (!existsSync(path)) return;
  const text = readFileSync(path, 'utf8');
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    // Strip surrounding quotes if present.
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key && !(key in process.env)) process.env[key] = val;
  }
}

loadEnvFile(ENV_FILE);

export interface LarkConfig {
  appId: string;
  appSecret: string;
  // Webhook transport only:
  encryptKey?: string;
  verifyToken?: string;
  // 'webhook' (default) | 'ws'
  transport: 'webhook' | 'ws';
  // Webhook listen port + mount path.
  webhookPort: number;
  webhookPath: string;
}

export function loadConfig(): LarkConfig {
  const appId = process.env.LARK_APP_ID?.trim();
  const appSecret = process.env.LARK_APP_SECRET?.trim();
  if (!appId || !appSecret) {
    throw new Error(
      'Missing LARK_APP_ID / LARK_APP_SECRET. Run /lark:configure or set them in ' + ENV_FILE,
    );
  }
  const transport = (process.env.LARK_TRANSPORT?.trim() === 'ws' ? 'ws' : 'webhook') as
    | 'webhook'
    | 'ws';
  return {
    appId,
    appSecret,
    encryptKey: process.env.LARK_ENCRYPT_KEY?.trim() || undefined,
    verifyToken: process.env.LARK_VERIFY_TOKEN?.trim() || undefined,
    transport,
    webhookPort: Number(process.env.LARK_WEBHOOK_PORT?.trim() || '3000'),
    webhookPath: process.env.LARK_WEBHOOK_PATH?.trim() || '/webhook/event',
  };
}

// A single @mention parsed from a Lark message.
export interface LarkMention {
  key: string; // "@_user_N" placeholder in the raw text
  openId: string; // ou_... of the mentioned user/bot
  name?: string;
}

// Normalized inbound message handed from a transport to the gate.
export interface LarkInboundMessage {
  messageId: string; // om_...
  chatId: string; // oc_...
  chatType: 'p2p' | 'group' | string;
  senderOpenId: string; // ou_...
  senderName?: string;
  text: string; // already extracted from JSON content (with @_user_N placeholders stripped)
  mentions: LarkMention[]; // everyone @mentioned in this message (empty if none)
}

// stderr is safe for logging in a stdio MCP server (stdout is the JSON-RPC channel).
export function log(...args: unknown[]): void {
  console.error('[lark-channel]', ...args);
}
