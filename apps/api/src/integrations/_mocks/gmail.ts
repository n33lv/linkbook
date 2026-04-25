import type { HttpRequest, HttpResponse } from '../_http/client.js';
import { jsonResponse, consumeFailureFor } from './transport.js';
import { getMockStore } from './store.js';

// Mock Gmail endpoints (subset of users.messages):
//   POST /gmail/v1/users/me/messages/send         — send a message
//   POST /gmail/v1/users/me/threads/{id}/modify   — apply labels
//   GET  /gmail/v1/users/me/threads/{id}          — fetch thread (bodies)

export async function handleGmail(req: HttpRequest, path: string): Promise<HttpResponse> {
  const fail = consumeFailureFor(`gmail:${req.method} ${path}`);
  if (fail) return fail;

  const store = getMockStore();

  if (req.method === 'POST' && path.endsWith('/messages/send')) {
    const body = req.body as {
      to: string;
      cc?: string[];
      subject: string;
      body: string;
      thread_id?: string | null;
    };
    const id = `gm_${Date.now()}`;
    const sent = {
      to: body.to,
      cc: body.cc ?? [],
      subject: body.subject,
      body: body.body,
      thread_id: body.thread_id ?? null,
      at: new Date().toISOString(),
    };
    store.sent_emails.push(sent);
    return jsonResponse(200, {
      id,
      threadId: body.thread_id ?? `t_${id}`,
      labelIds: ['SENT'],
    });
  }

  const modify = path.match(/^\/gmail\/v1\/users\/me\/threads\/([^/]+)\/modify$/);
  if (req.method === 'POST' && modify) {
    return jsonResponse(200, { id: modify[1], labelIds: ['INBOX'] });
  }

  const fetchThread = path.match(/^\/gmail\/v1\/users\/me\/threads\/([^/]+)$/);
  if (req.method === 'GET' && fetchThread) {
    const id = fetchThread[1] ?? '';
    const messages = Array.from(store.gmail_messages.values()).filter((m) => m.thread_id === id);
    return jsonResponse(200, {
      id,
      messages: messages.map((m) => ({
        id: m.id,
        threadId: m.thread_id,
        labelIds: m.label_ids,
        payload: {
          headers: [
            { name: 'From', value: m.from },
            { name: 'To', value: m.to.join(', ') },
            { name: 'Cc', value: m.cc.join(', ') },
            { name: 'Subject', value: m.subject },
            { name: 'Date', value: m.sent_at },
          ],
          body: { data: Buffer.from(m.body).toString('base64') },
        },
      })),
    });
  }

  return jsonResponse(404, { error: `gmail: unmocked ${req.method} ${path}` });
}
