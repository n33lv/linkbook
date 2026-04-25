import { z } from 'zod';

// §1.1 — the source enum used by the Event envelope and Action catalog.
// `linkbook` is reserved for events emitted by the system itself
// (e.g. integration.disconnected, action.failed, agent.needs_approval).
export const sourceSchema = z.enum([
  'qbo',
  'harvest',
  'dropboxsign',
  'airtable',
  'gmail',
  'linkbook',
]);

export type Source = z.infer<typeof sourceSchema>;
