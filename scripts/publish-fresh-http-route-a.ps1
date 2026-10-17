$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$project = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $project

function Invoke-Checked([string]$Label, [scriptblock]$Action) {
  Write-Host "==> $Label" -ForegroundColor Cyan
  & $Action
  if ($LASTEXITCODE -ne 0) { throw "$Label failed with exit code $LASTEXITCODE" }
}

Invoke-Checked "Behavioral tests (no payment)" { npm.cmd test }
Invoke-Checked "Build Worker" { npm.cmd run build }

git add README.md package.json public/app.js src/buyer-engine.js src/constants.js src/seller.js test/behavior.test.js test/support/sqlite-d1.js migrations/0006_settlement_preflight.sql scripts/finalize-fresh-http-evidence.mjs scripts/run-fresh-http-route-a.mjs scripts/publish-fresh-http-route-a.ps1
Invoke-Checked "Check staged implementation" { git diff --cached --check }
git diff --cached --quiet
if ($LASTEXITCODE -ne 0) {
  Invoke-Checked "Commit bounded fresh HTTP flow" { git commit -m "Add bounded fresh public HTTP payment evidence" }
}
Invoke-Checked "Publish implementation" { git push }

Invoke-Checked "Apply D1 preflight migration" { npx.cmd wrangler d1 migrations apply pharos-x402-paywalled-api --remote --yes }
Invoke-Checked "Deploy bounded Worker" { npm.cmd run deploy }

# Fixed run ID + durable reconciliation make this resumable. A retry can only
# recover the same authorization; it cannot create a second settlement.
Invoke-Checked "Execute exactly one authorized fresh Route A payment" { node.exe scripts/with-secrets.mjs scripts/run-fresh-http-route-a.mjs }
Invoke-Checked "Finalize sanitized README and acceptance evidence" { node.exe scripts/finalize-fresh-http-evidence.mjs }
Invoke-Checked "Final behavioral tests" { npm.cmd test }

git add README.md evidence/acceptance-status.json evidence/fresh-public-http-route-a.json
Invoke-Checked "Check sanitized evidence" { git diff --cached --check }
git diff --cached --quiet
if ($LASTEXITCODE -ne 0) {
  Invoke-Checked "Commit fresh public HTTP evidence" { git commit -m "Record fresh public HTTP Route A payment" }
}
Invoke-Checked "Publish sanitized evidence" { git push }

Write-Host "Fresh Route A HTTP payment, evidence, publication, and deployment completed." -ForegroundColor Green
