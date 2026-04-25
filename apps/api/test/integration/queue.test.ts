import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer, type TestServer, api, post } from '../_fixtures/server';

let server: TestServer;
beforeAll(async () => {
  server = await startServer();
});
afterAll(async () => {
  await server?.stop();
});

describe('30s send-delay queue end-to-end (§2.5)', () => {
  it('approve invoice.remind → queued_30s; undo → cancelled', async () => {
    await post(server, '/dev/ingest', {
      source: 'qbo',
      type: 'invoice.aging_60',
      subject_ref: 'invoice:test_q1',
      payload: {
        invoice_id: 'INV-Q1',
        client_id: '00000000-0000-0000-0000-000000000010',
        amount_cents: 100_000,
        currency: 'USD',
        issued_at: new Date().toISOString(),
        due_at: new Date().toISOString(),
        days_overdue: 60,
      },
      dedupe_key: 'aging_60',
    });

    const list = await api<{ actions: Array<{ id: string; type: string; status: string }> }>(
      server,
      '/actions?status=open',
    );
    const draft = list.actions.find((a) => a.type === 'invoice.remind' && a.status === 'drafted');
    expect(draft, 'cash chaser should have drafted a reminder').toBeTruthy();

    const approved = await post<{ ok: true; status: string }>(server, `/actions/${draft!.id}/approve`);
    expect(approved.status).toBe('queued_30s');

    const undone = await post<{ ok: true; method: string }>(server, `/actions/${draft!.id}/undo`);
    expect(undone.method).toBe('cancel_queued');

    const detail = await api<{ action: { status: string } }>(server, `/actions/${draft!.id}`);
    expect(detail.action.status).toBe('cancelled');
  });
});
