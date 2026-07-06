// The gate decides what happens to each inbound Lark message, in order:
//   1. dedup by message_id (Lark may push duplicates)
//   2. allowlist check on SENDER open_id (pairing offered to strangers)
//   3. permission reply "yes/no <id>" interception
//   4. otherwise, forward to Claude as a channel message
import { log, type LarkInboundMessage } from './config.ts';
import { AccessStore } from './access.ts';
import { LarkClient } from './lark-client.ts';
import { LarkChannelServer } from './channel.ts';
import { parsePermissionReply } from './permission.ts';

// Bounded LRU set for message-id dedup.
class DedupSet {
  private ids = new Set<string>();
  private order: string[] = [];
  private max: number;
  constructor(max = 2000) {
    this.max = max;
  }
  seen(id: string): boolean {
    if (this.ids.has(id)) return true;
    this.ids.add(id);
    this.order.push(id);
    if (this.order.length > this.max) {
      const evicted = this.order.shift();
      if (evicted) this.ids.delete(evicted);
    }
    return false;
  }
}

// Recognizes an explicit pairing request: "pair" or "pair CODE" (code ignored here).
const PAIR_RE = /^\s*pair\b/i;

export function makeGate(deps: {
  access: AccessStore;
  lark: LarkClient;
  channel: LarkChannelServer;
  now: () => number;
}) {
  const dedup = new DedupSet();

  return async function onMessage(msg: LarkInboundMessage): Promise<void> {
    // 1. dedup
    if (dedup.seen(msg.messageId)) {
      log('duplicate message_id, skipping:', msg.messageId);
      return;
    }

    // 2. allowlist (by sender open_id — NOT chat_id)
    if (!deps.access.isAllowed(msg.senderOpenId)) {
      // Offer pairing to strangers (both explicit "pair" and any first contact).
      const code = deps.access.createPairingCode(
        msg.senderOpenId,
        msg.chatId,
        msg.messageId,
        deps.now(),
      );
      const wasExplicit = PAIR_RE.test(msg.text);
      const body =
        `👋 You're not authorized to use this Claude Code bot yet.\n\n` +
        `Your pairing code is: ${code}\n\n` +
        `Ask the operator to run:  /lark:access pair ${code}` +
        (wasExplicit ? '' : '\n(Send anything again after being approved.)');
      await deps.lark
        .sendReplyOrChat(msg.chatId, body, msg.messageId)
        .catch((err) => log('failed to send pairing reply:', (err as Error)?.message));
      return;
    }

    // 3. permission decision interception
    const decision = parsePermissionReply(msg.text);
    if (decision) {
      await deps.channel.relayPermissionDecision(decision);
      log(`permission ${decision.behavior} for ${decision.requestId}`);
      return;
    }

    // 4. normal message → Claude
    await deps.channel.pushMessage(msg.text, {
      chat_id: msg.chatId,
      message_id: msg.messageId,
      sender_name: msg.senderName,
    });
  };
}
