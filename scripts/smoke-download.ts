/**
 * Live smoke test for ISSUE-6: download exactly one real document end-to-end
 * against the actual TRF5 site. Not part of the automated test suite (no
 * assertions - it prints what it did) and not run in CI; kept as a permanent,
 * committed tool for re-verifying the mechanism against the real site,
 * runnable via `npm run smoke:download`.
 *
 * Costs ~5 live requests against the court's server (search open, search
 * post, one detail open, the download GET, and the redirect-follow GET), at
 * `delayMs: 1500` between them. The downloaded PDF lands under `pdfs/`,
 * which is gitignored - delete it manually afterwards if you want a clean
 * working tree, but it is never at risk of being committed.
 */
import { HttpClient } from '../src/http/client.js';
import { PjeDetail } from '../src/pje/detail.js';
import { PjeDownloader } from '../src/pje/download.js';
import { PjeSearch } from '../src/pje/search.js';
import { JsfSession } from '../src/pje/session.js';

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

  const downloader = new PjeDownloader({ session, rootDir: 'pdfs' });
  const downloadResult = await downloader.download(chosenCase.number, chosenDoc, chosenCase.ca);
  console.log(JSON.stringify(downloadResult, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
