# Release — Phase 3, role filters, sidebar toggle (2026-09-19)

Built on `0362e0a` (the full-review release). Additive migration `20260919062302_jd_drafts`.

## What ships

- **Suggested job descriptions (Phase 3).** On the New role form, once a catalog role, experience band and
  region are chosen, HR can use a ready-made draft (then edit it), draft one from a few sentences, or paste
  their own. Shared drafts are generated once per role/band/region from catalog fields only, by the configured
  model or the built-in writer, linted for exclusionary wording, cached and reused. "Describe the role" drafts
  are the organisation's own and never cached. A role keeps a frozen copy of its JD plus where it came from.
- **One-row form fields.** Domain, Experience and Region on one row (three columns; wraps on narrow screens).
- **Roles page filters.** Search across title, JD and scorecard; Domain, Experience, Region, Status; shareable
  in the URL; "3 of 12 roles"; Clear filters.
- **Sidebar toggle.** "|←" while open, turning half a circle to "→|" when collapsed, in the brand colour.

## Found in review and fixed before release

| Source | Finding | Fix |
|---|---|---|
| Claude review of the Codex build | Built-in draft text used catalog jargon ("band", "family", "pedigree") and turned the market signal into a requirement ("Exposure to High-growth / expanding") | Rewrote the writer for candidates; tests forbid internal vocabulary at every level |
| Claude review | A draft left "generating" by a stopped process stayed stuck; a requeued failed draft kept attempts = 3 and never ran; "describe" never used the model | Stale-claim recovery, attempts reset, model-first describe; tests |
| Codex review | Requests could start parallel generation outside the job lease; a slow worker could overwrite a newer draft; no quota on queueing shared drafts | Requests only nudge the leased worker; stamped claims; per-person and per-organisation queue quotas; tests |
| Visual review | Sortable column headers in a different case from the others; raw codes ("established", "NA") under role titles | Headers take the header style with a sort arrow; names ("Established · … · North America") |
| Postgres run | `jobs.test.ts` counted runs, which is timing-dependent on Postgres | Now asserts the real guarantee: the work never runs twice at once |

## Validation (release candidate `release/phase3`)

| Check | Result |
|---|---|
| Server tests, SQLite | 1634 / 1634 |
| Server tests, Postgres | 1634 / 1634 |
| Postgres migrations vs schema | match (additive: new table, two nullable/defaulted Role columns) |
| Web tests | 1030 / 1030 |
| Type checks and production builds | clean |
| End-to-end | 10 / 10, including creating a role from a suggested draft |
| Visual audit, 32 pages × 3 widths × 2 themes | no element leaves its card; no page scrolls sideways |
