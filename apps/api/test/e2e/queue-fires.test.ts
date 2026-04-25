// E2E: 30s queue actually FIRES the underlying integration after the delay.
// Uses SEND_DELAY_MS=80 to keep the test fast.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer, type TestServer, api, post } from '../_fixtures/server';

let server: TestServer;
beforeAll(async () => {
  server = await startServer({ send_delay_ms: 80 });
  await post(server, '/dev/seed/connections');
});
afterAll(async () => {
  await server?.stop();
});

describe('queue fire path (§2.5)', () => {
  it('approve invoice.remind → wait → action succeeded + email landed in mock store + audit captured request/response', async () => {
    await post(server, '/webhooks/dropboxsign', {
      event: {
        type: 'signature_request_signed',
        signature_request_id: 'sig_q_unused', // throwaway to keep webhook surface warm
        title: 'noop',
        recipient: 'noop@example.com',
        client_name: 'noop',
      },
    });

    await post(server, '/dev/ingest', {
      source: 'qbo',
      type: 'invoice.aging_60',
      subject_ref: 'invoice:Q-FIRE',
      payload: {
        invoice_id: 'INV-Q-FIRE',
        client_id: '00000000-0000-0000-0000-000000000123',
        amount_cents: 100_000,
        currency: 'USD',
        issued_at: new Date().toISOString(),
        due_at: new Date().toISOString(),
        days_overdue: 60,
      },
      dedupe_key: 'aging_60',
    });

    const list = await api<{ actions: Array<{ id: string; type: string; subject_ref: string }> }>(
      server,
      '/actions?status=open',
    );
    const draft = list.actions.find((a) => a.type === 'invoice.remind' && a.subject_ref === 'invoice:Q-FIRE');
    expect(draft).toBeTruthy();

    const queued = await post<{ status: string }>(server, `/actions/${draft!.id}/approve`);
    expect(queued.status).toBe('queued_30s');

    // wait for the timer (80ms) + a generous buffer
    await new Promise((r) => setTimeout(r, 400));

    const detail = await api<{ action: { status: string } }>(server, `/actions/${draft!.id}`);
    expect(detail.action.status).toBe('succeeded');

    const mocks = await api<{ sent_emails: Array<{ subject: string }> }>(server, '/dev/mocks');
    expect(mocks.sent_emails.length).toBeGreaterThan(0);

    // §2.6 — audit captured request/response on success
    const audit = await api<{ audit: Array<{ kind: string; http_status: string | null; request: unknown; response: unknown }> }>(
      server,
      `/actions/${draft!.id}`,
    );
    const succeeded = audit.audit.find((a) => a.kind === 'action.succeeded');
    expect(succeeded).toBeTruthy();
    expect(succeeded?.request).toBeTruthy();
    expect(succeeded?.response).toBeTruthy();
    expect(succeeded?.http_status).toBe('200');
  });
});
