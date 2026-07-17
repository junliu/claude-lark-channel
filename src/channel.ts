// MCP channel server: declares the claude/channel capability, pushes inbound Lark messages to
// Claude Code, exposes the `reply` tool, and relays permission requests.
import { mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { INBOX_DIR, INBOX_MAX_AGE_MS, log } from './config.ts';
import { LarkClient, type MsgFormat } from './lark-client.ts';
import {
  PermissionRequestSchema,
  formatPermissionPrompt,
  type PermissionDecision,
} from './permission.ts';

// Prune inbox files older than INBOX_MAX_AGE_MS. Called opportunistically on each new save so
// old screenshots don't accumulate. Errors are logged but never thrown — pruning is best-effort.
async function pruneInbox(): Promise<void> {
  try {
    const entries = await readdir(INBOX_DIR);
    const now = Date.now();
    await Promise.all(
      entries.map(async (name) => {
        const p = join(INBOX_DIR, name);
        try {
          const s = await stat(p);
          if (now - s.mtimeMs > INBOX_MAX_AGE_MS) {
            await unlink(p);
          }
        } catch {
          // ignore per-file errors
        }
      }),
    );
  } catch (err) {
    log('inbox prune failed:', (err as Error)?.message);
  }
}

const INSTRUCTIONS =
  'Messages from Lark arrive as <channel source="lark" chat_id="..." message_id="..." ' +
  'sender_name="...">text</channel>. When the user sends an image, it is saved to a local ' +
  'inbox and the <channel> body reads "[Lark image saved to: <abs-path> — use the Read tool ' +
  'to view it]" (optionally followed by a caption line); read the file with the Read tool ' +
  'when you want to see the picture. To respond with text, call the `reply` tool with the ' +
  'chat_id (and, optionally, the message_id from the tag to thread the reply); to send an ' +
  'image back, call `send_photo` with chat_id and a local photo_path.\n' +
  '\n' +
  'The Lark user may NOT be watching the terminal — for them, your `reply` messages are the ONLY ' +
  'thing they see. Anything you write as normal output goes only to the operator\'s TUI and is ' +
  'invisible to them. Therefore:\n' +
  '1. SELF-CONTAINED REPLIES: make each `reply` stand on its own. Include the actual result, any ' +
  'caveats, and any follow-up question or confirmation you\'d otherwise only put in the TUI. Do not ' +
  'assume they can see your terminal output. Be concise in wording, but never drop information they ' +
  'need to act — a truncated reply that hides the real answer is worse than a longer one. `reply` ' +
  'renders Markdown by default, so use headings, **bold**, `code`, code fences, and numbered lists ' +
  'to make replies readable (pass format:"text" only when you deliberately want no rendering).\n' +
  '2. NEVER use the AskUserQuestion tool when responding to a Lark user — it renders only in the TUI ' +
  'and is invisible in Lark (in fact it is disabled in channel sessions), so it looks like you hung. ' +
  'When you need them to choose, send the options via `reply` as a numbered list, e.g. ' +
  '"请选择：1. 方案A  2. 方案B（回复数字即可）", and let them reply with the number or the option text. ' +
  'Their reply arrives as a new <channel> message you then act on.\n' +
  '3. SOFT RESET: if a <channel> event arrives whose content is a "[SYSTEM] ... reset keyword 新会话" ' +
  'marker, the user wants a fresh conversation. Disregard all earlier context from this chat and ' +
  'treat their next message as a brand-new task. Confirm briefly via `reply`. This is a logical ' +
  'reset only — it does not actually compact the context (channels cannot run /new or /compact); ' +
  'only mention that /compact must be run in the terminal if the user specifically asks to shrink it.';

// meta keys must be identifiers (letters/digits/underscore); keys with '-' are silently dropped.
export interface ChannelMeta {
  chat_id: string;
  message_id: string;
  sender_name?: string;
}

export class LarkChannelServer {
  readonly mcp: Server;
  private lark: LarkClient;
  // Track the most recent chat so permission prompts can be routed somewhere sensible.
  private lastChat: { chatId: string; messageId?: string } | null = null;

  constructor(lark: LarkClient) {
    this.lark = lark;
    this.mcp = new Server(
      { name: 'lark', version: '0.1.0' },
      {
        capabilities: {
          experimental: {
            'claude/channel': {},
            'claude/channel/permission': {},
          },
          tools: {},
        },
        instructions: INSTRUCTIONS,
      },
    );

    this.registerTools();
    this.registerPermissionRelay();
  }

  async connect(): Promise<void> {
    await this.mcp.connect(new StdioServerTransport());
    log('MCP channel connected over stdio');
  }

  // Push an inbound Lark message to Claude as a channel event.
  async pushMessage(content: string, meta: ChannelMeta): Promise<void> {
    this.lastChat = { chatId: meta.chat_id, messageId: meta.message_id };
    await this.mcp.notification({
      method: 'notifications/claude/channel',
      params: { content, meta },
    });
  }

  // Push an inbound Lark image message to Claude. The channel `content` field is spec'd as a
  // plain STRING (see channels-reference: "The event body. Delivered as the body of the <channel>
  // tag."), so we can't inline base64 image data. We follow the official fakechat pattern:
  // save the image to disk under INBOX_DIR and tell Claude the absolute path, so Claude reads
  // the file via its own Read tool when it wants to see the picture.
  async pushImage(
    imageBytes: Buffer,
    caption: string,
    meta: ChannelMeta,
  ): Promise<void> {
    this.lastChat = { chatId: meta.chat_id, messageId: meta.message_id };
    try {
      await mkdir(INBOX_DIR, { recursive: true });
    } catch (err) {
      log('failed to create INBOX_DIR:', (err as Error)?.message);
    }
    // We don't sniff the container from the bytes; Lark images are typically jpg/png but the
    // extension only helps Read pick a decoder. Default to .jpg — Read still opens PNGs fine.
    const filename = `${meta.message_id}.jpg`;
    const filePath = join(INBOX_DIR, filename);
    try {
      await writeFile(filePath, imageBytes);
    } catch (err) {
      log('failed to save inbound image:', (err as Error)?.message);
      // Fall back to a text-only notice so the user's message isn't fully dropped.
      await this.mcp.notification({
        method: 'notifications/claude/channel',
        params: {
          content:
            `[image message received but save failed: ${(err as Error)?.message ?? 'unknown'}]` +
            (caption ? `\ncaption: ${caption}` : ''),
          meta,
        },
      });
      return;
    }
    // Best-effort cleanup of old inbox files. Non-blocking (fire-and-forget) so a slow prune
    // doesn't hold up delivery of this message.
    void pruneInbox();

    const captionSuffix = caption && caption.trim() ? `\ncaption: ${caption}` : '';
    const content =
      `[Lark image saved to: ${filePath} — use the Read tool to view it]${captionSuffix}`;
    await this.mcp.notification({
      method: 'notifications/claude/channel',
      params: { content, meta },
    });
  }

  // Send a permission decision back to Claude Code.
  private async sendPermissionDecision(decision: PermissionDecision): Promise<void> {
    await this.mcp.notification({
      method: 'notifications/claude/channel/permission',
      params: { request_id: decision.requestId, behavior: decision.behavior },
    });
  }

  // Called by the gate when an inbound message parsed as a permission reply.
  async relayPermissionDecision(decision: PermissionDecision): Promise<void> {
    await this.sendPermissionDecision(decision);
  }

  private registerTools(): void {
    this.mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'reply',
          description:
            'Send a message back over the Lark channel. Text is rendered as Markdown by default ' +
            '(headings, **bold**, lists, `code`, code blocks, links, tables all render in Lark).',
          inputSchema: {
            type: 'object',
            properties: {
              chat_id: {
                type: 'string',
                description: 'The chat to reply in (from the channel tag).',
              },
              message_id: {
                type: 'string',
                description:
                  'Optional: reply threaded to this specific incoming message (om_...).',
              },
              text: {
                type: 'string',
                description:
                  'The message text. Markdown is supported and rendered by default — use it ' +
                  '(headings, bold, lists, code fences) for readable replies.',
              },
              format: {
                type: 'string',
                enum: ['markdown', 'text'],
                description:
                  "How to render `text`. 'markdown' (default) renders as a Feishu card; 'text' " +
                  'sends a raw plain string. Use text only when you specifically want no rendering.',
              },
            },
            required: ['chat_id', 'text'],
          },
        },
        {
          name: 'send_photo',
          description:
            'Send a single image into a Lark chat. Reads the image from a local path (jpg/png/' +
            'gif/webp), uploads it to Lark to obtain an image_key, then posts an image message. ' +
            'Optional message_id threads the reply to a specific inbound message. Lark image cap ' +
            'is ~10 MB — larger files will be rejected by the server.',
          inputSchema: {
            type: 'object',
            properties: {
              chat_id: {
                type: 'string',
                description: 'The chat to send the image to (from the channel tag).',
              },
              photo_path: {
                type: 'string',
                description:
                  'Absolute local path to the image file (jpg/png/gif/webp). The plugin runs ' +
                  'on the operator machine — this path must be resolvable there.',
              },
              message_id: {
                type: 'string',
                description:
                  'Optional: thread this image reply to a specific inbound message (om_...).',
              },
            },
            required: ['chat_id', 'photo_path'],
          },
        },
      ],
    }));

    this.mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
      if (req.params.name === 'reply') {
        const args = (req.params.arguments ?? {}) as {
          chat_id?: string;
          message_id?: string;
          text?: string;
          format?: string;
        };
        if (!args.chat_id || !args.text) {
          throw new Error('reply requires chat_id and text');
        }
        // Default to markdown so replies render nicely; only 'text' opts out.
        const format: MsgFormat = args.format === 'text' ? 'text' : 'markdown';
        try {
          await this.lark.sendReplyOrChat(args.chat_id, args.text, args.message_id, format);
          return { content: [{ type: 'text', text: 'sent' }] };
        } catch (err) {
          const msg = (err as Error)?.message ?? String(err);
          log('reply tool send failed:', msg);
          return { content: [{ type: 'text', text: `send failed: ${msg}` }], isError: true };
        }
      }

      if (req.params.name === 'send_photo') {
        const args = (req.params.arguments ?? {}) as {
          chat_id?: string;
          photo_path?: string;
          message_id?: string;
        };
        if (!args.chat_id || !args.photo_path) {
          throw new Error('send_photo requires chat_id and photo_path');
        }
        try {
          const imageKey = await this.lark.uploadImage(args.photo_path);
          await this.lark.sendImageOrReply(args.chat_id, imageKey, args.message_id);
          return { content: [{ type: 'text', text: `sent (image_key=${imageKey})` }] };
        } catch (err) {
          const msg = (err as Error)?.message ?? String(err);
          log('send_photo tool failed:', msg);
          return {
            content: [{ type: 'text', text: `send_photo failed: ${msg}` }],
            isError: true,
          };
        }
      }

      throw new Error(`unknown tool: ${req.params.name}`);
    });
  }

  // Claude Code → server: permission_request. Forward to Lark for a human yes/no.
  private registerPermissionRelay(): void {
    this.mcp.setNotificationHandler(PermissionRequestSchema, async (notif) => {
      const prompt = formatPermissionPrompt(notif.params);
      if (this.lastChat) {
        await this.lark
          .sendReplyOrChat(this.lastChat.chatId, prompt, this.lastChat.messageId)
          .catch((err) => log('failed to forward permission prompt:', (err as Error)?.message));
      } else {
        log('permission request received but no chat known yet; prompt not forwarded');
      }
    });

    // Swallow any other channel-related notifications Claude Code might send so the
    // SDK does not error on unknown incoming methods.
    this.mcp.fallbackNotificationHandler = async (notif) => {
      log('unhandled notification:', notif.method);
    };
  }
}
