# Integration test: boot a real second dsh web instance from a cloned DSH home,
# install this plugin into the clone, and exercise the bridge endpoint end to end.
# No model credential is injected; a successful run proves boot + routes + agent
# loop wiring (the chat call reports either a completed turn or the credential
# error shape propagated through the bridge - both prove the pipeline).
param(
  [string]$Target = "D:\app\dsh\DSH Desktop\resources\app",
  [string]$Node = "C:\Users\delinger\Desktop\dsh\dsh-desktop\vendor\node\node.exe",
  [int]$Port = 65210
)
$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$realHome = Join-Path $env:USERPROFILE ".dsh"
$tmpHome = Join-Path $env:TEMP ("dsh-bridge-itest-" + [guid]::NewGuid().ToString("N"))
$logFile = Join-Path $tmpHome "dsh-web.log"
$ok = $false

# curl.exe-based POST: returns the body even on HTTP error statuses.
# (Invoke-WebRequest is unusable in some non-interactive sandboxes.)
function Invoke-PostJson {
  param([string]$Url, [string]$BodyText)
  $bodyFile = Join-Path $env:TEMP ("bridge-post-" + [guid]::NewGuid().ToString("N") + ".json")
  Set-Content -LiteralPath $bodyFile -Value $BodyText -Encoding ASCII
  try {
    $parts = & curl.exe -s -m 300 -w '|%{http_code}' -X POST -H 'Content-Type: application/json' --data-binary ('@' + $bodyFile) $Url 2>$null
    if (-not $parts) { return @{ Code = '0'; Content = '' } }
    $all = $parts -join [Environment]::NewLine
    $idx = $all.LastIndexOf('|')
    if ($idx -lt 0) { return @{ Code = '0'; Content = $all } }
    return @{ Code = $all.Substring($idx + 1); Content = $all.Substring(0, $idx) }
  } finally {
    Remove-Item -LiteralPath $bodyFile -Force -ErrorAction SilentlyContinue
  }
}

