param(
  [string]$Brief = 'Choose the single best way for HiveLogic to consolidate AI collaboration into The Boardroom. Compare reliability, owner effort, and operating cost. Challenge the other directors, then converge on one practical recommendation.',
  [ValidateRange(100, 4000)]
  [int]$MaxTokensPerResponse = 700,
  [ValidateRange(1, 10)]
  [int]$MaxCostCents = 4
)

$ErrorActionPreference = 'Stop'

$projectRef = 'sqhusuuhlmcmkeowdrga'
$supabaseUrl = "https://$projectRef.supabase.co"
$appUrl = 'https://hivelogic-live.vercel.app'

$keys = npx --yes supabase@latest projects api-keys --project-ref $projectRef --output json | ConvertFrom-Json
$serviceKey = ($keys | Where-Object name -eq 'service_role' | Select-Object -First 1).api_key
$anonKey = ($keys | Where-Object name -eq 'anon' | Select-Object -First 1).api_key
if (-not $serviceKey -or -not $anonKey) { throw 'Supabase API keys were unavailable.' }

$serviceHeaders = @{ apikey = $serviceKey; Authorization = "Bearer $serviceKey" }
$profiles = Invoke-RestMethod -Uri "$supabaseUrl/rest/v1/profiles?role=in.(admin,superadmin)&select=id,email&limit=1" -Headers $serviceHeaders
$profile = @($profiles)[0]
if (-not $profile.id -or -not $profile.email) { throw 'No HiveLogic administrator profile was available for the production test.' }

$link = Invoke-RestMethod -Method Post -Uri "$supabaseUrl/auth/v1/admin/generate_link" -Headers $serviceHeaders -ContentType 'application/json' -Body (@{
  type = 'magiclink'
  email = $profile.email
} | ConvertTo-Json)
$tokenHash = $link.hashed_token
if (-not $tokenHash) { throw 'Supabase did not issue a test session token.' }

$session = Invoke-RestMethod -Method Post -Uri "$supabaseUrl/auth/v1/verify" -Headers @{ apikey = $anonKey } -ContentType 'application/json' -Body (@{
  type = 'magiclink'
  token_hash = $tokenHash
} | ConvertTo-Json)
if (-not $session.access_token) { throw 'The production test session could not be established.' }

$authHeaders = @{ Authorization = "Bearer $($session.access_token)" }
$status = Invoke-RestMethod -Uri "$appUrl/api/reina-council?status=1" -Headers $authHeaders
if (-not $status.ok -or -not $status.ready -or @($status.providers | Where-Object { $_.configured }).Count -ne 3) {
  throw 'The production Boardroom did not report all three providers ready.'
}

$workspace = Invoke-RestMethod -Uri "$appUrl/api/reina-council?workspace=1" -Headers $authHeaders
$project = @($workspace.projects | Where-Object name -eq 'Boardroom Production Verification')[0]
if (-not $project) {
  $projectResponse = Invoke-RestMethod -Method Post -Uri "$appUrl/api/reina-council" -Headers $authHeaders -ContentType 'application/json' -Body (@{
    action = 'create_project'
    name = 'Boardroom Production Verification'
    repository = 'csk5369/hivelogic-live'
  } | ConvertTo-Json)
  $project = $projectResponse.project
}
if (-not $project.id) { throw 'The production Boardroom project could not be created or loaded.' }

$historyBefore = @(($workspace.recent | ForEach-Object id) | Where-Object { $_ })
$priorNewestRunId = $historyBefore | Select-Object -First 1
$startedAt = [DateTimeOffset]::UtcNow
$idempotencyKey = 'production-boardroom-e2e-' + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$run = Invoke-RestMethod -Method Post -Uri "$appUrl/api/reina-council" -Headers $authHeaders -ContentType 'application/json' -TimeoutSec 240 -Body (@{
  action = 'start'
  brief = $Brief
  evidence = @()
  attachments = @()
  budget = @{
    maxRounds = 2
    maxTokensPerResponse = [Math]::Min($MaxTokensPerResponse, [int]$status.limits.maxTokensPerResponse)
    maxCostCents = [Math]::Min($MaxCostCents, [int]$status.limits.maxCostCents)
  }
  executionRequest = $null
  idempotencyKey = $idempotencyKey
  projectId = $project.id
} | ConvertTo-Json -Depth 8)
if (-not $run.ok -or -not $run.runId -or @($run.replies).Count -ne 3) { throw ('The three-provider production run failed: ' + ($run.error ?? 'incomplete response')) }

