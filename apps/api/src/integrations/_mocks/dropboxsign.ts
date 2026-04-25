import type { HttpRequest, HttpResponse } from '../_http/client.js';
import { jsonResponse, consumeFailureFor } from './transport.js';
import { getMockStore } from './store.js';

// Mock Dropbox Sign endpoints:
//   POST /v3/signature_request/remind/{id}     — send reminder
//   POST /v3/signature_request/send_with_template — create from template
//   POST /v3/signature_request/cancel/{id}     — void

export async function handleDropboxsign(req: HttpRequest, path: string): Promise<HttpResponse> {
  const fail = consumeFailureFor(`dropboxsign:${req.method} ${path}`);
  if (fail) return fail;

  const store = getMockStore();

  const remindMatch = path.match(/^\/v3\/signature_request\/remind\/([^/]+)$/);
  if (req.method === 'POST' && remindMatch) {
    const id = remindMatch[1] ?? '';
    if (!store.contracts.has(id)) return jsonResponse(404, { error: 'signature_request not found' });
    store.contract_reminders.push({ signature_request_id: id, at: new Date().toISOString() });
    return jsonResponse(200, { signature_request_id: id, reminded: true });
  }

  if (req.method === 'POST' && path === '/v3/signature_request/send_with_template') {
    const body = req.body as { template_id: string; recipient: string; title: string };
    const id = `sig_${Date.now()}`;
    store.contracts.set(id, {
      id,
      title: body.title,
      recipient: body.recipient,
      status: 'sent',
      sent_at: new Date().toISOString(),
      signed_at: null,
    });
    return jsonResponse(201, { signature_request_id: id, status: 'sent' });
  }

  const cancelMatch = path.match(/^\/v3\/signature_request\/cancel\/([^/]+)$/);
  if (req.method === 'POST' && cancelMatch) {
    const id = cancelMatch[1] ?? '';
    const c = store.contracts.get(id);
    if (!c) return jsonResponse(404, { error: 'not found' });
    c.status = 'expired';
    return jsonResponse(200, { signature_request_id: id, cancelled: true });
  }

  return jsonResponse(404, { error: `dropboxsign: unmocked ${req.method} ${path}` });
}
