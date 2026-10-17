[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Set-StrictMode -Version Latest

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$configPath = Join-Path $projectRoot 'wrangler.jsonc'
$databaseName = 'pharos-x402-paywalled-api'

function Invoke-Checked {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [Parameter(Mandatory = $true)][string[]]$ArgumentList
  )

  & $FilePath @ArgumentList
  if ($LASTEXITCODE -ne 0) {
    throw "Command failed with exit code $LASTEXITCODE`: $FilePath $($ArgumentList -join ' ')"
  }
}

function Get-D1Databases {
  $json = & npx.cmd wrangler d1 list --json
  if ($LASTEXITCODE -ne 0) {
    throw "Unable to list D1 databases (exit code $LASTEXITCODE)."
  }
  $jsonText = $json -join [Environment]::NewLine
  $parsed = ConvertFrom-Json -InputObject $jsonText
  $items = [Collections.Generic.List[object]]::new()
  foreach ($item in $parsed) {
    $items.Add($item)
  }
  return $items.ToArray()
}

Push-Location $projectRoot
try {
  Write-Host '[1/7] Verifying the existing Wrangler session...'
  Invoke-Checked -FilePath 'npx.cmd' -ArgumentList @('wrangler', 'whoami')

  Write-Host '[2/7] Finding or creating the D1 database...'
  $databaseCandidates = @(
    Get-D1Databases |
      Where-Object { [string]$_.name -ceq $databaseName } |
      Sort-Object -Property @{ Expression = { [string]$_.created_at }; Ascending = $true }, @{ Expression = { [string]$_.uuid }; Ascending = $true }
  )
  if ($databaseCandidates.Count -eq 0) {
    Invoke-Checked -FilePath 'npx.cmd' -ArgumentList @('wrangler', 'd1', 'create', $databaseName, '--location', 'apac')
    $databaseCandidates = @(
      Get-D1Databases |
        Where-Object { [string]$_.name -ceq $databaseName } |
        Sort-Object -Property @{ Expression = { [string]$_.created_at }; Ascending = $true }, @{ Expression = { [string]$_.uuid }; Ascending = $true }
    )
  }
  if ($databaseCandidates.Count -eq 0) {
    throw "D1 database '$databaseName' was not available after creation."
  }
  if ($databaseCandidates.Count -gt 1) {
    Write-Warning "Multiple exact-name D1 databases exist. Reusing the earliest one; no database will be deleted or modified."
  }

  $selectedDatabase = $databaseCandidates[0]
  $databaseId = ([string]$selectedDatabase.uuid).Trim()
  $uuidPattern = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
  if ($databaseId -notmatch $uuidPattern -or $databaseId.Contains(' ')) {
    throw "Selected D1 database ID is not one single valid UUID."
  }
  Write-Host "Selected one exact-name D1 database: $databaseId"

  Write-Host '[3/7] Writing the real D1 database ID only to the existing DB binding...'
  $config = [IO.File]::ReadAllText($configPath)
  $bindingMatches = [Text.RegularExpressions.Regex]::Matches($config, '"binding"\s*:\s*"DB"')
  if ($bindingMatches.Count -ne 1) {
    throw "Expected exactly one existing D1 binding named DB in wrangler.jsonc; found $($bindingMatches.Count)."
  }
  $objectStart = $config.LastIndexOf('{', $bindingMatches[0].Index)
  $objectEnd = $config.IndexOf('}', $bindingMatches[0].Index)
  if ($objectStart -lt 0 -or $objectEnd -lt 0 -or $objectEnd -le $objectStart) {
    throw 'Could not isolate the existing DB binding object in wrangler.jsonc.'
  }
  $bindingObject = $config.Substring($objectStart, $objectEnd - $objectStart + 1)
  $idMatches = [Text.RegularExpressions.Regex]::Matches($bindingObject, '"database_id"\s*:\s*"[^"]*"')
  if ($idMatches.Count -ne 1) {
    throw "Expected exactly one database_id in the DB binding; found $($idMatches.Count)."
  }
  $updatedBinding = [Text.RegularExpressions.Regex]::Replace(
    $bindingObject,
    '("database_id"\s*:\s*")[^"]*(")',
    [Text.RegularExpressions.MatchEvaluator]{
      param($match)
      return $match.Groups[1].Value + $databaseId + $match.Groups[2].Value
    },
    1
  )
  $updated = $config.Substring(0, $objectStart) + $updatedBinding + $config.Substring($objectEnd + 1)
  [IO.File]::WriteAllText($configPath, $updated, [Text.UTF8Encoding]::new($false))

  Write-Host '[4/7] Applying remote D1 migrations (already-applied migrations are safe)...'
  Invoke-Checked -FilePath 'npm.cmd' -ArgumentList @('run', 'db:migrate:remote')

  Write-Host '[5/7] Building and creating/updating the Worker...'
  Invoke-Checked -FilePath 'npm.cmd' -ArgumentList @('run', 'deploy')

  Write-Host '[6/7] Uploading ACL-protected secrets after verifying their public identities...'
  Invoke-Checked -FilePath 'node.exe' -ArgumentList @('scripts/with-secrets.mjs', 'scripts/put-cloudflare-secrets.mjs')

  Write-Host '[7/7] Performing the final deployment with D1 and secrets configured...'
  Invoke-Checked -FilePath 'npm.cmd' -ArgumentList @('run', 'deploy')

  Write-Host 'Cloudflare bootstrap and deployment completed successfully.'
  Write-Host 'No blockchain transaction was created or broadcast by this script.'
}
finally {
  Pop-Location
}
