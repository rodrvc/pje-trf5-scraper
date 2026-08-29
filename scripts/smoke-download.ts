/**
 * Live smoke test for ISSUE-6: download exactly one real document end-to-end
 * against the actual TRF5 site. Not part of the automated test suite - run
 * manually with `npx tsx scripts/smoke-download.ts`, then delete this file
 * and the downloaded PDF (or leave the PDF out of git; `pdfs/` is
 * gitignored).
 */
import { HttpClient } from '../src/http/client.js';
import { JsfSession } from '../src/pje/session.js';
import { PjeSearch } from '../src/pje/search.js';
import { PjeDetail } from '../src/pje/detail.js';
import { PjeDownloader } from '../src/pje/download.js';

async function main() {
  const http = new HttpClient({ delayMs: 1500 });
  const session = new JsfSession(http);
  const search = new PjeSearch(session);
  const detail = new PjeDetail(session);

  const result = await search.search({ from: '2026-01-05', to: '2026-01-06' });
  console.log(`search: ${result.rows.length} rows, capped=${result.capped}`);

  let chosenCase;
  let chosenDoc;
  for (const row of result.rows) {
    const legalCase = await detail.fetch(row.ca, row.number);
    if (legalCase.sealed) continue;
    if (legalCase.documents.length > 0) {
      chosenCase = legalCase;
      chosenDoc = legalCase.documents[0];
      break;
    }
  }

  if (chosenCase === undefined || chosenDoc === undefined) {
    console.log('No case with documents found in this window; try a different date range.');
    return;
  }

  console.log(`case: ${chosenCase.number}`);
  console.log(`document: ${chosenDoc.name} (${chosenDoc.kind}), date=${chosenDoc.date}`);

  const downloader = new PjeDownloader({ session, http, rootDir: 'pdfs' });
  const downloadResult = await downloader.download(chosenCase.number, chosenDoc, chosenCase.ca);
  console.log(JSON.stringify(downloadResult, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
