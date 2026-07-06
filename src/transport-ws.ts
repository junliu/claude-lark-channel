// WebSocket long-connection transport (optional; LARK_TRANSPORT=ws).
// The SDK opens an outbound wss:// connection — no public URL / tunnel needed, and events
// arrive as plaintext (auth happens at connect time, so encryptKey is not used here).
//
// CAVEAT: the Lark international Developer Console may not expose the "long connection"
// subscription mode for every app (community report openclaw #51663). If the console has no
// such toggle, use the webhook transport instead. This code fails loudly via onError.
import * as lark from '@larksuiteoapi/node-sdk';
import { log, type LarkConfig } from './config.ts';
import { buildDispatcher, type LarkTransport, type OnMessage } from './transport.ts';

export class WsTransport implements LarkTransport {
  private cfg: LarkConfig;
  constructor(cfg: LarkConfig) {
    this.cfg = cfg;
  }

  async start(onMessage: OnMessage): Promise<void> {
    // encryptKey/verificationToken are intentionally omitted: WS events are plaintext.
    const dispatcher = buildDispatcher(onMessage, {});

    const wsClient = new lark.WSClient({
      appId: this.cfg.appId,
      appSecret: this.cfg.appSecret,
      domain: lark.Domain.Lark,
      onReady: () => log('ws transport connected (long connection ready)'),
      onError: (err: Error) => {
        log(
          'ws transport error:',
          err?.message,
          '\nIf the Lark console has no "long connection" mode for this app, set LARK_TRANSPORT=webhook.',
        );
      },
      onReconnecting: () => log('ws transport reconnecting...'),
      onReconnected: () => log('ws transport reconnected'),
    });

    wsClient.start({ eventDispatcher: dispatcher });
    log('ws transport starting (LARK_TRANSPORT=ws)');
  }
}
