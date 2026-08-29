import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { recordUncoverable } from '../src/pipeline/uncoverable.js';
import type { Query } from '../src/domain/types.js';

const leaf: Query = {
  from: '2025-03-12',
  to: '2025-03-12',
  judicialClassId: '202',
  judicialClassName: 'Agravo de Instrumento',
};

describe('recordUncoverable', () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'uncoverable-test-'));
    path = join(dir, 'nested', 'uncoverable.ndjson');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('creates the parent directory and appends one NDJSON line', async () => {
    await recordUncoverable(
      { query: leaf, depth: 2, filtersTried: 12, unionSize: 34, cnjNumbers: ['a', 'b'] },
      path,
    );

    const content = await readFile(path, 'utf8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(1);

    const parsed = JSON.parse(lines[0] ?? '{}');
    expect(parsed).toMatchObject({ query: leaf, depth: 2, filtersTried: 12, unionSize: 34 });
    expect(parsed.cnjNumbers).toEqual(['a', 'b']);
    expect(parsed.rows).toBeUndefined();
    expect(typeof parsed.recordedAt).toBe('string');
    // Must be a valid ISO 8601 timestamp, not just any string.
    expect(Number.isNaN(Date.parse(parsed.recordedAt))).toBe(false);
  });

  it('does not require cnjNumbers', async () => {
    await recordUncoverable({ query: leaf, depth: 0, filtersTried: 3, unionSize: 5 }, path);

    const content = await readFile(path, 'utf8');
    const parsed = JSON.parse(content.trim());
    expect(parsed.cnjNumbers).toBeUndefined();
    expect(parsed.unionSize).toBe(5);
  });

  it('appends rather than overwrites across multiple abandoned leaves', async () => {
    await recordUncoverable({ query: leaf, depth: 1, filtersTried: 5, unionSize: 10 }, path);
    await recordUncoverable(
      { query: { ...leaf, judicialClassId: '283' }, depth: 1, filtersTried: 6, unionSize: 8 },
      path,
    );

    const content = await readFile(path, 'utf8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] ?? '{}').unionSize).toBe(10);
    expect(JSON.parse(lines[1] ?? '{}').unionSize).toBe(8);
  });
});
