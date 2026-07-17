// The gate decides what happens to each inbound Lark message, in order:
//   1. dedup by message_id (Lark may push duplicates)
//   2. GROUP messages: require the bot to be @mentioned, else drop silently
//   3. allowlist check on SENDER open_id (pairing offered to strangers in p2p only)
//   4. permission reply "yes/no <id>" interception
//   5. soft-reset keyword "新会话" → inject a fresh-start marker
//   6. otherwise, forward to Claude as a channel message
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

// Soft-reset trigger: when a user sends exactly this (case/space-insensitive), we inject a system
// marker telling Claude to disregard prior context and start fresh. NOTE: this is a SOFT reset —
// channels cannot invoke the real /new or /compact (see channels-reference: no session-control
// notifications), so the underlying context isn't actually cleared/compacted; Claude is just
// instructed to ignore it. In a group the bot's @mention is already stripped from msg.text.
const SOFT_RESET_RE = /^\s*新会话\s*$/;

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

    // 2. GROUP chats: only act when THIS bot is @mentioned; otherwise stay silent so the bot
    //    doesn't react to ordinary group chatter. (p2p/DMs skip this and behave as before.)
    const isGroup = msg.chatType === 'group';
    if (isGroup) {
      const botOpenId = await deps.lark.getBotOpenId();
      const mentionsBot = !!botOpenId && msg.mentions.some((m) => m.openId === botOpenId);
      if (!mentionsBot) {
        // Not @'d (or we couldn't resolve the bot id) — ignore quietly.
        return;
      }
    }

    // 3. allowlist (by sender open_id — NOT chat_id). Pairing is offered ONLY in p2p; in a group
    //    we stay silent for unauthorized senders (no pairing-code spam in shared channels).
    if (!deps.access.isAllowed(msg.senderOpenId)) {
      if (isGroup) {
        log('group @mention from non-allowlisted sender, ignoring:', msg.senderOpenId);
        return;
      }
      // p2p: offer pairing to strangers (both explicit "pair" and any first contact).
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

    // 4. permission decision interception
    const decision = parsePermissionReply(msg.text);
    if (decision) {
      await deps.channel.relayPermissionDecision(decision);
      log(`permission ${decision.behavior} for ${decision.requestId}`);
      return;
    }

    // 5. soft reset — inject a system marker so Claude starts a fresh logical conversation.
    //    (A soft reset: it does NOT run /new or /compact — channels can't — it just tells Claude
    //    to ignore prior context. See SOFT_RESET_RE above.)
    if (SOFT_RESET_RE.test(msg.text)) {
      log('soft-reset requested by', msg.senderOpenId);
      await deps.channel.pushMessage(
        '[SYSTEM] The Lark user sent the reset keyword "新会话". Treat this as the start of a ' +
          'brand-new conversation: disregard all earlier messages and context from this chat, and ' +
          'wait for their next message as a fresh task. Reply via the reply tool with a short ' +
          'confirmation like "已开启新会话，之前的上下文我不再参考，请说你的新任务。" (Note: this is a ' +
          'logical reset only; it does not compact the underlying context — mention that /compact in ' +
          'the terminal is the way to actually shrink it, only if the user asks.)',
        { chat_id: msg.chatId, message_id: msg.messageId, sender_name: msg.senderName },
      );
      return;
    }

    // 6a. image message → download from Lark, save to inbox, push path to Claude.
    //     On download failure, fall back to a text notice so the user's message isn't fully
    //     dropped (they'll see the bot didn't process the image and can resend/rephrase).
    if (msg.imageKey) {
      try {
        const bytes = await deps.lark.downloadResource(msg.messageId, msg.imageKey);
        await deps.channel.pushImage(bytes, msg.text, {
          chat_id: msg.chatId,
          message_id: msg.messageId,
          sender_name: msg.senderName,
        });
      } catch (err) {
        log('image download failed:', (err as Error)?.message);
        await deps.channel.pushMessage(
          `[image message received but download failed: ${(err as Error)?.message ?? 'unknown'} — ` +
            'ask the sender to resend]' +
            (msg.text ? `\ncaption: ${msg.text}` : ''),
          { chat_id: msg.chatId, message_id: msg.messageId, sender_name: msg.senderName },
        );
      }
      return;
    }

    // 6b. normal text message → Claude
    await deps.channel.pushMessage(msg.text, {
      chat_id: msg.chatId,
      message_id: msg.messageId,
      sender_name: msg.senderName,
    });
  };
}
