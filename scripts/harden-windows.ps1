<#
.SYNOPSIS
  Restricts filesystem access to Questor's candidate data on a shared Windows machine.

.DESCRIPTION
  Questor's SQLite database holds candidate names, emails, resume text and full
  interview transcripts in plaintext, and server/.env holds the LLM API key and
  the JWT signing secret.

  By default these inherit permissions that grant BUILTIN\Users read access and
  NT AUTHORITY\Authenticated Users modify access. On a machine shared by several
  HR staff that means every account can read the candidate database — and change
  assessments in it — without ever logging into the application. No amount of
  application-level authorisation helps when the file itself is world-writable.

  This script removes inheritance and grants access only to SYSTEM,
  Administrators and one named operator account.

.PARAMETER Operator
  The Windows account that runs the Questor server, e.g. "MACHINE\questor" or
  "DOMAIN\alice". Only this account (plus SYSTEM/Administrators) keeps access.

.PARAMETER RepoRoot
  Path to the Questor checkout. Defaults to the parent of this script.

.EXAMPLE
  .\harden-windows.ps1 -Operator "$env:COMPUTERNAME\questor"

.NOTES
  Run in an elevated PowerShell. This protects against other LOGGED-IN USERS of
  the same machine. It does NOT protect against: an administrator, anyone who
  boots from external media, or theft of the drive. For those you need full-disk
  encryption (BitLocker) as well — see docs/DEPLOYMENT.md.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Operator,
  [string]$RepoRoot = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = 'Stop'

function Protect-Path {
  param([string]$Target, [switch]$IsDirectory)

  if (-not (Test-Path $Target)) {
    Write-Warning "Skipping (not found): $Target"
    return
  }

  Write-Host "Securing $Target" -ForegroundColor Cyan

  # /inheritance:r drops inherited ACEs — without this, removing the group
  # grants below is pointless because they are re-inherited from the parent.
  & icacls $Target /inheritance:r | Out-Null
  & icacls $Target /grant:r "*S-1-5-18:(F)" | Out-Null           # NT AUTHORITY\SYSTEM
  & icacls $Target /grant:r "*S-1-5-32-544:(F)" | Out-Null       # BUILTIN\Administrators

  # SQLite writes -wal/-shm/-journal siblings, so the operator needs Modify on
  # the CONTAINING DIRECTORY, not just the .db file — locking down the file
  # alone produces "attempt to write a readonly database" at runtime.
  # (OI)(CI) propagates the grant to files created later.
  if ($IsDirectory) {
    & icacls $Target /grant:r "${Operator}:(OI)(CI)(M)" | Out-Null
  } else {
    & icacls $Target /grant:r "${Operator}:(M)" | Out-Null
  }

  # Belt and braces: explicitly strip the broad principals in case a parent ACL
  # is reapplied later by policy or by a careless copy.
  foreach ($sid in @('*S-1-5-32-545', '*S-1-5-11', '*S-1-1-0')) {  # Users, Authenticated Users, Everyone
    & icacls $Target /remove:g $sid 2>$null | Out-Null
  }
}

Write-Host "Questor — restricting access to candidate data" -ForegroundColor Green
Write-Host "Operator account: $Operator"
Write-Host "Repo root:        $RepoRoot`n"

# The whole data directory, so journal/WAL siblings are covered too. SQLite
# writes -wal and -shm files next to the database; securing only the .db would
# leave recent transactions readable.
$dataDir = Join-Path $RepoRoot 'server\prisma\data'
Protect-Path $dataDir -IsDirectory

Protect-Path (Join-Path $RepoRoot 'server\.env')

Write-Host "`nResulting permissions:" -ForegroundColor Green
& icacls (Join-Path $dataDir 'questor.db') 2>$null

Write-Host @"

Done. Still required, and NOT handled by this script:
  1. Enable BitLocker on this drive. File ACLs are enforced by Windows while it
     is running; they are meaningless to anyone who boots another OS.
  2. Give each HR staff member their own Windows account. Shared logins make the
     application audit log unattributable — you cannot show who viewed or
     changed a candidate's assessment.
  3. Back up the database somewhere equally protected. An unencrypted backup on
     a USB stick undoes all of the above.
"@ -ForegroundColor Yellow
