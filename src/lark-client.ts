// Thin wrapper over the official Lark SDK client for sending / replying as the bot.
// The SDK handles tenant_access_token acquisition, caching, and refresh internally.
import { createReadStream } from 'node:fs';
import * as lark from '@larksuiteoapi/node-sdk';
import { log, type LarkConfig } from './config.ts';

// 'text' = plain string (no markdown rendering); 'markdown' = Feishu interactive card.
export type MsgFormat = 'text' | 'markdown';

// Interactive-card payloads are capped at ~30KB by Lark; stay under it with margin, else
// fall back to plain text so long messages still deliver.
const CARD_MAX_BYTES = 25 * 1024;

export class LarkClient {
  private client: lark.Client;
  private botOpenId: string | null = null; // cached; the bot's own open_id never changes

  constructor(cfg: LarkConfig) {
    this.client = new lark.Client({
      appId: cfg.appId,
      appSecret: cfg.appSecret,
      // Domain.Lark = Larksuite international (open.larksuite.com).
      // Use Domain.Feishu for the China tenant (open.feishu.cn).
      domain: lark.Domain.Lark,
    });
  }

  // Expose the raw SDK client in case transports need EventDispatcher wiring, etc.
  get raw(): lark.Client {
    return this.client;
  }

  // The bot's own open_id (ou_...), fetched once from GET /open-apis/bot/v3/info and cached.
  // Used to decide whether a group message actually @mentioned THIS bot. Returns null if the
  // lookup fails (caller should treat "unknown bot id" as "cannot confirm @bot").
  async getBotOpenId(): Promise<string | null> {
    if (this.botOpenId) return this.botOpenId;
    try {
      // The SDK auto-attaches a tenant_access_token to this authenticated request.
      const res = (await this.client.request({
        url: '/open-apis/bot/v3/info',
        method: 'GET',
      })) as { bot?: { open_id?: string } };
      const openId = res?.bot?.open_id;
      if (openId) {
        this.botOpenId = openId;
        return openId;
      }
      log('bot/v3/info returned no open_id:', JSON.stringify(res).slice(0, 200));
    } catch (err) {
      log('failed to fetch bot open_id:', (err as Error)?.message);
    }
    return null;
  }

  // Build the { msg_type, content } payload for a message. 'markdown' renders as a Feishu
  // interactive card (headers/lists/code blocks/bold all render); 'text' is a plain string.
  // Interactive cards have a ~30KB payload cap — oversized markdown falls back to plain text so
  // the message still gets delivered (unrendered) rather than erroring out.
  private buildPayload(text: string, format: MsgFormat): { msg_type: string; content: string } {
    if (format === 'markdown') {
      const card = {
        schema: '2.0',
        // No header — a title bar on every reply would be noise for a chat bot.
        body: { elements: [{ tag: 'markdown', content: text }] },
      };
      const content = JSON.stringify(card);
      if (content.length <= CARD_MAX_BYTES) {
        return { msg_type: 'interactive', content };
      }
      log(`markdown card ${content.length}B exceeds ${CARD_MAX_BYTES}B cap, sending as text`);
    }
    return { msg_type: 'text', content: JSON.stringify({ text }) };
  }

  // Reply to a specific incoming message (preferred for a conversational bot).
  async replyToMessage(messageId: string, text: string, format: MsgFormat = 'text'): Promise<void> {
    await this.client.im.message.reply({
      path: { message_id: messageId },
      data: this.buildPayload(text, format),
    });
  }

  // Send a fresh message into a chat by chat_id.
  async sendToChat(chatId: string, text: string, format: MsgFormat = 'text'): Promise<void> {
    await this.client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: chatId, ...this.buildPayload(text, format) },
    });
  }

  // Best-effort send that prefers threading off the original message, falling back to a
  // plain chat send. Used by the permission relay and pairing replies.
  async sendReplyOrChat(
    chatId: string,
    text: string,
    messageId?: string,
    format: MsgFormat = 'text',
  ): Promise<void> {
    try {
      if (messageId) {
        await this.replyToMessage(messageId, text, format);
        return;
      }
    } catch (err) {
      log('reply failed, falling back to chat send:', (err as Error)?.message);
    }
    await this.sendToChat(chatId, text, format);
  }

  // ── image support (v0.4.0) ───────────────────────────────────
  // Send/receive images through Lark's im/v1/images and messages resources APIs.

  // Upload a local image file → returns Lark's `image_key`, which is then referenced by
  // subsequent send/reply calls. `message` is the only image_type we use here (10MB cap).
  async uploadImage(imagePath: string): Promise<string> {
    const res = await this.client.im.image.create({
      data: {
        image_type: 'message',
        image: createReadStream(imagePath),
      },
    });
    const key = res?.image_key;
    if (!key) {
      throw new Error(`upload succeeded but no image_key: ${JSON.stringify(res).slice(0, 200)}`);
    }
    return key;
  }

  // Download an image referenced by an inbound message. Lark requires the source message_id
  // as URL context (the image_key alone is not resolvable). Returns raw bytes as a Buffer.
  async downloadResource(messageId: string, fileKey: string): Promise<Buffer> {
    const res = await this.client.im.messageResource.get({
      path: { message_id: messageId, file_key: fileKey },
      params: { type: 'image' },
    });
    const stream = res.getReadableStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  // Send an image into a chat by chat_id (bare image, no caption).
  async sendImageToChat(chatId: string, imageKey: string): Promise<void> {
    await this.client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'image',
        content: JSON.stringify({ image_key: imageKey }),
      },
    });
  }

  // Reply to a specific incoming message with an image (threaded).
  async replyImageToMessage(messageId: string, imageKey: string): Promise<void> {
    await this.client.im.message.reply({
      path: { message_id: messageId },
      data: {
        msg_type: 'image',
        content: JSON.stringify({ image_key: imageKey }),
      },
    });
  }

  // Best-effort image send — prefer threaded reply, fall back to chat.
  async sendImageOrReply(
    chatId: string,
    imageKey: string,
    messageId?: string,
  ): Promise<void> {
    try {
      if (messageId) {
        await this.replyImageToMessage(messageId, imageKey);
        return;
      }
    } catch (err) {
      log('reply-image failed, falling back to chat send:', (err as Error)?.message);
    }
    await this.sendImageToChat(chatId, imageKey);
  }
}
