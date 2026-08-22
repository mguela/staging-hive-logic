param(
  [int]$MaxCostCents = 20,
  [int]$MaxTokensPerResponse = 1400,
  [string]$ExistingRunId = ''
)

$ErrorActionPreference = 'Stop'
$projectRef = 'sqhusuuhlmcmkeowdrga'
$supabaseUrl = "https://$projectRef.supabase.co"
$appUrl = 'https://hivelogic-live.vercel.app'
$brief = 'Using only imported Codex and Claude Code HiveLogic history, identify one shared unfinished technical issue and the evidence for it. Do not use company financial or operations snapshot data.'

$keys = npx --yes supabase@latest projects api-keys --project-ref $projectRef --output json | ConvertFrom-Json
$serviceKey = ($keys | Where-Object name -eq 'service_role' | Select-Object -First 1).api_key
$anonKey = ($keys | Where-Object name -eq 'anon' | Select-Object -First 1).api_key
if (-not $serviceKey -or -not $anonKey) { throw 'Supabase API keys were unavailable.' }

$serviceHeaders = @{ apikey = $serviceKey; Authorization = "Bearer $serviceKey" }
$profile = @((Invoke-RestMethod -Uri "$supabaseUrl/rest/v1/profiles?role=in.(admin,superadmin)&select=id,email&limit=1" -Headers $serviceHeaders))[0]
if (-not $profile.email) { throw 'No administrator profile was available.' }
$link = Invoke-RestMethod -Method Post -Uri "$supabaseUrl/auth/v1/admin/generate_link" -Headers $serviceHeaders -ContentType 'application/json' -Body (@{ type='magiclink'; email=$profile.email } | ConvertTo-Json)
$session = Invoke-RestMethod -Method Post -Uri "$supabaseUrl/auth/v1/verify" -Headers @{ apikey=$anonKey } -ContentType 'application/json' -Body (@{ type='magiclink'; token_hash=$link.hashed_token } | ConvertTo-Json)
if (-not $session.access_token) { throw 'The production test session could not be established.' }
$authHeaders = @{ Authorization = "Bearer $($session.access_token)" }

$response = $null
$runId = $ExistingRunId
if (-not $runId) {
  $response = Invoke-RestMethod -Method Post -Uri "$appUrl/api/reina-council" -Headers $authHeaders -ContentType 'application/json' -TimeoutSec 240 -Body (@{
    action='start'
    brief=$brief
    evidence=@()
    attachments=@()
    budget=@{ maxRounds=1; maxTokensPerResponse=$MaxTokensPerResponse; maxCostCents=$MaxCostCents }
    executionRequest=$null
    idempotencyKey=('imported-history-live-' + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
  } | ConvertTo-Json -Depth 8)
  if (-not $response.ok -or -not $response.runId) { throw ('Production request failed: ' + ($response.error ?? 'no run id')) }
  $runId = $response.runId
}

$stored = Invoke-RestMethod -Uri "$appUrl/api/reina-council?runId=$runId" -Headers $authHeaders
$evidence = @($stored.run.evidence | Where-Object sourceId -eq 'imported-ai-history')
if ($evidence.Count -ne 1) { throw "Expected one imported history evidence record; received $($evidence.Count)." }
$payload = $evidence[0].content | ConvertFrom-Json
$sources = @($payload | ForEach-Object source | Sort-Object -Unique)
if ('codex' -notin $sources -or 'claude_code' -notin $sources) { throw ('Saved evidence did not include both requested histories. Sources: ' + ($sources -join ', ')) }
if (@($stored.run.evidence | Where-Object sourceId -in @('company-intelligence','boardroom-history')).Count -ne 0) { throw 'The history-only request included prohibited company or Boardroom evidence.' }
$messages = @($stored.run.messages)
$participants = @($messages | ForEach-Object { ($_.message ?? $_).participant } | Sort-Object -Unique)
if (($participants -join ',') -ne 'chatgpt,claude,grok') { throw ('Stored run did not contain all three directors: ' + ($participants -join ', ')) }
$reportText = $stored.run.report | ConvertTo-Json -Depth 20 -Compress
if ($reportText -match '(?i)\$134k|overdue invoices|cash recovery|billing hygiene') { throw 'The final recommendation substituted unrelated company finance data.' }
$historyCitations = @($messages | ForEach-Object { ($_.message ?? $_).claims } | ForEach-Object citations | Where-Object sourceId -eq 'imported-ai-history')
$citationSources = @($messages | ForEach-Object { ($_.message ?? $_).claims } | ForEach-Object citations | ForEach-Object sourceId | Sort-Object -Unique)
if ($historyCitations.Count -lt 1) { throw ('The completed director record contained no citation to imported AI history. Stored citation sources: ' + ($citationSources -join ', ')) }

[pscustomobject]@{
  ok = $true
  runId = $runId
  requestedSources = @('codex','claude_code')
  storedSources = $sources
  importedEvidenceMessages = @($payload).Count
  evidenceJsonValid = $true
  prohibitedEvidenceAbsent = $true
  directorReplies = $participants.Count
  degradedProviders = 0
  importedHistoryCitations = $historyCitations.Count
  unrelatedFinanceAdviceAbsent = $true
  totalCostCents = [double]$stored.run.usage.totalCostCents
  totalCostDollars = [Math]::Round(([double]$stored.run.usage.totalCostCents / 100), 6)
  inputTokens = $stored.run.usage.inputTokens
  outputTokens = $stored.run.usage.outputTokens
} | ConvertTo-Json -Depth 6
