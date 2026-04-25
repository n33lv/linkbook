import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer, type TestServer, api, post } from '../_fixtures/server';

let server: TestServer;
beforeAll(async () => {
  server = await startServer();
});
afterAll(async () => {
  await server?.stop();
});

describe('integration webhooks → ingestion', () => {
  it('Dropbox Sign signed → contract.signed event + concierge proposal with 4 legs', async () => {
    await post(server, '/webhooks/dropboxsign', {
      event: {
        type: 'signature_request_signed',
        signature_request_id: 'sig_test_signed',
        title: 'Northbeam — MSA',
        recipient: 'mira@northbeam.com',
        client_name: 'Northbeam Inc.',
      },
    });

    const inbox = await api<{ events: Array<{ id: string; type: string; subject_ref: string }> }>(
      server,
      '/inbox',
    );
    const ev = inbox.events.find((e) => e.type === 'contract.signed');
    expect(ev, 'expected contract.signed event in inbox').toBeTruthy();

    const list = await api<{ actions: Array<{ id: string; type: string; status: string }> }>(
      server,
      '/actions?status=open',
    );
    const kickoff = list.actions.find((a) => a.type === 'project.kickoff');
    expect(kickoff, 'concierge should have drafted kickoff').toBeTruthy();

    const detail = await api<{ legs: Array<{ id: string; target: string; status: string; order: number }> }>(
      server,
      `/actions/${kickoff!.id}`,
    );
    expect(detail.legs.length).toBe(4);
    expect(detail.legs.map((l) => l.target).sort()).toEqual([
      'airtable:insert_record',
      'drive:create_folder',
      'gmail:draft_welcome',
      'harvest:create_project',
    ]);
  });

  it('Harvest webhook → invoice.draft_ready_to_send event surfaces in inbox', async () => {
    await post(server, '/webhooks/harvest', {
      event: {
        type: 'invoice.draft_ready',
        payload: {
          harvest_invoice_id: 'H-WHX',
          client_id: '00000000-0000-0000-0000-000000000020',
          amount_cents: 250_000,
        },
      },
    });
    const inbox = await api<{ events: Array<{ type: string; subject_ref: string }> }>(server, '/inbox');
    const ev = inbox.events.find((e) => e.type === 'invoice.draft_ready_to_send' && e.subject_ref === 'invoice:H-WHX');
    expect(ev).toBeTruthy();
  });

  it('reconciler stays manual at low confidence', async () => {
    await post(server, '/dev/ingest', {
      source: 'qbo',
      type: 'payment.received_unapplied',
      subject_ref: 'payment:test_lowconf',
      payload: {
        qbo_payment_id: 'pay_test_lowconf',
        customer_name_raw: 'STELLATE STUDIOS LLC',
        amount_cents: 640_000,
        received_at: new Date().toISOString(),
        candidate_invoice_ids: ['inv_a', 'inv_b', 'inv_c'], // multi → low conf in stub
      },
      dedupe_key: 'unapplied',
    });
    const inbox = await api<{ events: Array<{ type: string; subject_ref: string }> }>(server, '/inbox');
    expect(inbox.events.some((e) => e.subject_ref === 'payment:test_lowconf')).toBe(true);

    const list = await api<{ actions: Array<{ type: string; subject_ref: string; status: string }> }>(
      server,
      '/actions?status=open',
    );
    expect(list.actions.some((a) => a.subject_ref === 'payment:test_lowconf' && a.type === 'payment.apply')).toBe(false);
  });
});
