// Single HTTP transport used by every integration client. In dev with
// USE_INTEGRATION_MOCKS=true, requests are routed to in-process mock
// handlers; otherwise they hit the real provider. Same call sites,
// either way.
//
// We deliberately do NOT use `fetch` here — being explicit about the
// HTTP layer makes mocking straightforward without process-global state
// (no msw worker, no nock interceptor). The integration tests can swap
// the transport directly.

import type { AppLogger } from '../../lib/principal-context.js';

export type HttpRequest = {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  url: string; // absolute
  headers?: Record<string, string>;
  body?: unknown; // serialized as JSON if not a string/Buffer
  // For tests/mocks that want to influence response shape.
  hint?: Record<string, unknown>;
};

export type HttpResponse = {
  status: number;
  headers: Record<string, string>;
  body: unknown; // parsed JSON if Content-Type matches; else raw string
};

export type HttpTransport = {
  request(req: HttpRequest, log?: AppLogger): Promise<HttpResponse>;
};

// Real fetch-based transport. Used when USE_INTEGRATION_MOCKS=false.
class FetchTransport implements HttpTransport {
  async request(req: HttpRequest, log?: AppLogger): Promise<HttpResponse> {
    const init: RequestInit = {
      method: req.method,
      headers: req.headers ?? {},
      ...(req.body !== undefined
        ? {
            body:
              typeof req.body === 'string'
                ? req.body
                : JSON.stringify(req.body),
          }
        : {}),
    };
    if (req.body !== undefined && typeof req.body !== 'string') {
      (init.headers as Record<string, string>)['content-type'] =
        (init.headers as Record<string, string>)['content-type'] ??
        'application/json';
    }
    const res = await fetch(req.url, init);
    const text = await res.text();
    const ct = res.headers.get('content-type') ?? '';
    let body: unknown = text;
    if (ct.includes('application/json') && text.length > 0) {
      try {
        body = JSON.parse(text);
      } catch {
        // leave as text
      }
    }
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      headers[k] = v;
    });
    log?.debug({ method: req.method, url: req.url, status: res.status }, 'http response');
    return { status: res.status, headers, body };
  }
}

let _transport: HttpTransport | null = null;

export function setHttpTransport(t: HttpTransport): void {
  _transport = t;
}

export function getHttpTransport(): HttpTransport {
  if (!_transport) _transport = new FetchTransport();
  return _transport;
}
