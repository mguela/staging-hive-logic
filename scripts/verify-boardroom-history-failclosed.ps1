param(
  [string]$Brief = 'collect all history from Grok, ChatGPT and Claude regarding HiveLogic App and make 1 master project here'
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
if (-not $profile.id -or -not $profile.email) { throw 'No HiveLogic administrator profile was available.' }

$link = Invoke-RestMethod -Method Post -Uri "$supabaseUrl/auth/v1/admin/generate_link" -Headers $serviceHeaders -ContentType 'application/json' -Body (@{
  type = 'magiclink'
  email = $profile.email
} | ConvertTo-Json)
$session = Invoke-RestMethod -Method Post -Uri "$supabaseUrl/auth/v1/verify" -Headers @{ apikey = $anonKey } -ContentType 'application/json' -Body (@{
  type = 'magiclink'
  token_hash = $link.hashed_token
} | ConvertTo-Json)
if (-not $session.access_token) { throw 'The production test session could not be established.' }

$authHeaders = @{ Authorization = "Bearer $($session.access_token)" }
$workspaceBefore = Invoke-RestMethod -Uri "$appUrl/api/reina-council?workspace=1" -Headers $authHeaders
$beforeIds = @($workspaceBefore.recent | ForEach-Object id)

$response = $null
try {
  $response = Invoke-RestMethod -Method Post -Uri "$appUrl/api/reina-council" -Headers $authHeaders -ContentType 'application/json' -Body (@{
    action = 'start'
    brief = $Brief
    evidence = @()
    attachments = @()
    budget = @{ maxRounds = 2; maxTokensPerResponse = 700; maxCostCents = 4 }
    executionRequest = $null
    idempotencyKey = 'history-failclosed-' + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  } | ConvertTo-Json -Depth 8)
  throw 'The production Boardroom generated an answer instead of refusing missing history.'
} catch {
  if ($_.Exception.Response.StatusCode.value__ -ne 409) { throw }
  $response = $_.ErrorDetails.Message | ConvertFrom-Json
}

if ($response.code -ne 'HISTORY_SOURCES_NOT_IMPORTED') { throw "Unexpected error code: $($response.code)" }
$expectedMissing = @('chatgpt', 'claude', 'grok')
$actualMissing = @($response.missingSources | Sort-Object)
if (($actualMissing -join ',') -ne (($expectedMissing | Sort-Object) -join ',')) {
  throw "Expected missing sources chatgpt, claude, grok; received $($actualMissing -join ', ')."
}
if ($response.error -notmatch 'No substitute company-data answer was generated') {
  throw 'The fail-closed response did not explicitly prohibit a substitute answer.'
}

$workspaceAfter = Invoke-RestMethod -Uri "$appUrl/api/reina-council?workspace=1" -Headers $authHeaders
$afterIds = @($workspaceAfter.recent | ForEach-Object id)
if (($beforeIds -join ',') -ne ($afterIds -join ',')) {
  throw 'The rejected request created or changed Boardroom history.'
}

[pscustomobject]@{
  ok = $true
  httpStatus = 409
  code = $response.code
  requestedSources = @($response.requestedSources)
  missingSources = $actualMissing
  substituteAnswerGenerated = $false
  boardroomHistoryChanged = $false
} | ConvertTo-Json -Depth 5
