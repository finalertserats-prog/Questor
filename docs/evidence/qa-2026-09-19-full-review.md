# Full application review — 2026-09-19

Release candidate: branch `audit/integration` (35 commits on top of `6cc33df`, the build then live).
No database schema or migration change.

## Why

The owner found chart labels spilling out of the dashboard's "Top roles" cards in production and asked for
every part of the application to be reviewed and validated before anything else shipped.

## How it was reviewed

1. **Three code audits in parallel** (server-wide, web-wide, and the features added on 2026-09-18):
   3 + 7 high, 29 medium, 28+ low findings in total, most overlapping.
2. **A whole-app visual audit** (`e2e/tests/audit.spec.ts`, run with `AUDIT=1`): signs in as the seeded admin,
   seeds the shapes that broke production (long titles, three roles with the same title, uneven counts),
   follows every internal link, then captures every page as admin, signed-out visitor and demo visitor at
   1440, 834 and 390 px in light and dark — 32 pages, 222 captures — recording console errors, failed API
   requests, sideways page scroll and any element that leaves its card.
3. **Fixes in three isolated lanes** (server core, demo/catalog/metrics, web), each test-first, then merged.
4. **A final Codex review** of the merged diff for regressions and cross-lane contract mismatches.

## What was wrong and is fixed (highlights)

| Area | Before | After |
|---|---|---|
| Dashboard "Top roles" charts | Fixed 120px label column: long titles spilled left out of the card into the neighbouring card; three identical "Senior Backend Engineer (Payments)" bars | Labels sit beside bars only when every label fits; otherwise each label gets its own full-width line above its bar and wraps. Same-titled roles show their level/region ("· Senior", "· Lead", "· Principal"). Values stay 8px inside the card. Rows open the role. |
| Sign-in rate limit | 60 requests/15 min on all of `/api/auth`, including `/me` on every page load — an office behind one IP saw "Too many requests" | Limited only on login and register |
| Shared catalog | A role's inferred or ATS title was published to every organisation | Published only when a person adds it (explicit option, or the visible, labelled checkbox) |
| Archived roles | Only hidden; candidates, interviews and scorecard approval still worked (approval even un-archived) | Closed server-side (409 `role_archived`) and in the UI |
| `/assess-partial` | 500 on every call after writing an audit event | Works; concurrent calls assess once |
| Illegal interview transitions | 500 | 409 with a clear message |
| Feedback email | Marked SENT before sending; a failed send could never be retried | Claimed, sent, then marked; retryable |
| Sign-in email | Case-sensitive | Case-insensitive |
| Scorecard approval | Approved whatever version was newest; managers could approve their own edit | Names the reviewed version; self-approval refused for non-admins |
| Demo | Lock-out after purge; demo tenants in public org search; real Teams/Zoom meetings; no scores in the report; could not add candidates; clashed with real accounts; PII kept forever | All fixed (synthetic demo login, demo role, heuristic grading, anonymisation after purge, scoped limits) |
| Phones and tablets | `/candidates`, candidate detail, the demo pages and the demo candidate list scrolled sideways (up to +386px) | Every page measures exactly the viewport width at 390 and 834 px |
| Text damage | "Engineering ? US ? Senior", chip "React ?", phone "?" | "·", "×", "—" restored; a test now fails on replacement characters |
| Plus | Tables, labels, dark-mode colours, swallowed errors, accessibility (combobox, headings, focus), copy consistency, dead code | See the commit log `6cc33df..HEAD` |

## Validation (all on the merged release candidate)

| Check | Result |
|---|---|
| Server tests, SQLite | 1576 / 1576 pass (was 1434) |
| Server tests, Postgres (production engine) | 1576 / 1576 pass |
| Postgres migrations vs schema | match; no schema change |
| Web tests | 995 / 995 pass (was 890) |
| Type checks (server, web) | clean |
| Production builds (server, web) | succeed |
| End-to-end (Playwright) | 9 / 9 pass, including the new role form and a candidate's typed interview |
| Visual audit | 32 pages × 3 widths × 2 themes: no element leaves its card, no page scrolls sideways. Remaining flags are expected: the observe page's 409 "not live yet" (now shown as information) and a health request React's development mode cancels on purpose |
| Codex review | 3 findings: archived roles (fixed), demo role can archive its own sandbox's roles (accepted, sandbox-only), catalog checkbox default (see below) |

## Open decision for the owner

Codex recommends the "Add this title to the shared role catalog (visible to all organisations)" checkbox
start **unticked**, so publishing always needs an affirmative click. It currently starts **ticked**, following
the owner's decision that roles an organisation adds go straight into the shared catalog. Logged as a
disagreement; one line to change if the owner prefers Codex's default.
