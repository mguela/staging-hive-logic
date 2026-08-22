$ErrorActionPreference = 'Stop'

$projectRef = 'sqhusuuhlmcmkeowdrga'
$supabaseUrl = "https://$projectRef.supabase.co"
$keys = npx --yes supabase@latest projects api-keys --project-ref $projectRef --output json | ConvertFrom-Json
$serviceKey = ($keys | Where-Object name -eq 'service_role' | Select-Object -First 1).api_key
if (-not $serviceKey) { throw 'Supabase service key was unavailable.' }
$headers = @{ apikey = $serviceKey; Authorization = "Bearer $serviceKey" }

$profiles = Invoke-RestMethod -Uri "$supabaseUrl/rest/v1/profiles?role=in.(admin,superadmin)&select=id&limit=1" -Headers $headers
$ownerId = @($profiles)[0].id
if (-not $ownerId) { throw 'No HiveLogic administrator profile was available for the production test.' }
$runId = [guid]::NewGuid().ToString()
$idempotencyKey = 'retry-audit-e2e-' + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$admission = $null

try {
  $admission = Invoke-RestMethod -Method Post -Uri "$supabaseUrl/rest/v1/rpc/reina_council_admit" -Headers $headers -ContentType 'application/json' -Body (@{
    p_owner_id = $ownerId
    p_idempotency_key = $idempotencyKey
    p_request_hash = 'a' * 64
    p_reserved_cost_cents = 10
    p_max_concurrent_runs = 1
    p_daily_cost_cents = 100
  } | ConvertTo-Json)
  if ($admission.status -ne 'admitted' -or -not $admission.admissionId) { throw 'Synthetic admission was not granted.' }

  $at = '2026-08-16T12:00:00.000Z'
  $message = @{ summary = 'Verified persistence response'; claims = @(); risks = @(); questions = @() }
  $messages = @('claude', 'chatgpt', 'grok') | ForEach-Object {
    @{ participant = $_; round = 0; message = (@{ participant = $_; round = 0 } + $message); usage = @{ inputTokens = 1; outputTokens = 1; costCents = 0.25 } }
  }
  $events = @(
    @{ eventType = 'council.started'; detail = @{ budget = @{ maxRounds = 1 } }; occurredAt = $at },
    @{ eventType = 'provider.completed'; detail = @{ participant = 'claude'; round = 0; usage = @{} }; occurredAt = $at },
    @{ eventType = 'provider.completed'; detail = @{ participant = 'chatgpt'; round = 0; usage = @{} }; occurredAt = $at },
    @{ eventType = 'provider.requested'; detail = @{ participant = 'grok'; round = 0; attempt = 0 }; occurredAt = $at },
    @{ eventType = 'provider.failed'; detail = @{ participant = 'grok'; round = 0; attempt = 0; reason = 'invalid_message' }; occurredAt = $at },
    @{ eventType = 'provider.retrying'; detail = @{ participant = 'grok'; round = 0; attempt = 1; reason = 'invalid_message' }; occurredAt = $at },
    @{ eventType = 'provider.requested'; detail = @{ participant = 'grok'; round = 0; attempt = 1 }; occurredAt = $at },
    @{ eventType = 'provider.completed'; detail = @{ participant = 'grok'; round = 0; usage = @{} }; occurredAt = $at },
    @{ eventType = 'moderator.independent_round_completed'; detail = @{ count = 3 }; occurredAt = $at },
    @{ eventType = 'moderator.consensus_computed'; detail = @{ consensus = 1 }; occurredAt = $at },
    @{ eventType = 'council.completed'; detail = @{ state = 'completed'; totalCostCents = 1.25 }; occurredAt = $at }
  )
  $created = Invoke-RestMethod -Method Post -Uri "$supabaseUrl/rest/v1/rpc/reina_council_create_run" -Headers $headers -ContentType 'application/json' -Body (@{
    p_id = $runId
    p_owner_id = $ownerId
    p_admission_id = $admission.admissionId
    p_state = 'completed'
    p_brief = 'Production retry audit persistence verification'
    p_evidence = @()
    p_budget = @{ maxRounds = 1; maxTokensPerResponse = 100; maxCostCents = 10 }
    p_usage = @{ inputTokens = 3; outputTokens = 3; totalCostCents = 1.25 }
    p_report = @{ consensus = @(); conflicts = @(); unresolved = @() }
    p_execution_request = $null
    p_messages = $messages
    p_audit_events = $events
  } | ConvertTo-Json -Depth 12)
  if ($created.id -ne $runId) { throw 'The retry transcript was not atomically created.' }

  $stored = Invoke-RestMethod -Method Post -Uri "$supabaseUrl/rest/v1/rpc/reina_council_get_run" -Headers $headers -ContentType 'application/json' -Body (@{
    p_run_id = $runId
    p_owner_id = $ownerId
  } | ConvertTo-Json)
  if ($stored.id -ne $runId -or @($stored.messages).Count -ne 3 -or @($stored.audit).Count -ne $events.Count) { throw 'The complete retry transcript did not reload.' }
  if (@($stored.audit | Where-Object eventType -eq 'provider.retrying').Count -ne 1) { throw 'The retry evidence was not preserved.' }

  [pscustomobject]@{
    ok = $true
    runId = $runId
    messages = @($stored.messages).Count
    auditEvents = @($stored.audit).Count
    retryEvents = @($stored.audit | Where-Object eventType -eq 'provider.retrying').Count
  } | ConvertTo-Json
}
finally {
  if ($admission.admissionId) {
    Invoke-RestMethod -Method Delete -Uri "$supabaseUrl/rest/v1/reina_council_admissions?id=eq.$($admission.admissionId)" -Headers $headers | Out-Null
  }
  Invoke-RestMethod -Method Delete -Uri "$supabaseUrl/rest/v1/reina_council_runs?id=eq.$runId" -Headers $headers | Out-Null
}
