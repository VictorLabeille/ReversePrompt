# Adaptateur Claude → ReversePrompt, côté Windows (hooks de Claude Desktop, ou du CLI Windows).
#
# Même rôle et mêmes règles que notify.py (docs/adapters/claude.md) : lit le JSON du hook sur
# stdin, le traduit vers le contrat v1 et l'envoie à l'app. Sort toujours en 0. Le hook est
# déclaré `async` : Claude n'attend pas ce script, qui peut donc attendre la réponse de l'app.
#
#   notify.ps1          traduit et envoie
#   notify.ps1 -Print   traduit et écrit l'événement sur stdout, sans rien envoyer (tests)
param([switch]$Print)

$ErrorActionPreference = 'Stop'
$NeedsInputNotifications = @('permission_prompt', 'elicitation_dialog', 'elicitation_url_dialog', 'agent_needs_input')
$DesktopEntrypoints = @('claude-desktop', 'claude-desktop-3p')

function Get-Kind($hook) {
    switch ($hook.hook_event_name) {
        'Stop' { if ($hook.background_tasks -and @($hook.background_tasks).Count -gt 0) { return $null }; return 'done' }
        'StopFailure' { return 'needs-input' }
        'Notification' { if ($NeedsInputNotifications -contains $hook.notification_type) { return 'needs-input' }; return $null }
        'PreToolUse' { if ($hook.tool_name -eq 'AskUserQuestion') { return 'needs-input' }; return $null }
        'UserPromptSubmit' { return 'dismiss' }
        'SessionEnd' { return 'dismiss' }
    }
    return $null
}

function Get-Surface {
    $entrypoint = [string]$env:CLAUDE_CODE_ENTRYPOINT
    if ($entrypoint -ceq 'cli') { return 'terminal' }
    if ($DesktopEntrypoints -ccontains $entrypoint) { return 'desktop' }
    return $null
}

function ConvertTo-Event($hook) {
    if ($null -eq $hook -or $hook -isnot [pscustomobject]) { return $null }
    $kind = Get-Kind $hook
    $where = Get-Surface
    if ($null -eq $kind -or $null -eq $where) { return $null }
    $session = [string]$hook.session_id
    if (-not $session) { $session = 'inconnue' }
    if ($session.Length -gt 128) { $session = $session.Substring(0, 128) }
    $event = [ordered]@{ v = 1; kind = $kind; session = $session }
    if ($where -eq 'desktop') {
        $event.source = 'claude-desktop'
        $event.focus = [ordered]@{ process = 'claude.exe' }
    } else {
        $event.source = 'claude-code'
        $process = if ($env:TERM_PROGRAM -eq 'vscode') { 'Code.exe' } else { 'WindowsTerminal.exe' }
        $event.focus = [ordered]@{ process = $process }
    }
    return $event
}

try {
    $raw = [Console]::In.ReadToEnd()
    $hook = if ($raw.Trim()) { $raw | ConvertFrom-Json } else { $null }
    $event = ConvertTo-Event $hook
    if ($Print) {
        if ($null -eq $event) { 'null' } else { $event | ConvertTo-Json -Compress -Depth 4 }
    } elseif ($null -ne $event) {
        $endpoint = Get-Content -Raw -Encoding UTF8 (Join-Path $PSScriptRoot 'endpoint.json') | ConvertFrom-Json
        $body = [Text.Encoding]::UTF8.GetBytes(($event | ConvertTo-Json -Compress -Depth 4))
        Invoke-WebRequest -UseBasicParsing -Method Post -TimeoutSec 2 `
            -Uri "http://127.0.0.1:$([int]$endpoint.port)/event" `
            -Headers @{ 'X-ReversePrompt-Token' = [string]$endpoint.token } `
            -ContentType 'application/json' -Body $body | Out-Null
    }
} catch {
    if ($Print) { 'null' }
}
exit 0
