import type { AppConfig } from '../../config.js';
import type { IntegrationConnection } from '@linkbook/db/schema';
import { getHttpTransport } from '../_http/client.js';

const BASE = 'https://api.harvestapp.com/v2';

export type HarvestClient = {
  sendInvoice(invoiceId: string): Promise<unknown>;
  createProject(payload: { name: string; client_id: string; budget_hours: number }): Promise<{ id: string }>;
  archiveProject(projectId: string): Promise<unknown>;
  logTimeEntry(payload: {
    user_id: string;
    project_id: string;
    date: string;
    hours: number;
    notes?: string | null;
  }): Promise<unknown>;
  listTimeEntries(): Promise<unknown>;
};

export function createHarvestClient(_cfg: AppConfig, conn: IntegrationConnection): HarvestClient {
  const auth = conn.access_token ? { authorization: `Bearer ${conn.access_token}` } : {};
  const account = conn.external_account_id;
  const headers = { ...auth, 'harvest-account-id': account };
  const t = getHttpTransport();
  return {
    async sendInvoice(invoiceId) {
      const res = await t.request({
        method: 'POST',
        url: `${BASE}/invoices/${invoiceId}/messages`,
        headers,
        body: { event_type: 'send' },
      });
      if (res.status >= 400) throw httpErr('harvest sendInvoice', res.status, res.body);
      return res.body;
    },
    async createProject(payload) {
      const res = await t.request({ method: 'POST', url: `${BASE}/projects`, headers, body: payload });
      if (res.status >= 400) throw httpErr('harvest createProject', res.status, res.body);
      return res.body as { id: string };
    },
    async archiveProject(projectId) {
      const res = await t.request({
        method: 'PATCH',
        url: `${BASE}/projects/${projectId}`,
        headers,
        body: { is_active: false },
      });
      if (res.status >= 400) throw httpErr('harvest archiveProject', res.status, res.body);
      return res.body;
    },
    async logTimeEntry(payload) {
      const res = await t.request({ method: 'POST', url: `${BASE}/time_entries`, headers, body: payload });
      if (res.status >= 400) throw httpErr('harvest logTimeEntry', res.status, res.body);
      return res.body;
    },
    async listTimeEntries() {
      const res = await t.request({ method: 'GET', url: `${BASE}/time_entries`, headers });
      if (res.status >= 400) throw httpErr('harvest listTimeEntries', res.status, res.body);
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
