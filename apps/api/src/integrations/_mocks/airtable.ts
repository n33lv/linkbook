import type { HttpRequest, HttpResponse } from '../_http/client.js';
import { jsonResponse, consumeFailureFor } from './transport.js';
import { getMockStore } from './store.js';

// Mock Airtable endpoints (per the v2 web API):
//   POST   /v0/{baseId}/{tableId}            — create record(s)
//   PATCH  /v0/{baseId}/{tableId}/{recId}    — update record
//   GET    /v0/{baseId}/{tableId}            — list

export async function handleAirtable(req: HttpRequest, path: string): Promise<HttpResponse> {
  const fail = consumeFailureFor(`airtable:${req.method} ${path}`);
  if (fail) return fail;

  const store = getMockStore();

  const m = path.match(/^\/v0\/([^/]+)\/([^/]+)(?:\/([^/]+))?$/);
  if (!m) return jsonResponse(404, { error: 'unmocked airtable path' });
  const [, , , recId] = m;

  if (req.method === 'POST' && !recId) {
    const body = req.body as { records: Array<{ fields: Record<string, unknown> }> };
    const created = body.records.map((r) => {
      const id = `rec_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
      store.airtable_records.set(id, r.fields);
      return { id, fields: r.fields, createdTime: new Date().toISOString() };
    });
    return jsonResponse(200, { records: created });
  }

  if (req.method === 'PATCH' && recId) {
    const body = req.body as { fields: Record<string, unknown> };
    const existing = store.airtable_records.get(recId) ?? {};
    store.airtable_records.set(recId, { ...existing, ...body.fields });
    return jsonResponse(200, { id: recId, fields: store.airtable_records.get(recId) });
  }

  if (req.method === 'GET' && !recId) {
    const records = Array.from(store.airtable_records.entries()).map(([id, fields]) => ({
      id,
      fields,
      createdTime: new Date().toISOString(),
    }));
    return jsonResponse(200, { records });
  }

  return jsonResponse(404, { error: `airtable: unmocked ${req.method} ${path}` });
}
