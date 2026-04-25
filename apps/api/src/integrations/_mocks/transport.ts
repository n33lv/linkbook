import type { HttpRequest, HttpResponse, HttpTransport } from '../_http/client.js';
import { getMockStore } from './store.js';
import { handleQbo } from './qbo.js';
import { handleHarvest } from './harvest.js';
import { handleDropboxsign } from './dropboxsign.js';
import { handleAirtable } from './airtable.js';
import { handleGmail } from './gmail.js';

// Route HTTP requests to per-source mock handlers based on the URL host.
// Each handler returns a response object (status + body). Failures injected
// via the FailureRegistry preempt the handler.

export class MockTransport implements HttpTransport {
  async request(req: HttpRequest): Promise<HttpResponse> {
    const url = new URL(req.url);
    const host = url.host;
    const path = url.pathname;

    // Allow tests to inject the next failure for a key. Mock handlers
    // call `consumeFailureFor(<key>)` at their entry; if a failure is
    // queued, they short-circuit with that response.
    const store = getMockStore();
    void store;

    const route = (handler: () => Promise<HttpResponse>): Promise<HttpResponse> => handler();

    if (host.endsWith('intuit.com') || host.includes('quickbooks')) {
      return route(() => handleQbo(req, path));
    }
    if (host.includes('harvestapp.com') || host.includes('harvest.com')) {
      return route(() => handleHarvest(req, path));
    }
    if (host.includes('dropboxsign.com') || host.includes('hellosign.com')) {
      return route(() => handleDropboxsign(req, path));
    }
    if (host.includes('airtable.com')) {
      return route(() => handleAirtable(req, path));
    }
    if (host.includes('googleapis.com') || host.includes('gmail.com')) {
      return route(() => handleGmail(req, path));
    }

    return {
      status: 404,
      headers: {},
      body: { error: `unmocked host: ${host}` },
    };
  }
}

export function jsonResponse(status: number, body: unknown): HttpResponse {
  return {
    status,
    headers: { 'content-type': 'application/json' },
    body,
  };
}

export function consumeFailureFor(key: string): HttpResponse | null {
  const store = getMockStore();
  const f = store.failures.consume(key);
  if (!f) return null;
  return {
    status: f.status,
    headers: { 'content-type': 'application/json' },
    body: f.body ?? { error: `injected failure (${f.status})` },
  };
}
