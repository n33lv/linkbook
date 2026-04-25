import type { HttpRequest, HttpResponse } from '../_http/client.js';
import { jsonResponse, consumeFailureFor } from './transport.js';
import { getMockStore } from './store.js';

// Mock Harvest endpoints:
//   POST /v2/invoices/{id}/messages   — send the drafted invoice
//   POST /v2/projects                 — create project (kickoff leg)
//   POST /v2/time_entries             — log time
//   GET  /v2/time_entries             — list
//   PATCH /v2/projects/{id}           — archive

export async function handleHarvest(req: HttpRequest, path: string): Promise<HttpResponse> {
  const fail = consumeFailureFor(`harvest:${req.method} ${path}`);
  if (fail) return fail;

  const store = getMockStore();

  // Send invoice
  const sendMatch = path.match(/^\/v2\/invoices\/([^/]+)\/messages$/);
  if (req.method === 'POST' && sendMatch) {
    const id = sendMatch[1] ?? '';
    const inv = store.invoices.get(id);
    if (!inv) return jsonResponse(404, { error: 'invoice not found' });
    inv.status = 'sent';
    return jsonResponse(201, { id, status: 'sent', sent_at: new Date().toISOString() });
  }

  // Create project (kickoff leg)
  if (req.method === 'POST' && path === '/v2/projects') {
    const body = req.body as { name: string; client_id: string; budget_hours: number };
    const id = `harvest_proj_${Date.now()}`;
    store.harvest_projects.set(id, {
      id,
      name: body.name,
      client_id: body.client_id,
      budget_hours: body.budget_hours,
    });
    return jsonResponse(201, { id, ...body });
  }

  // Archive project
  const archiveMatch = path.match(/^\/v2\/projects\/([^/]+)$/);
  if (req.method === 'PATCH' && archiveMatch) {
    const id = archiveMatch[1] ?? '';
    if (!store.harvest_projects.has(id)) return jsonResponse(404, { error: 'project not found' });
    return jsonResponse(200, { id, archived: true });
  }

  // Log time
  if (req.method === 'POST' && path === '/v2/time_entries') {
    const body = req.body as {
      user_id: string;
      project_id: string;
      date: string;
      hours: number;
      notes?: string | null;
    };
    const id = `harvest_te_${Date.now()}`;
    store.time_entries.set(id, {
      id,
      user_id: body.user_id,
      project_id: body.project_id,
      date: body.date,
      hours: body.hours,
      notes: body.notes ?? null,
    });
    return jsonResponse(201, { id, ...body });
  }

  // List time entries
  if (req.method === 'GET' && path === '/v2/time_entries') {
    return jsonResponse(200, {
      time_entries: Array.from(store.time_entries.values()),
    });
  }

  return jsonResponse(404, { error: `harvest: unmocked ${req.method} ${path}` });
}
