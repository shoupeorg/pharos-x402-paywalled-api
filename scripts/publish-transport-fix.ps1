$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$project = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $project

function Invoke-Checked([string]$Label, [scriptblock]$Action) {
  Write-Host "==> $Label" -ForegroundColor Cyan
  & $Action
  if ($LASTEXITCODE -ne 0) { throw "$Label failed with exit code $LASTEXITCODE" }
}

Invoke-Checked "Behavioral tests" { npm.cmd test }
Invoke-Checked "Stage correction" { git add README.md SKILL.md evidence/acceptance-status.json evidence/live-paid-run.json package.json public/app.js public/index.html scripts/publish-transport-fix.ps1 scripts/run-http-recovery-demo.mjs scripts/run-live-paid-demo.mjs src/buyer-engine.js src/worker.js test/behavior.test.js test/support/sqlite-d1.js migrations/0005_transport_evidence_correction.sql }
Invoke-Checked "Check staged diff" { git diff --cached --check }
Invoke-Checked "Commit transport correction" { git commit -m "Correct buyer HTTP transport evidence" }
Invoke-Checked "Publish transport correction" { git push }

Invoke-Checked "Apply D1 transport-label migration" { npm.cmd run db:migrate:remote }
Invoke-Checked "Deploy corrected Worker" { npm.cmd run deploy }

# This reuses already-settled authorizations. The Node script proves accounting is
# unchanged and aborts if the server does not identify the response as recovery.
Invoke-Checked "Record no-spend public HTTP recovery" { node.exe scripts/with-secrets.mjs scripts/run-http-recovery-demo.mjs }
Invoke-Checked "Stage recovery evidence" { git add evidence/http-recovery-replay.json }
Invoke-Checked "Commit recovery evidence" { git commit -m "Record public HTTP settlement recovery" }
Invoke-Checked "Publish recovery evidence" { git push }

Write-Host "Transport correction, deployment, and zero-spend HTTP recovery completed." -ForegroundColor Green
