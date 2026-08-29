# Implementation issues

One issue per module. Created before implementing it; the resolution is written
inside the file itself on close.

The site obstacles that motivate these issues live in `../PROBLEMS.md`.

Board status:

    grep -H '^status:' issues/ISSUE-*.md

| ID | Module | Status |
|----|--------|--------|
| [ISSUE-1](ISSUE-1-setup.md) | Project setup | done |
| [ISSUE-2](ISSUE-2-http-client.md) | HTTP client (session, encoding, 429) | done |
| [ISSUE-3](ISSUE-3-search.md) | Case search | done |
| [ISSUE-4](ISSUE-4-date-sweep.md) | Date-window sweep | done |
| [ISSUE-4b](ISSUE-4b-party-sweep.md) | Party-token sweep | done |
| [ISSUE-5](ISSUE-5-case-detail.md) | Case detail | done |
| [ISSUE-6](ISSUE-6-pdfs.md) | PDF downloads | done |
| [ISSUE-7](ISSUE-7-persistence.md) | Persistence and resuming | done |
| [ISSUE-8](ISSUE-8-cli-readme.md) | CLI, logging and README | todo |
| [ISSUE-9](ISSUE-9-orchestrator.md) | Sweep orchestrator | done |
| [ISSUE-10](ISSUE-10-tests.md) | Test suite with fixtures | todo |