$stored = Invoke-RestMethod -Uri "$appUrl/api/reina-council?runId=$($run.runId)" -Headers $authHeaders
$messages = @($stored.run.messages)
if ($messages.Count -ne 6) { throw "Expected 6 stored director messages; received $($messages.Count)." }
foreach ($round in 0, 1) {
  $participants = @($messages | Where-Object { ($_.message ?? $_).round -eq $round } | ForEach-Object { ($_.message ?? $_).participant } | Sort-Object)
  if (($participants -join ',') -ne 'chatgpt,claude,grok') { throw "Round $round did not contain all three directors." }
}
$debateAudit = @($stored.run.audit | Where-Object { $_.eventType -eq 'moderator.debate_round_completed' -and $_.detail.round -eq 1 })
$consensusAudit = @($stored.run.audit | Where-Object eventType -eq 'moderator.consensus_computed')
if ($debateAudit.Count -ne 1 -or $consensusAudit.Count -ne 1) { throw 'The stored run did not prove cross-review and consolidation.' }
$completionStandard = $stored.run.report.completionStandard
if (-not $completionStandard -or $completionStandard.version -ne 'hivelogic.definition-of-done.v1') { throw 'The permanent HiveLogic Definition of Done was not persisted with the Boardroom result.' }
if ($completionStandard.rule -notmatch 'exhaustively tested' -or @($completionStandard.requirements).Count -ne 5 -or @($completionStandard.forbiddenShortcuts).Count -ne 2) {
  throw 'The persisted Definition of Done was incomplete.'
}

$null = Invoke-RestMethod -Method Post -Uri "$appUrl/api/reina-council" -Headers $authHeaders -ContentType 'application/json' -Body (@{
  action = 'update_run_metadata'
  runId = $run.runId
  pinned = $true
  projectId = $project.id
} | ConvertTo-Json)

$reloaded = Invoke-RestMethod -Uri "$appUrl/api/reina-council?workspace=1" -Headers $authHeaders
$persisted = @($reloaded.recent | Where-Object id -eq $run.runId)[0]
if (-not $persisted -or -not $persisted.pinned -or $persisted.project_id -ne $project.id) { throw 'The Boardroom result did not persist its project and pinned state.' }
$historyAfter = @(($reloaded.recent | ForEach-Object id) | Where-Object { $_ })
$priorHistoryRetained = -not $priorNewestRunId -or $priorNewestRunId -in $historyAfter
if (-not $priorHistoryRetained) { throw 'Starting a new Boardroom request caused prior conversation history to disappear.' }
$elapsedSeconds = [Math]::Round(([DateTimeOffset]::UtcNow - $startedAt).TotalSeconds, 2)

[pscustomobject]@{
  ok = $true
  runId = $run.runId
  providers = @($status.providers | Where-Object configured | ForEach-Object name)
  rounds = 2
  storedMessages = $messages.Count
  finalReplies = @($run.replies).Count
  project = $project.name
  pinnedAfterReload = [bool]$persisted.pinned
  priorHistoryRetained = $priorHistoryRetained
  historyBeforeCount = $historyBefore.Count
  historyAfterCount = $historyAfter.Count
  elapsedSeconds = $elapsedSeconds
  totalCostCents = $run.usage.totalCostCents
  consensusTopics = @($run.report.consensus).Count
  conflicts = @($run.report.conflicts).Count
  unresolved = @($run.report.unresolved).Count
  completionStandard = $completionStandard.version
} | ConvertTo-Json -Depth 5
