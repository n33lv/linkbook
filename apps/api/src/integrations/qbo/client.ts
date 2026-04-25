import type { AppConfig } from '../../config.js';
import type { IntegrationConnection } from '@linkbook/db/schema';
import { getHttpTransport } from '../_http/client.js';

// §4.1 — QBO. Poll-based via CDC. Hard rules: never write to journal
// entries, never touch closed-period transactions.
//
// In dev we point at a mock-friendly host; the request URL lives in code,
// the mock transport routes by hostname. Real QBO uses
// https://{sandbox-,}quickbooks.api.intuit.com/v3/company/{realmId}/...

const SANDBOX_BASE = 'https://sandbox-quickbooks.api.intuit.com';
const PROD_BASE = 'https://quickbooks.api.intuit.com';

function baseUrl(cfg: AppConfig): string {
  return cfg.QBO_ENVIRONMENT === 'production' ? PROD_BASE : SANDBOX_BASE;
}

export type QboClient = {
  cdc(entities: readonly string[], changedSince: Date): Promise<unknown>;
  getInvoice(invoice_id: string): Promise<{ status: 'sent' | 'paid' | 'voided' | 'draft' } | null>;
  applyPayment(payload: { payment_id: string; invoice_id: string; amount_cents: number }): Promise<unknown>;
  updateInvoice(payload: { invoice_id: string; mark: 'paid' | 'voided' }): Promise<unknown>;
};

export function createQboClient(cfg: AppConfig, conn: IntegrationConnection): QboClient {
  const realm = conn.external_account_id;
  const auth = conn.access_token ? { authorization: `Bearer ${conn.access_token}` } : {};
  const base = `${baseUrl(cfg)}/v3/company/${realm}`;
  const t = getHttpTransport();
  return {
    async cdc(entities, changedSince) {
      const qs = `entities=${encodeURIComponent(entities.join(','))}&changedSince=${encodeURIComponent(
        changedSince.toISOString(),
      )}`;
      const res = await t.request({
        method: 'GET',
        url: `${base}/cdc?${qs}`,
        headers: { accept: 'application/json', ...auth },
      });
      if (res.status >= 400) throw httpErr('qbo cdc', res.status, res.body);
      return res.body;
    },
    async getInvoice(invoice_id) {
      const res = await t.request({
        method: 'GET',
        url: `${base}/invoice/${encodeURIComponent(invoice_id)}`,
        headers: { accept: 'application/json', ...auth },
      });
      if (res.status === 404) return null;
      if (res.status >= 400) throw httpErr('qbo getInvoice', res.status, res.body);
      const body = res.body as { Invoice?: { status?: string } } | null;
      const status = body?.Invoice?.status as 'sent' | 'paid' | 'voided' | 'draft' | undefined;
      return status ? { status } : null;
    },
    async applyPayment(payload) {
      const res = await t.request({
        method: 'POST',
        url: `${base}/payment`,
        headers: { ...auth },
        body: payload,
      });
      if (res.status >= 400) throw httpErr('qbo applyPayment', res.status, res.body);
      return res.body;
    },
    async updateInvoice(payload) {
      const res = await t.request({
        method: 'POST',
        url: `${base}/invoice`,
        headers: { ...auth },
        body: payload,
      });
      if (res.status >= 400) throw httpErr('qbo updateInvoice', res.status, res.body);
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
