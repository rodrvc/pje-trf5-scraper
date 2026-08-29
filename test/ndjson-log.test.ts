import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ParseError } from '../src/domain/errors.js';
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

  // B1: a torn last line must not poison the next append by getting
  // concatenated onto it.
  it('repairs a torn tail before appending, instead of concatenating onto it', async () => {
    // Simulate a kill mid-write: a partial line with no trailing newline.
    await mkdir(join(dir, 'nested'), { recursive: true });
    await writeFile(path, '{"a":2', { flag: 'a' });

    await appendLine(path, { a: 3 });

    // Without the repair, this would read back as one single line
    // `{"a":2{"a":3}` - unparseable, losing both records. With the repair,
    // the torn fragment becomes its own (dropped) last-ish line and the new
    // record survives on its own line.
    const records = await readLines(path, (line) => JSON.parse(line) as { a: number });
    expect(records).toEqual([{ a: 3 }]);
  });

  it('repair is a no-op when the file already ends cleanly', async () => {
    await appendLine(path, { a: 1 });
    await appendLine(path, { a: 2 });

    const records = await readLines(path, (line) => JSON.parse(line) as { a: number });
    expect(records).toEqual([{ a: 1 }, { a: 2 }]);
  });

  // B2: only the last non-empty line may be silently dropped as a plausible
  // torn write; corruption anywhere earlier must be raised, not hidden.
  it('tolerates an unparseable LAST line (torn-write branch)', async () => {
    await appendLine(path, { a: 1 });
    await writeFile(path, '{"a":2', { flag: 'a' }); // torn, no trailing \n

    const records = await readLines(path, (line) => JSON.parse(line) as { a: number });
    expect(records).toEqual([{ a: 1 }]);
  });

  it('throws ParseError for an unparseable MIDDLE line instead of silently skipping it', async () => {
    await appendLine(path, { a: 1 });
    // Manually corrupt the file so a non-last line is invalid, and a real
    // last line follows it - the middle line cannot be a torn write, since
    // the write after it necessarily completed.
    await writeFile(path, 'not-json-at-all\n', { flag: 'a' });
    await appendLine(path, { a: 3 });

    await expect(readLines(path, (line) => JSON.parse(line))).rejects.toThrow(ParseError);
  });
});
