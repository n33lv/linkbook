import { describe, expect, it, beforeAll } from 'vitest';
import { applyTestEnv } from '../_fixtures/env';
beforeAll(() => applyTestEnv());

import { RECONCILER_CONFIDENCE_THRESHOLD } from '@linkbook/types';

describe('reconciler threshold (§5.3)', () => {
  it('threshold is 0.85', () => {
    expect(RECONCILER_CONFIDENCE_THRESHOLD).toBe(0.85);
  });
});
