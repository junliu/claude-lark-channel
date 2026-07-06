// MCP channel server: declares the claude/channel capability, pushes inbound Lark messages to
// Claude Code, exposes the `reply` tool, and relays permission requests.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { log } from './config.ts';
import { LarkClient } from './lark-client.ts';
import {
  PermissionRequestSchema,
  formatPermissionPrompt,
  type PermissionDecision,
} from './permission.ts';

const INSTRUCTIONS =
  'Messages from Lark arrive as <channel source="lark" chat_id="..." message_id="..." ' +
  'sender_name="...">text</channel>. To respond, call the `reply` tool with the chat_id (and, ' +
  'optionally, the message_id from the tag to thread the reply).\n' +
  '\n' +
  'The Lark user may NOT be watching the terminal — for them, your `reply` messages are the ONLY ' +
  'thing they see. Anything you write as normal output goes only to the operator\'s TUI and is ' +
  'invisible to them. Therefore:\n' +
  '1. SELF-CONTAINED REPLIES: make each `reply` stand on its own. Include the actual result, any ' +
  'caveats, and any follow-up question or confirmation you\'d otherwise only put in the TUI. Do not ' +
  'assume they can see your terminal output. Be concise in wording, but never drop information they ' +
  'need to act — a truncated reply that hides the real answer is worse than a longer one.\n' +
  '2. NEVER use the AskUserQuestion tool when responding to a Lark user — it renders only in the TUI ' +
  'and is invisible in Lark (in fact it is disabled in channel sessions), so it looks like you hung. ' +
  'When you need them to choose, send the options via `reply` as a numbered list, e.g. ' +
  '"请选择：1. 方案A  2. 方案B（回复数字即可）", and let them reply with the number or the option text. ' +
  'Their reply arrives as a new <channel> message you then act on.';

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
          description: 'Send a text message back over the Lark channel.',
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
              text: { type: 'string', description: 'The message text to send.' },
            },
            required: ['chat_id', 'text'],
          },
        },
      ],
    }));

    this.mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
      if (req.params.name !== 'reply') {
        throw new Error(`unknown tool: ${req.params.name}`);
      }
      const args = (req.params.arguments ?? {}) as {
        chat_id?: string;
        message_id?: string;
        text?: string;
      };
      if (!args.chat_id || !args.text) {
        throw new Error('reply requires chat_id and text');
      }
      try {
        await this.lark.sendReplyOrChat(args.chat_id, args.text, args.message_id);
        return { content: [{ type: 'text', text: 'sent' }] };
      } catch (err) {
        const msg = (err as Error)?.message ?? String(err);
        log('reply tool send failed:', msg);
        return { content: [{ type: 'text', text: `send failed: ${msg}` }], isError: true };
      }
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
