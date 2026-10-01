import { describe, expect, it } from 'vitest';

import { formatProjectNumber } from './projectNumber.js';

describe('formatProjectNumber', () => {
  it('formats PRJ project IDs with a five-digit sequence', () => {
    expect(formatProjectNumber(2026, 1)).toBe('PRJ-2026-00001');
    expect(formatProjectNumber(2026, 42)).toBe('PRJ-2026-00042');
  });
});
