// Permission relay: forward Claude Code's permission requests to Lark, and turn "yes/no <id>"
// replies from Lark into permission decisions.
//
// The request_id alphabet used by Claude Code is [a-km-z] (5 lowercase letters, no 'l' to avoid
// confusion with 1/I). We normalize the reply to lowercase because mobile keyboards auto-capitalize.
import { z } from 'zod';

// Matches "yes abcde", "y abcde", "no abcde", "n abcde" (case-insensitive), optional whitespace.
export const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i;

export interface PermissionDecision {
  requestId: string;
  behavior: 'allow' | 'deny';
}

// Parse an inbound Lark message; returns a decision if it's a permission reply, else null.
export function parsePermissionReply(text: string): PermissionDecision | null {
  const m = PERMISSION_REPLY_RE.exec(text);
  if (!m) return null;
  return {
    requestId: m[2]!.toLowerCase(), // normalize auto-capitalized input
    behavior: m[1]!.toLowerCase().startsWith('y') ? 'allow' : 'deny',
  };
}

// Notification schema for permission requests Claude Code sends to the channel server.
export const PermissionRequestSchema = z.object({
  method: z.literal('notifications/claude/channel/permission_request'),
  params: z.object({
    request_id: z.string(),
    tool_name: z.string(),
    description: z.string(),
    input_preview: z.string().optional(),
  }),
});

export type PermissionRequest = z.infer<typeof PermissionRequestSchema>;

// Render the request into a message a Lark user can act on.
export function formatPermissionPrompt(params: PermissionRequest['params']): string {
  const preview = params.input_preview ? `\n\n${params.input_preview}` : '';
  return (
    `🔐 Claude wants to run ${params.tool_name}: ${params.description}${preview}\n\n` +
    `Reply "yes ${params.request_id}" to allow, or "no ${params.request_id}" to deny.`
  );
}
