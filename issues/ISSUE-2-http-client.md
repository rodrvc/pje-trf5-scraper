---
id: ISSUE-2
title: HTTP client (session, encoding, retries)
status: done
---

## Goal

The foundation everything else rests on: a client that keeps the JSF session
alive, decodes text correctly, and survives rate limiting.

Resolves problems 1, 8 and 9 in `PROBLEMS.md`.

## Scope

Split in two layers, so transport does not know the domain:

**`HttpClient` — transport only** (knows nothing about JSF)
- Shared cookie jar, so the session survives across requests
- Follow redirects (needed for PDFs, see ISSUE-6)
- Explicit decoding, since the site's encoding is not uniform
- Configurable delay and **concurrency 1** (this is a real court's site;
  restraint is judgement, not timidity)
- **Exponential backoff on 429**, honouring `Retry-After` when present, with
  jitter and an attempt ceiling. Applies to 503 and transient network errors too
- Circuit breaker: after N consecutive 429s, abort cleanly rather than press on

**`JsfSession` — JSF protocol**, on top of the above
- ViewState **per view**, not global: the detail view's differs from search
- Refresh the ViewState with every response

**Expired session as a first-class error**
A long run will lose its session, and that arrives as **200 + the home page**,
not an HTTP error. It must be detected, the session re-established, the
ViewState refreshed and the operation retried. Interacts with ISSUE-6: a `cid`
obtained before the drop is worthless afterwards.

**JSF-generated ids** (`j_id244`, scroller ids): these change if the court
redeploys. Centralised in a constants module with a note on how to rediscover
them, and derived from the markup at runtime where possible.

## Acceptance

- A GET to the home page returns HTML with correct accents and a valid ViewState.
- Backoff logic is verified with tests and a mock HTTP server (not by triggering
  429s against a real court's site).
- A dropped session is detected and re-established without aborting the run.

## Resolution

Implemented in three pieces, transport separated from protocol:

**`src/http/backoff.ts`** — pure delay computation. Split out from the client
precisely so it can be tested exhaustively without a network: that is what makes
the 429 handling demonstrable without hammering the live site.
`parseRetryAfter()` understands both header formats (seconds and HTTP date) and
never returns negative. Jitter keeps simultaneous failures from retrying in
lockstep.

**`src/http/client.ts`** — transport only:
- cookie jar (tough-cookie) and redirects, needed for PDFs
- byte-based encoding detection (see ISSUE-3, where the mixed encoding surfaced)
- **concurrency 1** via an internal queue, plus a configurable delay
- retries on 429/502/503/504 and transient network errors
- server `Retry-After` takes precedence over our own backoff, but is still
  capped so an outlandish value cannot stall the run
- circuit breaker: after N consecutive 429s it aborts instead of insisting

**`src/pje/session.ts`** — JSF protocol on top of the client:
- ViewState **per view** (`Map<View, string>`), since detail differs from search
- expired-session detection: PJe answers neither 401 nor 403 but 200 with an
  empty form, so it is recognised by content. On detection it re-establishes and
  retries **once** (a second failure means something else is wrong and should
  propagate rather than loop)
- partial AJAX responses are judged by a different standard than full loads:
  they only count as expired if they also lost the ViewState

**`src/pje/constants.ts`** — JSF ids centralised. They are generated and change
on redeploy, so alongside the constant there is a `discoverSearchComponentId()`
that derives them from the markup at runtime.

### Verification

`npm test`: **30 tests green**, no network (nock). They cover exponential
backoff, both `Retry-After` formats, retry exhaustion, the circuit breaker and
its reset, decoding, download redirects, request pacing and serialization of
concurrent calls.

Smoke test against the live site: session opened (200), ViewState captured,
accents correct, and `discoverSearchComponentId()` derived `fPP:j_id244` from
the markup on its own, matching the constant. The reCAPTCHA remains disabled.
