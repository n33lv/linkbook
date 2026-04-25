// E2E: queued_30s rows whose timer would have fired during downtime get
// drained on next boot.
//
// We simulate downtime by stopping server A (after rewinding queued_until
// into the past), then booting server B against the same DB file.
// recoverQueueOnBoot should fire the queued action with random jitter.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  startServer,
  startServerOnExistingDb,
  type TestServer,
  api,
  post,
} from '../_fixtures/server';

let server: TestServer;
beforeAll(async () => {
  server = await startServer({ send_delay_ms: 30_000 }); // long delay so timer doesn't fire mid-test
  await post(server, '/dev/seed/connections');
});
afterAll(async () => {
  await server?.stop();
});

describe('queued_30s recovery on restart (§2.5)', () => {
  it('past-deadline row fires on next boot', async () => {
    await post(server, '/dev/ingest', {
      source: 'qbo',
      type: 'invoice.aging_60',
      subject_ref: 'invoice:RECOV',
      payload: {
        invoice_id: 'INV-RECOV',
        client_id: '00000000-0000-0000-0000-000000000222',
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
    const draft = list.actions.find(
      (a) => a.type === 'invoice.remind' && a.subject_ref === 'invoice:RECOV',
    );
    expect(draft).toBeTruthy();

    await post(server, `/actions/${draft!.id}/approve`);

    // Push the queued_until timestamp 5s into the past via dev route, then
    // stop the server before its in-process timer fires.
    await post(server, '/dev/queue/rewind', { action_id: draft!.id, past_seconds: 5 });
    await server.stop();

    // Boot fresh server pointed at the same DB; recoverQueueOnBoot should
    // fire the queued action with 0–500ms jitter.
    const fresh = await startServerOnExistingDb(server.dbPath, { send_delay_ms: 30_000 });
    try {
      await new Promise((r) => setTimeout(r, 1_000));
      const detail = await api<{ action: { status: string } }>(fresh, `/actions/${draft!.id}`);
      expect(detail.action.status).toBe('succeeded');
    } finally {
      await fresh.stop();
    }
  });
});
