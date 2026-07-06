// Webhook transport (default). Lark POSTs events to a public HTTPS URL that proxies
// to this local Express server. The SDK's adaptExpress + EventDispatcher handle the
// URL challenge handshake, AES-256-CBC decryption (encryptKey), and signature verification.
import express from 'express';
import * as lark from '@larksuiteoapi/node-sdk';
import { log, type LarkConfig } from './config.ts';
import { buildDispatcher, type LarkTransport, type OnMessage } from './transport.ts';

export class WebhookTransport implements LarkTransport {
  private cfg: LarkConfig;
  constructor(cfg: LarkConfig) {
    this.cfg = cfg;
  }

  async start(onMessage: OnMessage): Promise<void> {
    const dispatcher = buildDispatcher(onMessage, {
      encryptKey: this.cfg.encryptKey,
      verificationToken: this.cfg.verifyToken,
    });

    const app = express();

    // Lightweight liveness probe (does not interfere with the Lark endpoint).
    app.get('/healthz', (_req, res) => res.status(200).send('ok'));

    // autoChallenge answers the one-time url_verification handshake automatically.
    app.use(
      this.cfg.webhookPath,
      lark.adaptExpress(dispatcher, { autoChallenge: true }),
    );

    await new Promise<void>((resolve) => {
      app.listen(this.cfg.webhookPort, () => {
        log(
          `webhook transport listening on :${this.cfg.webhookPort}${this.cfg.webhookPath} ` +
            `(configure Lark Request URL to https://<your-host>${this.cfg.webhookPath})`,
        );
        if (!this.cfg.encryptKey) {
          log('WARNING: LARK_ENCRYPT_KEY not set — events arrive unencrypted.');
        }
        if (!this.cfg.verifyToken) {
          log('WARNING: LARK_VERIFY_TOKEN not set — push authenticity is not verified.');
        }
        resolve();
      });
    });
  }
}
