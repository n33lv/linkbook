// E2E #2: contract.signed → Project Concierge → 4-leg composite → approve →
//   all legs run against mocks → mock store reflects creates →
//   audit captures everything.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer, type TestServer, api, post } from '../_fixtures/server';

let server: TestServer;
beforeAll(async () => {
  server = await startServer();
  await post(server, '/dev/seed/connections');
});
afterAll(async () => {
  await server?.stop();
});

describe('E2E: Project Concierge kickoff composite', () => {
  it('signed → kickoff → approve → all 4 legs succeed', async () => {
    await post(server, '/dev/mocks/reset');
    await post(server, '/dev/seed/connections');

    await post(server, '/webhooks/dropboxsign', {
      event: {
        type: 'signature_request_signed',
        signature_request_id: 'sig_e2e_kickoff',
        title: 'Cypress Bay — Brand System',
        recipient: 'mira@cypress.bay',
        client_name: 'Cypress Bay',
      },
    });

    const list = await api<{ actions: Array<{ id: string; type: string; subject_ref: string }> }>(
      server,
      '/actions?status=open',
    );
    const kickoff = list.actions.find((a) => a.type === 'project.kickoff');
    expect(kickoff).toBeTruthy();

    const approved = await post<{ status: string }>(server, `/actions/${kickoff!.id}/approve`);
    expect(approved.status).toBe('succeeded');

    // verify legs
    const detail = await api<{ legs: Array<{ status: string; target: string }> }>(
      server,
      `/actions/${kickoff!.id}`,
    );
    expect(detail.legs.every((l) => l.status === 'succeeded')).toBe(true);

    // verify mock store side effects
    const mocks = await api<{
      harvest_projects: Array<{ name: string }>;
      airtable_records: Array<[string, Record<string, unknown>]>;
      drive_folders: Array<{ path: string }>;
      sent_emails: Array<{ to: string; subject: string }>;
    }>(server, '/dev/mocks');
    expect(mocks.harvest_projects.some((p) => p.name.includes('Cypress Bay'))).toBe(true);
    expect(mocks.airtable_records.length).toBeGreaterThan(0);
    expect(mocks.drive_folders.some((f) => f.path.includes('Cypress'))).toBe(true);
    // §2.5 — the welcome email leg is split into a separate queueable
    // email.send_draft action, so it lands in the queue (queued_30s) at
    // approval time, not in sent_emails immediately.
    const queue = await api<{ actions: Array<{ type: string; status: string; subject_ref: string }> }>(
      server,
      '/actions?status=open',
    );
    expect(queue.actions.some((a) => a.type === 'email.send_draft' && a.status === 'queued_30s')).toBe(true);
  });

  it('partial-failure: airtable leg fails 500 → action fails, completed legs stay', async () => {
    await post(server, '/dev/mocks/reset');
    await post(server, '/dev/seed/connections');

    // Inject failure for the airtable POST (the 2nd leg).
    await post(server, '/dev/mocks/fail-next', { key: 'airtable:POST /v0/app_demo/tbl_projects', status: 500 });

    await post(server, '/webhooks/dropboxsign', {
      event: {
        type: 'signature_request_signed',
        signature_request_id: 'sig_e2e_partial',
        title: 'Foxglove Press — Editorial',
        recipient: 'editor@foxglove.press',
        client_name: 'Foxglove Press',
      },
    });

    const list = await api<{ actions: Array<{ id: string; type: string }> }>(server, '/actions?status=open');
    const kickoff = list.actions.find((a) => a.type === 'project.kickoff');
    expect(kickoff).toBeTruthy();

    // approve — should fail mid-composite
    await post(server, `/actions/${kickoff!.id}/approve`).then(
      () => {
        throw new Error('expected execute to fail');
      },
      (err: Error) => expect(err.message).toContain('502'),
    );

    const detail = await api<{ action: { status: string }; legs: Array<{ order: number; status: string; target: string }> }>(
      server,
      `/actions/${kickoff!.id}`,
    );
    expect(detail.action.status).toBe('failed');
    const sortedLegs = detail.legs.slice().sort((a, b) => a.order - b.order);
    expect(sortedLegs[0]!.status).toBe('succeeded'); // harvest leg done
    expect(sortedLegs[1]!.status).toBe('failed'); // airtable leg failed
    expect(sortedLegs[2]!.status).toBe('drafted'); // never ran
    expect(sortedLegs[3]!.status).toBe('drafted');
  });
});
