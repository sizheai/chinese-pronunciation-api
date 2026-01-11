# ---- UTF-8 safe test for /api/assess ----
param(
  [string]$uri = "http://127.0.0.1:7071/api/assess",
  [string]$wavPath = "C:\dev\test\x.wav",
  [string]$referenceText = "你好",
  [string]$locale = "zh-CN"
)

# Make console display UTF-8 properly (recommended)
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# Read wav -> base64
$bytes = [System.IO.File]::ReadAllBytes($wavPath)
$audioBase64 = [Convert]::ToBase64String($bytes)

$payload = @{
  locale        = $locale
  referenceText = $referenceText
  audioBase64   = $audioBase64
}

# Convert payload to JSON (string)
$json = $payload | ConvertTo-Json -Depth 10 -Compress

# IMPORTANT: send UTF-8 BYTES, not a .NET string
$utf8Bytes = [System.Text.Encoding]::UTF8.GetBytes($json)

# Call API
$response = Invoke-RestMethod -Method Post -Uri $uri `
  -ContentType "application/json; charset=utf-8" `
  -Body $utf8Bytes

$response | ConvertTo-Json -Depth 30
