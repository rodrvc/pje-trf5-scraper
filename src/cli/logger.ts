/**
 * Renders orchestrator events as short, human-readable progress lines
 * (ISSUE-8's "current window, cases found, PDFs downloaded, 429 retries").
 *
 * `format` is exported and kept pure (`OrchestratorLogEvent -> string`) so
 * tests can check the wording directly, without capturing `console.log` or
 * spinning up a `ConsoleLogger`. `ConsoleLogger` itself is the thin
 * `LogSink` adapter the CLI wires into `Scraper`; a retry-info line
 * (`HttpClientOptions.onRetry`) is rendered by the same `formatRetry` helper
 * so both call sites (orchestrator events and raw HTTP retries) share one
 * line format.
 */

import type { OrchestratorLogEvent } from '../pipeline/orchestrator.js';
import type { SweepEvent } from '../pipeline/sweep.js';

function queryLabel(query: { from: string; to: string; judicialClassId?: string; partyName?: string }): string {
  const range = query.from === query.to ? query.from : `${query.from}..${query.to}`;
  const parts = [range];
  if (query.judicialClassId !== undefined) parts.push(`class=${query.judicialClassId}`);
  if (query.partyName !== undefined) parts.push(`party=${query.partyName}`);
  return parts.join(' ');
}

/** One line per `SweepEvent` variant - see that type's doc comment for what each means. */
function formatSweep(event: SweepEvent): string {
  const label = queryLabel(event.query);
  switch (event.type) {
    case 'window':
      return `search ${label} -> ${event.rows.length} rows`;
    case 'capped':
      return `search ${label} -> ${event.rows.length} rows (capped, splitting by ${event.splitBy})`;
    case 'unsplittable':
      return `search ${label} -> ${event.rows.length} rows (capped, unsplittable)`;
    case 'covered':
      return `cover ${label} -> ${event.unionSize} cases (${event.filtersTried} filters, plateaued)`;
    case 'abandoned':
      return `cover ${label} -> ${event.unionSize} cases (${event.filtersTried} filters, abandoned)`;
    case 'skipped':
      return `search ${label} skipped (already covered)`;
    case 'rejected':
      return `search ${label} rejected: ${event.message}`;
  }
}

/** One line per `OrchestratorLogEvent` kind; sweep events delegate to `formatSweep`. */
export function format(event: OrchestratorLogEvent): string {
  switch (event.kind) {
    case 'sweep':
      return formatSweep(event.event);
    case 'case-detailed':
      return `case ${event.number} detailed`;
    case 'case-failed':
      return `case ${event.number} FAILED: ${event.reason}`;
    case 'document-downloaded':
      return `pdf ${event.caseNumber} doc ${event.documentId} ${event.skipped ? 'skipped (already on disk)' : 'saved'}`;
    case 'document-failed':
      return `pdf ${event.caseNumber} doc ${event.documentId} FAILED: ${event.reason}`;
    case 'run-aborted':
      return `run aborted: ${event.reason}`;
    case 'classSplitCheck':
      return event.ok === undefined
        ? `class-split check ${event.day}: ${event.childrenRows} rows (inconclusive - interrupted or resumed)`
        : `class-split check ${event.day}: ${event.childrenRows} rows (${event.ok ? 'ok' : 'SHORTFALL - catalog may be missing a class'})`;
  }
}

/** Renders one `HttpClientOptions.onRetry` callback, same line style as everything else. */
export function formatRetry(info: { attempt: number; delayMs: number; url: string }): string {
  return `429 -> waiting ${(info.delayMs / 1000).toFixed(1)}s (attempt ${info.attempt})`;
}

function timestamp(): string {
  return new Date().toTimeString().slice(0, 8);
}

/** `LogSink` that prints one timestamped line per event to stdout. */
export class ConsoleLogger {
  log(event: OrchestratorLogEvent): void {
    console.log(`${timestamp()} ${format(event)}`);
  }

  /** Not part of `LogSink` - wired directly into `HttpClientOptions.onRetry`. */
  retry(info: { attempt: number; delayMs: number; url: string }): void {
    console.log(`${timestamp()} ${formatRetry(info)}`);
  }
}
