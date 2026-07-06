// Access control: allowlist + pairing + policy, persisted to ~/.claude/channels/lark/access.json.
//
// SECURITY: the allowlist is keyed on the SENDER's open_id (ou_...), NOT chat_id. In a group,
// checking by room would let anyone in an allowlisted room inject messages. Always gate on sender.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { ACCESS_FILE, log } from './config.ts';

export type Policy = 'allowlist' | 'public';

interface AccessState {
  policy: Policy;
  allowed: string[]; // sender open_ids (ou_...)
  // pairing code -> { openId, chatId, messageId } captured when the stranger DMed the bot.
  pending: Record<string, { openId: string; chatId: string; messageId?: string; ts: number }>;
}

const DEFAULT_STATE: AccessState = { policy: 'allowlist', allowed: [], pending: {} };

// Pairing-code alphabet: uppercase letters + digits, excluding easily-confused chars (0/O/1/I/L).
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LEN = 6;
const PENDING_TTL_MS = 15 * 60 * 1000; // pairing codes expire after 15 min

export class AccessStore {
  private state: AccessState;

  constructor() {
    this.state = this.read();
  }

  private read(): AccessState {
    try {
      if (existsSync(ACCESS_FILE)) {
        const parsed = JSON.parse(readFileSync(ACCESS_FILE, 'utf8')) as Partial<AccessState>;
        return {
          policy: parsed.policy === 'public' ? 'public' : 'allowlist',
          allowed: Array.isArray(parsed.allowed) ? parsed.allowed : [],
          pending: parsed.pending ?? {},
        };
      }
    } catch (err) {
      log('failed to read access.json, starting fresh:', (err as Error)?.message);
    }
    return { ...DEFAULT_STATE };
  }

  private write(): void {
    try {
      mkdirSync(dirname(ACCESS_FILE), { recursive: true });
      writeFileSync(ACCESS_FILE, JSON.stringify(this.state, null, 2), 'utf8');
    } catch (err) {
      log('failed to write access.json:', (err as Error)?.message);
    }
  }

  get policy(): Policy {
    return this.state.policy;
  }

  setPolicy(policy: Policy): void {
    this.state.policy = policy;
    this.write();
  }

  isAllowed(openId: string): boolean {
    if (this.state.policy === 'public') return true;
    return !!openId && this.state.allowed.includes(openId);
  }

  listAllowed(): string[] {
    return [...this.state.allowed];
  }

  addAllowed(openId: string): void {
    if (openId && !this.state.allowed.includes(openId)) {
      this.state.allowed.push(openId);
      this.write();
    }
  }

  private sweepExpired(now: number): void {
    let changed = false;
    for (const [code, info] of Object.entries(this.state.pending)) {
      if (now - info.ts > PENDING_TTL_MS) {
        delete this.state.pending[code];
        changed = true;
      }
    }
    if (changed) this.write();
  }

  // Create (or reuse) a pairing code for a stranger. Returns the code to send back over Lark.
  // `now` is injected so the module stays free of ambient Date.now() calls in tests.
  createPairingCode(
    openId: string,
    chatId: string,
    messageId: string | undefined,
    now: number,
  ): string {
    this.sweepExpired(now);
    // Reuse an existing un-expired code for the same sender to avoid spamming new codes.
    for (const [code, info] of Object.entries(this.state.pending)) {
      if (info.openId === openId) {
        info.chatId = chatId;
        info.messageId = messageId;
        info.ts = now;
        this.write();
        return code;
      }
    }
    const code = this.generateCode();
    this.state.pending[code] = { openId, chatId, messageId, ts: now };
    this.write();
    return code;
  }

  private generateCode(): string {
    let code = '';
    // Rejection-free mapping via modulo is fine here (alphabet length 30, byte 0-255) — a slight
    // bias, but acceptable for a short-lived human pairing code. crypto bytes for unpredictability.
    const bytes = randomBytes(CODE_LEN);
    for (let i = 0; i < CODE_LEN; i++) {
      code += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length];
    }
    // Guard against an (astronomically unlikely) collision with an existing pending code.
    return this.state.pending[code] ? this.generateCode() : code;
  }

  // Approve a pairing code (called from /lark:access pair <code>). Returns the paired open_id,
  // or null if the code is unknown/expired.
  approvePairing(code: string, now: number): string | null {
    this.sweepExpired(now);
    const normalized = code.trim().toUpperCase();
    const info = this.state.pending[normalized];
    if (!info) return null;
    delete this.state.pending[normalized];
    this.addAllowed(info.openId); // addAllowed writes
    return info.openId;
  }
}
