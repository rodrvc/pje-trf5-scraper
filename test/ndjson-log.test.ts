import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { appendLine, readLines } from '../src/persistence/ndjson-log.js';

describe('ndjson-log', () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ndjson-log-test-'));
    path = join(dir, 'nested', 'file.ndjson');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('creates the parent directory and writes one line per append', async () => {
    await appendLine(path, { a: 1 });
    await appendLine(path, { a: 2 });

    const content = await readFile(path, 'utf8');
    expect(content.split('\n').filter((l) => l !== '')).toHaveLength(2);

    const records = await readLines(path, (line) => JSON.parse(line) as { a: number });
    expect(records).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('returns an empty array when the file does not exist yet', async () => {
    const records = await readLines(path, (line) => JSON.parse(line));
    expect(records).toEqual([]);
  });

  it('tolerates a truncated last line instead of crashing', async () => {
    await appendLine(path, { a: 1 });
    // Simulate a process killed mid-write: append a torn, unparseable line.
    await writeFile(path, '{"a":2', { flag: 'a' });

    const records = await readLines(path, (line) => JSON.parse(line) as { a: number });
    expect(records).toEqual([{ a: 1 }]);
  });

  it('ignores a blank trailing line', async () => {
    await appendLine(path, { a: 1 });
    const records = await readLines(path, (line) => JSON.parse(line));
    // appendLine always terminates with \n, which readLines must not turn
    // into a spurious empty record.
    expect(records).toHaveLength(1);
  });
});