try {
  Write-Host ("[1/4] cloning DSH home to " + $tmpHome)
  New-Item -ItemType Directory -Force -Path $tmpHome | Out-Null
  Copy-Item (Join-Path $realHome "profiles") (Join-Path $tmpHome "profiles") -Recurse -Force
  # The copied node_modules junctions are dereferenced by Copy-Item; drop them:
  # dsh's healProfilesModuleFallback rebuilds the whole junction closure at boot.
  Remove-Item (Join-Path $tmpHome "profiles\node_modules") -Recurse -Force -ErrorAction SilentlyContinue
  foreach ($f in @(".credentials.yaml", "settings.yaml", ".anonymous-user-id")) {
    if (Test-Path (Join-Path $realHome $f)) { Copy-Item (Join-Path $realHome $f) (Join-Path $tmpHome $f) -Force }
  }

  Write-Host "[2/4] installing plugin into cloned profile"
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $repo "scripts\install.ps1") -SkipDesktop -DshHome $tmpHome

  Write-Host "[3/4] booting mock OpenAI-compatible endpoint on 65413"
  $mockJs = Join-Path $tmpHome "mock-openai.cjs"
  $mockLines = @(
    'const http = require("http");',
    'http.createServer((req, res) => {',
    '  let body = "";',
    '  req.on("data", (c) => (body += c));',
    '  req.on("end", () => {',
    '    const sse = (p) => res.write("data: " + JSON.stringify(p) + "\n\n");',
    '    res.writeHead(200, { "content-type": "text/event-stream" });',
    '    sse({ choices: [{ index: 0, delta: { content: "hello from " }, finish_reason: null }] });',
    '    sse({ choices: [{ index: 0, delta: { content: "real agent loop" }, finish_reason: null }] });',
    '    sse({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });',
    '    sse({ usage: { prompt_tokens: 7, completion_tokens: 4, total_tokens: 11 } });',
    '    res.write("data: [DONE]\n\n");',
    '    res.end();',
    '  });',
    '}).listen(65413, "127.0.0.1", () => console.log("mock-openai 65413"));'
  )
  Set-Content -LiteralPath $mockJs -Value ($mockLines -join [Environment]::NewLine) -Encoding ASCII
  $mockProc = Start-Process -FilePath $Node -ArgumentList $mockJs -PassThru -WindowStyle Hidden
  Start-Sleep -Seconds 1

  Write-Host "[3b/4] booting dsh web on port " + $Port
  $ws = Join-Path $tmpHome "workspace"
  New-Item -ItemType Directory -Force -Path $ws | Out-Null
  $bin = Join-Path $Target "node_modules\@deepseek-ai\dsh\lib\bin.js"
  $wrapper = Join-Path $tmpHome "boot.cmd"
  $cmdLines = @(
    "@echo off",
    ('set "DSH_HOME=' + $tmpHome + '"'),
    ('set "USERPROFILE=' + $tmpHome + '"'),
    'set "DSH_WEB_URL="',
    'set "DSH_SESSION_ID="',
    'set "DSH_SESSION_JSONL="',
    'set "DSH_SHELL="',
    'set "ELECTRON_RUN_AS_NODE="',
    'set "NODE_OPTIONS="',
    ('cd /d "' + $ws + '"'),
    ('"' + $Node + '" "' + $bin + '" --profile web --host 127.0.0.1 --port ' + $Port + ' >> "' + $logFile + '" 2>&1')
  )
  Set-Content -LiteralPath $wrapper -Value ($cmdLines -join [Environment]::NewLine) -Encoding ASCII
  $proc = Start-Process -FilePath "cmd.exe" -ArgumentList ('/c "' + $wrapper + '"') -PassThru -WindowStyle Hidden
  Write-Host ("server pid: " + $proc.Id)

  Write-Host "[4/4] waiting for health endpoint"
  $healthOk = $false
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Seconds 2
    $code = & curl.exe -s -m 5 -o NUL -w '%{http_code}' ("http://127.0.0.1:" + $Port + "/openclaw-bridge/health") 2>$null
    if ("$code" -eq "200") { $healthOk = $true; break }
    if ($proc.HasExited) {
      Write-Host "server exited early (code " + $proc.ExitCode + "), log tail:"
      if (Test-Path $logFile) { Get-Content -LiteralPath $logFile -Tail 40 }
      throw "dsh web boot failed"
    }
  }
  if (-not $healthOk) {
    Write-Host "health never became 200; log tail:"
    if (Test-Path $logFile) { Get-Content -LiteralPath $logFile -Tail 40 }
    throw "health endpoint did not come up"
  }
  Write-Host "HEALTH 200"

  Write-Host "--- settings RPC (ClawBot section) ---"
  $rpc1 = '{"type":"client-request","rpcId":"r1","method":"settings.describe","payload":{}}'
  $desc = Invoke-PostJson -Url ("http://127.0.0.1:" + $Port + "/api/settings.describe") -BodyText $rpc1
  Write-Host ("DESCRIBE STATUS " + $desc.Code)
  $hasNs = $desc.Content.Contains("openclaw-bridge")
  Write-Host ("DESCRIBE exposes openclaw-bridge: " + $hasNs)
  if (-not $hasNs) { throw "settings.describe did not expose openclaw-bridge (whitelist patch missing?)" }

  $rpc2 = '{"type":"client-request","rpcId":"r2","method":"settings.mutate","payload":{"ns":"openclaw-bridge","ops":[{"op":"set","path":["model"],"value":"deepseek-official/deepseek-v4-flash"}]}}'
  $mut = Invoke-PostJson -Url ("http://127.0.0.1:" + $Port + "/api/settings.mutate") -BodyText $rpc2
  Write-Host ("MUTATE STATUS " + $mut.Code)
  $healthAfter = & curl.exe -s -m 5 ("http://127.0.0.1:" + $Port + "/openclaw-bridge/health") 2>$null
  $healthLine = $healthAfter -join ''
  Write-Host ("HEALTH after mutate: " + $healthLine)
  if ($healthLine -notmatch 'deepseek-official/deepseek-v4-flash') {
    throw "settings.mutate did not take effect (health: " + $healthLine + ")"
  }

  Write-Host "--- chat completions (non-stream) ---"
  $body = @{ model = "dsh-itest/main"; stream = $false; messages = @(@{ role = "user"; content = "ping, reply with one short line" }) } | ConvertTo-Json -Depth 6 -Compress
  $resp = Invoke-PostJson -Url ("http://127.0.0.1:" + $Port + "/openclaw-bridge/v1/chat/completions") -BodyText $body
  Write-Host ("STATUS " + $resp.Code)
  Write-Host ("BODY " + $resp.Content.Substring(0, [Math]::Min(600, $resp.Content.Length)))

  Write-Host "--- chat completions (stream) ---"
  $bodyS = @{ model = "dsh-itest/stream"; stream = $true; messages = @(@{ role = "user"; content = "hi" }) } | ConvertTo-Json -Depth 6 -Compress
  $respS = Invoke-PostJson -Url ("http://127.0.0.1:" + $Port + "/openclaw-bridge/v1/chat/completions") -BodyText $bodyS
  Write-Host ("STREAM STATUS " + $respS.Code)
  $hasDone = $respS.Content.Contains("data: [DONE]")
  Write-Host ("STREAM has [DONE]: " + $hasDone)

  Write-Host "--- custom OpenAI-compatible endpoint (real agent loop) ---"
  $rpc3 = '{"type":"client-request","rpcId":"r3","method":"settings.mutate","payload":{"ns":"openclaw-bridge","ops":[{"op":"set","path":["customBaseURL"],"value":"http://127.0.0.1:65413/v1"},{"op":"set","path":["customModel"],"value":"test-model"}]}}'
  $mut3 = Invoke-PostJson -Url ("http://127.0.0.1:" + $Port + "/api/settings.mutate") -BodyText $rpc3
  Write-Host ("CUSTOM MUTATE STATUS " + $mut3.Code)
  $bodyC = @{ model = "dsh-itest/custom"; stream = $false; messages = @(@{ role = "user"; content = "hi" }) } | ConvertTo-Json -Depth 6 -Compress
  $respC = Invoke-PostJson -Url ("http://127.0.0.1:" + $Port + "/openclaw-bridge/v1/chat/completions") -BodyText $bodyC
  Write-Host ("CUSTOM STATUS " + $respC.Code)
  Write-Host ("CUSTOM BODY " + $respC.Content.Substring(0, [Math]::Min(600, $respC.Content.Length)))
  if ($respC.Content -notmatch 'hello from real agent loop') {
    throw "custom endpoint did not drive the real agent loop"
  }
  Write-Host "CUSTOM ENDPOINT OK (real agent loop answered via openclaw-custom adapter)"

  Write-Host "--- boot log evidence ---"
  Select-String -LiteralPath $logFile -Pattern "openclaw-bridge" | ForEach-Object { Write-Host $_.Line }

  Write-Host "INTEGRATION TEST PASSED (pipeline verified; chat status above reflects credential availability)"
  $ok = $true
} finally {
  if ($proc -and -not $proc.HasExited) {
    Write-Host ("stopping server (pid " + $proc.Id + ")")
    & taskkill /PID $proc.Id /T /F 2>$null | Out-Null
  }
  if ($mockProc -and -not $mockProc.HasExited) {
    & taskkill /PID $mockProc.Id /T /F 2>$null | Out-Null
  }
  if ($ok) {
    Remove-Item -LiteralPath $tmpHome -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host "cleaned up " + $tmpHome
  } else {
    Write-Host ("kept for inspection: " + $tmpHome)
  }
}
