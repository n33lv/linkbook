import type { AppConfig } from '../../config.js';
import type { IntegrationConnection } from '@linkbook/db/schema';
import { getHttpTransport } from '../_http/client.js';

const BASE = 'https://api.dropboxsign.com/v3';

export type DropboxsignClient = {
  sendReminder(signatureRequestId: string): Promise<unknown>;
  sendFromTemplate(payload: { template_id: string; recipient: string; title: string }): Promise<{ signature_request_id: string }>;
  cancel(signatureRequestId: string): Promise<unknown>;
};

export function createDropboxsignClient(_cfg: AppConfig, conn: IntegrationConnection): DropboxsignClient {
  const auth = conn.access_token ? { authorization: `Bearer ${conn.access_token}` } : {};
  const t = getHttpTransport();
  return {
    async sendReminder(id) {
      const res = await t.request({ method: 'POST', url: `${BASE}/signature_request/remind/${id}`, headers: auth });
      if (res.status >= 400) throw httpErr('dropboxsign sendReminder', res.status, res.body);
      return res.body;
    },
    async sendFromTemplate(payload) {
      const res = await t.request({
        method: 'POST',
        url: `${BASE}/signature_request/send_with_template`,
        headers: auth,
        body: payload,
      });
      if (res.status >= 400) throw httpErr('dropboxsign send_with_template', res.status, res.body);
      return res.body as { signature_request_id: string };
    },
    async cancel(id) {
      const res = await t.request({ method: 'POST', url: `${BASE}/signature_request/cancel/${id}`, headers: auth });
      if (res.status >= 400) throw httpErr('dropboxsign cancel', res.status, res.body);
      return res.body;
    },
  };
}

function httpErr(label: string, status: number, body: unknown): Error {
  const e = new Error(`${label} failed: ${status}`) as Error & { status: number; body: unknown };
  e.status = status;
  e.body = body;
  return e;
}
