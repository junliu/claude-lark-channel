// Thin wrapper over the official Lark SDK client for sending / replying as the bot.
// The SDK handles tenant_access_token acquisition, caching, and refresh internally.
import * as lark from '@larksuiteoapi/node-sdk';
import { log, type LarkConfig } from './config.ts';

export class LarkClient {
  private client: lark.Client;

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

  // Reply to a specific incoming message (preferred for a conversational bot).
  async replyToMessage(messageId: string, text: string): Promise<void> {
    await this.client.im.message.reply({
      path: { message_id: messageId },
      data: { msg_type: 'text', content: JSON.stringify({ text }) },
    });
  }

  // Send a fresh message into a chat by chat_id.
  async sendToChat(chatId: string, text: string): Promise<void> {
    await this.client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text }) },
    });
  }

  // Best-effort send that prefers threading off the original message, falling back to a
  // plain chat send. Used by the permission relay and pairing replies.
  async sendReplyOrChat(chatId: string, text: string, messageId?: string): Promise<void> {
    try {
      if (messageId) {
        await this.replyToMessage(messageId, text);
        return;
      }
    } catch (err) {
      log('reply failed, falling back to chat send:', (err as Error)?.message);
    }
    await this.sendToChat(chatId, text);
  }
}
