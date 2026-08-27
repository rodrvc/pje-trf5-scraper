---
id: ISSUE-6
title: PDF downloads
status: todo
---

## Goal

Download attached documents with descriptive names. Requirement 2 of the brief.

Resolves problem 7 in `PROBLEMS.md`. The mechanism is already verified by hand:
a real 19 KB PDF was downloaded.

## Scope

- Build the document GET with `idBin`, `numeroDocumento`, `nomeArqProcDocBin`,
  `idProcessoDocumento` and `actionMethod`
- **Follow the redirect right away**: it leads to `download.seam?cid=<N>`, where
  the `cid` is ephemeral, single-use and session-bound. Reusing it returns 404,
  so links cannot be collected for later bulk download
- Store organised by case:

      pdfs/<CNJ-number>/<date>_<kind>_<documentId>.pdf

- Sanitise the filename **after** decoding. The `documentId` is what guarantees
  uniqueness: sanitising can collapse two distinct readable names into one, so
  the readable part is decorative and the id always travels
- Write to a temp file and rename on completion, so an interrupted run does not
  leave a truncated PDF that later looks valid

## Validation

- Check `Content-Type: application/pdf` before writing. An HTML response means a
  dropped session or an error: treat as failure and re-establish
- Verify the written file's `%PDF` magic header

## Acceptance

- Downloaded PDFs open correctly.
- Failures are recorded for later retry (ISSUE-7).

## Resolution

_(pending)_
