# Deploying Questor on a shared office machine

Questor stores real candidate personal data: names, emails, phone numbers, full
resume text, complete interview transcripts and assessments. This document is
about protecting that data on a single Windows machine used by several HR staff.

Read the whole page before the first real interview. Some of what follows is a
limitation you need to accept and work around, not a step you can complete.

---

## What protects the data, and what each measure misses

| Control | Protects against | Does **not** protect against | Status |
| --- | --- | --- | --- |
| Application auth | Anyone without a login | Anyone who opens the database file directly | built in |
| NTFS permissions (`scripts/harden-windows.ps1`) | Other logged-in users of this machine | Local administrators; booting from a USB stick | **run this** |
| Full-disk encryption | Drive theft, offline access | **Anything while the machine is on and logged in** | see below |
| Field-level encryption | Reading PII straight out of the DB file | Anyone who can call the application | **not implemented** |

The row that surprises people is full-disk encryption. It is not a general
answer here: once Windows has booted and someone is logged in, the volume is
unlocked and every file is readable by any process with filesystem permission.
It defends a stolen laptop, not a shared desk.

---

## Step 1 — Restrict filesystem access (do this first)

By default the database file inherits permissions granting
`NT AUTHORITY\Authenticated Users` **Modify**. On a shared machine that means
every account can read the candidate database *and rewrite assessments in it*,
without ever logging into Questor. Application-level authorisation is irrelevant
against direct file access.

In an **elevated** PowerShell:

```powershell
cd <repo>\scripts
.\harden-windows.ps1 -Operator "$env:COMPUTERNAME\<the-account-that-runs-questor>"
```

The server checks this at boot. If broad principals still hold access it warns in
development and **refuses to start in production** (`DB_WORLD_READABLE`).

## Step 2 — Give every HR user their own Windows account

Not cosmetic. Questor's audit log records *who* viewed and changed each
assessment. Under a shared Windows login every action is attributable only to
"the desk", which means you cannot answer "who accessed this candidate's data?"
— a question GDPR Art. 15 and DPDP give candidates the right to ask.

## Step 3 — Disk encryption, honestly

**This machine runs Windows 11 Home Single Language.** That constrains the
options:

- **EFS (per-file, per-user encryption) is not available on Home.** On Pro and
  above EFS would be the strongest control here, because it ties decryption to
  one user account and blocks other logged-in users. You cannot use it.
- **Full BitLocker management is a Pro feature.** Home may offer "Device
  Encryption" if the hardware supports it (Settings → Privacy & security →
  Device encryption). Turn it on if the option exists. If it does not, this
  machine has no disk encryption available without upgrading the Windows edition.

So on Home, your realistic protection against another user of the same machine
is **Step 1 (NTFS permissions) plus separate user accounts** — not encryption.
If the threat you care about is a colleague reading candidate transcripts, fix
the permissions; do not assume encryption is covering you.

Consider upgrading to Windows 11 Pro if this machine will hold candidate data
long term. It is the cheapest way to get both BitLocker and EFS.

## Step 4 — Secrets

`server/.env` holds the LLM API key and the JWT signing secret. Step 1 restricts
it. Additionally:

- Generate a real `AUTH_SECRET` — the repo's default is published on GitHub and
  anyone who reads it can forge an admin session:
  ```
  node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
  ```
- Set a hard spend cap on the LLM API key. The candidate portal is
  unauthenticated by design and every answer costs money.
- Rotate the key if it has ever been shared, pasted, or stored elsewhere.

## Step 5 — Backups

Back up `server/prisma/data/`. Apply the same restrictions to wherever the backup
lands — an unencrypted copy on a USB stick or a personal cloud drive undoes
everything above, and is itself a reportable data transfer.

---

## Known limitation: the database file is not encrypted

Candidate data is stored in plaintext inside the SQLite file. This is a real gap
and it is not currently closed.

Why it is not simply switched on:

- **Prisma cannot use an encrypted SQLite file.** Prisma's CLI (`migrate`,
  `db push`, Studio) bypasses Node driver adapters and opens the file with its
  own Rust engine, so a SQLCipher-encrypted database breaks every migration
  command. Runtime-only adapters do not solve it.
- **Community PostgreSQL has no transparent data encryption either.** Moving to
  Postgres improves concurrency, backups and access control, but on its own it
  does not encrypt data at rest.

The workable route is **application-level field encryption** of the sensitive
columns (`Candidate.fullName/email/phone`, `CandidateProfileVersion.rawText`,
`Turn.text`, `AssessmentVersion.resultJson`), encrypting in the application and
storing ciphertext. The tradeoff is that encrypted columns can no longer be
searched or filtered in SQL.

Until that exists, treat Step 1 and Step 2 as the controls that are actually
holding, and size the risk accordingly.

---

## Before the first real candidate

- [ ] `scripts/harden-windows.ps1` run; server starts with no `DB_WORLD_READABLE` warning
- [ ] Separate Windows account per HR user
- [ ] Device encryption enabled if this hardware offers it
- [ ] Real `AUTH_SECRET` generated; demo account (`demo@questor.local`) deleted
- [ ] LLM key rotated, spend cap set
- [ ] Backups configured, and the backup location restricted too
- [ ] Candidate notices reviewed by counsel — see `docs/compliance/`
- [ ] Shadow mode run and agreement measured — see `docs/VALIDATION.md`

The last two are not engineering tasks and cannot be signed off from inside this
repository.
