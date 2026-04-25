import type { AppConfig } from '../../config.js';
import type { IntegrationConnection } from '@linkbook/db/schema';
import { getHttpTransport } from '../_http/client.js';

const BASE = 'https://api.airtable.com/v0';

export type AirtableClient = {
  createRecords(baseId: string, tableId: string, records: Array<{ fields: Record<string, unknown> }>): Promise<unknown>;
  updateRecord(baseId: string, tableId: string, recordId: string, fields: Record<string, unknown>): Promise<unknown>;
  listRecords(baseId: string, tableId: string): Promise<unknown>;
};

export function createAirtableClient(_cfg: AppConfig, conn: IntegrationConnection): AirtableClient {
  const auth = conn.access_token ? { authorization: `Bearer ${conn.access_token}` } : {};
  const t = getHttpTransport();
  return {
    async createRecords(baseId, tableId, records) {
      const res = await t.request({
        method: 'POST',
        url: `${BASE}/${baseId}/${tableId}`,
        headers: auth,
        body: { records },
      });
      if (res.status >= 400) throw httpErr('airtable createRecords', res.status, res.body);
      return res.body;
    },
    async updateRecord(baseId, tableId, recordId, fields) {
      const res = await t.request({
        method: 'PATCH',
        url: `${BASE}/${baseId}/${tableId}/${recordId}`,
        headers: auth,
        body: { fields },
      });
      if (res.status >= 400) throw httpErr('airtable updateRecord', res.status, res.body);
      return res.body;
    },
    async listRecords(baseId, tableId) {
      const res = await t.request({ method: 'GET', url: `${BASE}/${baseId}/${tableId}`, headers: auth });
      if (res.status >= 400) throw httpErr('airtable listRecords', res.status, res.body);
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
