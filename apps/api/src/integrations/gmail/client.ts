import type { AppConfig } from '../../config.js';
import type { IntegrationConnection } from '@linkbook/db/schema';
import { getHttpTransport } from '../_http/client.js';

const BASE = 'https://gmail.googleapis.com/gmail/v1';

export type GmailClient = {
  send(payload: {
    to: string;
    cc?: string[];
    subject: string;
    body: string;
    thread_id?: string | null;
  }): Promise<{ id: string; threadId: string }>;
  applyLabels(threadId: string, addLabelIds: string[]): Promise<unknown>;
  fetchThread(threadId: string): Promise<unknown>;
};

export function createGmailClient(_cfg: AppConfig, conn: IntegrationConnection): GmailClient {
  const auth = conn.access_token ? { authorization: `Bearer ${conn.access_token}` } : {};
  const t = getHttpTransport();
  return {
    async send(payload) {
      const res = await t.request({
        method: 'POST',
        url: `${BASE}/users/me/messages/send`,
        headers: auth,
        body: payload,
      });
      if (res.status >= 400) throw httpErr('gmail send', res.status, res.body);
      return res.body as { id: string; threadId: string };
    },
    async applyLabels(threadId, addLabelIds) {
      const res = await t.request({
        method: 'POST',
        url: `${BASE}/users/me/threads/${threadId}/modify`,
        headers: auth,
        body: { addLabelIds, removeLabelIds: [] },
      });
      if (res.status >= 400) throw httpErr('gmail applyLabels', res.status, res.body);
      return res.body;
    },
    async fetchThread(threadId) {
      const res = await t.request({
        method: 'GET',
        url: `${BASE}/users/me/threads/${threadId}`,
        headers: auth,
      });
      if (res.status >= 400) throw httpErr('gmail fetchThread', res.status, res.body);
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
