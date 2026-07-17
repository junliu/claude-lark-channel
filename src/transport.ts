// Transport abstraction: both webhook and ws implementations normalize the
// im.message.receive_v1 event into a LarkInboundMessage and invoke onMessage.
import * as lark from '@larksuiteoapi/node-sdk';
import { log, type LarkInboundMessage, type LarkMention } from './config.ts';

export type OnMessage = (msg: LarkInboundMessage) => Promise<void>;

export interface LarkTransport {
  start(onMessage: OnMessage): Promise<void>;
}

// The SDK flattens header+event, so the handler receives `sender` and `message` at the top level.
// Shape mirrors the SDK's im.message.receive_v1 handler type.
interface ReceiveEventData {
  sender: { sender_id?: { open_id?: string; union_id?: string; user_id?: string } };
  message: {
    message_id: string;
    chat_id: string;
    chat_type: string;
    message_type: string;
    content: string;
    // In group chats, each @mention (users AND the bot) appears here with its open_id.
    mentions?: Array<{
      key?: string;
      id?: { open_id?: string; union_id?: string; user_id?: string };
      name?: string;
    }>;
  };
}

// Extract meaningful payload from a Lark message. `content` is a JSON-encoded STRING that must be
// re-parsed. Handles text, image, and best-effort text on rich 'post' etc. Image messages return
// { imageKey } so the gate can download the resource; text always populates { text } (possibly the
// raw JSON as a fallback so nothing is silently dropped for unsupported types).
interface ExtractedPayload {
  text: string;
  imageKey?: string;
}

function extractPayload(messageType: string, content: string): ExtractedPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { text: content };
  }
  const obj = parsed as Record<string, unknown>;

  if (messageType === 'image' && typeof obj.image_key === 'string') {
    // Image messages have no accompanying text in content; text stays empty and the gate will
    // push image content to Claude. Some future variants might add captions — pick up any 'text'
    // field defensively so it isn't dropped.
    const caption = typeof obj.text === 'string' ? obj.text : '';
    return { text: caption, imageKey: obj.image_key };
  }

  if (messageType === 'text' && typeof obj.text === 'string') {
    // Lark encodes @mentions as @_user_1 placeholders in text; strip them for clarity.
    return { text: obj.text.replace(/@_user_\d+/g, '').trim() };
  }
  if (typeof obj.text === 'string') return { text: obj.text };
  // Fall back to the raw JSON so nothing is silently dropped for unsupported types.
  return { text: content };
}

// Build the EventDispatcher shared by both transports.
// For webhook, encryptKey/verificationToken enable decryption + signature verification.
// For ws they are unused (events arrive as plaintext over the authed connection).
export function buildDispatcher(
  onMessage: OnMessage,
  opts: { encryptKey?: string; verificationToken?: string },
): lark.EventDispatcher {
  const dispatcher = new lark.EventDispatcher({
    encryptKey: opts.encryptKey,
    verificationToken: opts.verificationToken,
  }).register({
    'im.message.receive_v1': async (raw: unknown) => {
      const data = raw as ReceiveEventData;
      const message = data.message;
      const senderOpenId = data.sender?.sender_id?.open_id ?? '';
      const { text, imageKey } = extractPayload(message.message_type, message.content);
      // Parse every @mention with its open_id so the gate can tell if the bot was @'d.
      const mentions: LarkMention[] = (message.mentions ?? [])
        .map((m) => ({ key: m.key ?? '', openId: m.id?.open_id ?? '', name: m.name }))
        .filter((m) => m.openId);
      const msg: LarkInboundMessage = {
        messageId: message.message_id,
        chatId: message.chat_id,
        chatType: message.chat_type,
        senderOpenId,
        senderName: undefined,
        text,
        mentions,
        imageKey,
      };
      try {
        await onMessage(msg);
      } catch (err) {
        log('onMessage handler error:', (err as Error)?.message);
      }
      return { code: 0 };
    },
  });
  return dispatcher;
}
