param(
    [switch] $VoiceLocal,
    [string] $TorchBackend = "",
    [switch] $Rtk,
    [switch] $LatestRelease,
    [switch] $DryRun,
    [switch] $Help,
    [Parameter(ValueFromRemainingArguments = $true)]
    [object[]] $RemainingArgs = @()
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

# Set to your luicode repository (owner/repo).
$RepoSlug = "Luigibarte4563/luicode"
$RepoArchiveUrl = "https://github.com/$RepoSlug/archive/refs/heads/main.zip"
# Published releases only; drafts never appear here. Parsed rather than using the
# GitHub API so the shell installer needs no jq, keeping both platforms in step.
$RepoReleasesFeedUrl = "https://github.com/$RepoSlug/releases.atom"
# Windows on ARM emulates x64, whose Python package ecosystem has broader wheel support.
$PythonRequest = "cpython-3.14.0-windows-x86_64-none"
$MinUvVersion = "0.12.13"
# A stale launcher on PATH must never stall the whole installation, so every
# agent validation runs under a hard timeout instead of an open-ended call.
$AgentProbeTimeoutSeconds = 15
if (-not [string]::IsNullOrWhiteSpace($env:LUICODE_AGENT_PROBE_TIMEOUT_SECONDS)) {
    $agentProbeTimeoutOverride = 0
    if (
        [int]::TryParse($env:LUICODE_AGENT_PROBE_TIMEOUT_SECONDS, [ref] $agentProbeTimeoutOverride) -and
        $agentProbeTimeoutOverride -ge 1
    ) {
        $AgentProbeTimeoutSeconds = $agentProbeTimeoutOverride
    }
}
$ClaudeInstallUrl = "https://claude.ai/install.ps1"
$CodexInstallUrl = "https://chatgpt.com/codex/install.ps1"
$PiInstallUrl = "https://pi.dev/install.ps1"
$OpenCodeReleaseBaseUrl = "https://opencode.ai/files/bin"
$HermesInstallUrl = "https://hermes-agent.nousresearch.com/install.ps1"
$DshVersion = "0.1.0-rc.8"
$DshPackage = "@deepseek-ai/dsh@$DshVersion"
$GrokInstallUrl = "https://x.ai/cli/install.ps1"
$MuseInstallUrl = "https://raw.githubusercontent.com/Luigibarte4563/luicode/main/scripts/install-muse.ps1"
$RtkVersion = "0.44.2"
$RtkReleaseBaseUrl = "https://github.com/rtk-ai/rtk/releases/download/v$RtkVersion"
$RtkWindowsAssetName = "rtk-x86_64-pc-windows-msvc.zip"
$RtkWindowsAssetSha256 = "3a1e114edce9080f8a10663e9c87488363a82f14a5ca8aab2ad416817f89d47c"
$UvInstallUrl = "https://astral.sh/uv/install.ps1"
$script:InstallClaudeCode = $true
$script:InstallCodex = $true
$script:InstallPi = $true
$script:InstallOpenCode = $true
$script:InstallCline = $false
$script:InstallHermes = $true
$script:InstallDsh = $true
$script:InstallGrok = $true
$script:InstallMuse = $true
$script:InstallAider = $true
$script:PiAvailable = $false
$script:MuseAvailable = $false
$script:EnableRtk = $Rtk.IsPresent
$script:LuicodeReleaseTag = ""
$LuicodeCommands = @(
    # Include retired entry points so updates reject older LUICODE processes before replacement.
    "luicode-desktop",
    "luicode-server",
    "luicode-claude",
    "luicode-codex",
    "luicode-pi",
    "luicode-opencode",
    "luicode-cline",
    "luicode-hermes",
    "luicode-dsh",
    "luicode-grok",
    "luicode-muse",
    "luicode-aider",
    "luicode-update",
    "luicode-upgrade",
    "luicode-init",
    "luicode"
)
# Ordered so the detection report and the prompts follow one stable sequence.
$CodingAgentCatalog = @(
    [pscustomobject] @{ CommandName = "claude"; DisplayName = "Claude Code"; LuicodeCommand = "luicode-claude"; DefaultYes = $true }
    [pscustomobject] @{ CommandName = "codex"; DisplayName = "Codex"; LuicodeCommand = "luicode-codex"; DefaultYes = $true }
    [pscustomobject] @{ CommandName = "pi"; DisplayName = "Pi"; LuicodeCommand = "luicode-pi"; DefaultYes = $true }
    [pscustomobject] @{ CommandName = "opencode"; DisplayName = "OpenCode"; LuicodeCommand = "luicode-opencode"; DefaultYes = $true }
    [pscustomobject] @{ CommandName = "cline"; DisplayName = "Cline CLI"; LuicodeCommand = "luicode-cline"; DefaultYes = $false }
    [pscustomobject] @{ CommandName = "hermes"; DisplayName = "Hermes Agent"; LuicodeCommand = "luicode-hermes"; DefaultYes = $true }
    [pscustomobject] @{ CommandName = "dsh"; DisplayName = "DeepSeek Harness"; LuicodeCommand = "luicode-dsh"; DefaultYes = $true }
    [pscustomobject] @{ CommandName = "grok"; DisplayName = "Grok Build"; LuicodeCommand = "luicode-grok"; DefaultYes = $true }
    [pscustomobject] @{ CommandName = "muse"; DisplayName = "Muse Code"; LuicodeCommand = "luicode-muse"; DefaultYes = $true }
    [pscustomobject] @{ CommandName = "aider"; DisplayName = "Aider"; LuicodeCommand = "luicode-aider"; DefaultYes = $true }
)

function Show-Usage {
    @"
Usage: install.ps1 [options]

Installs or updates luicode and lets you choose which coding agents to install or verify.

Options:
  -VoiceLocal            Install local Whisper voice transcription support.
  -TorchBackend VALUE    Use a uv PyTorch backend, such as cu130. Requires local voice.
  -Rtk                   Install and configure RTK for the selected coding agents.
  -LatestRelease         Install the newest published release tag instead of tracking main.
  -DryRun                Print commands without running them.
  -Help                  Show this help text.
"@
}

function Write-Step {
    param([string] $Message)

    Write-Host ""
    Write-Host "==> $Message"
}

function Test-InteractiveInstaller {
    return (-not [Console]::IsInputRedirected) -and (-not [Console]::IsOutputRedirected)
}

function Read-YesNo {
    param(
        [string] $Prompt,
        [bool] $DefaultYes = $true
    )

    while ($true) {
        $hint = if ($DefaultYes) { "[Y/n]" } else { "[y/N]" }
        $answer = ([string] (Read-Host "$Prompt $hint")).Trim().ToLowerInvariant()
        if ($answer -eq "") {
            return $DefaultYes
        }
        if ($answer -in @("y", "yes")) {
            return $true
        }
        if ($answer -in @("n", "no")) {
            return $false
        }
        Write-Host "Please answer Y or N."
    }
}

function Get-InstalledCodingAgentCandidates {
    # Only discovery happens here. A candidate proves nothing about whether the
    # agent runs, so callers must validate the command before trusting it.
    param([string] $CommandName)

    $originalPath = $env:Path
    try {
        if ($CommandName -eq "opencode" -and $script:OriginalOpenCode) {
            return @($script:OriginalOpenCode)
        }
        if ($CommandName -in @("pi", "cline", "dsh")) {
            try {
                Add-NpmBinDirectories
            }
            catch {
                # An optional lookup must not prevent choosing other harnesses.
            }
        }
        $commands = @(Get-ApplicationCommands -Name $CommandName)
        if ($commands.Count -eq 0) {
            if ($CommandName -eq "aider") {
                if ($env:UV_TOOL_BIN_DIR) {
                    Add-PathEntry $env:UV_TOOL_BIN_DIR
                }
                elseif ($env:XDG_BIN_HOME) {
                    Add-PathEntry $env:XDG_BIN_HOME
                }
                elseif ($env:XDG_DATA_HOME) {
                    Add-PathEntry (Join-Path $env:XDG_DATA_HOME "..\bin")
                }
                elseif ($env:USERPROFILE) {
                    Add-PathEntry (Join-Path $env:USERPROFILE ".local\bin")
                }
                $commands = @(Get-ApplicationCommands -Name $CommandName)
            }
            elseif ($CommandName -eq "muse") {
                $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
                if (-not [string]::IsNullOrWhiteSpace($userPath)) {
                    $env:Path = "$originalPath$([IO.Path]::PathSeparator)$userPath"
                    $commands = @(Get-ApplicationCommands -Name $CommandName)
                }
            }
        }
        return @($commands)
    }
    finally {
        # Environment variables are process-wide, even inside a function.
        $env:Path = $originalPath
    }
}

function Find-InstalledCodingAgent {
    param([string] $CommandName)

    $candidates = @(Get-InstalledCodingAgentCandidates -CommandName $CommandName)
    if ($candidates.Count -eq 0) {
        return $null
    }
    return $candidates[0]
}

function Test-CodingAgentIsUsable {
    param($State)

    # An unknown state is never treated as broken: the later Ensure pass still
    # verifies the agent, so an inconclusive probe must not block the install.
    return ($State.State -eq "Working") -or ($State.State -eq "Unknown")
}

function Test-CodingAgentIsBroken {
    # Unrecognized is deliberately excluded: a foreign program owning the
    # command name is simply not the agent, so the install prompt already covers
    # it and a repair offer would be misleading.
    param($State)

    return (
        ($State.State -eq "Broken") -or
        ($State.State -eq "VersionCheckFailed")
    )
}

function Get-ProbeDetailLine {
    param($Probe)

    foreach ($stream in @($Probe.StandardError, $Probe.StandardOutput)) {
        foreach ($line in ($stream -split "`r?`n")) {
            $trimmed = $line.Trim()
            if ($trimmed) {
                return $trimmed
            }
        }
    }
    return ""
}

function Test-CodingAgentIdentity {
    # Detects a different program that happens to own the command name.
    param(
        $Command,
        [string] $CommandName
    )

    if ($CommandName -ne "pi") {
        return $true
    }
    $probe = Invoke-AgentVersionProbe -FilePath $Command.Source -Arguments @("--help")
    if ($probe.StartFailed -or $probe.TimedOut -or $probe.ExitCode -ne 0) {
        return $false
    }
    $helpText = "$($probe.StandardOutput)`n$($probe.StandardError)"
    return ($helpText.Contains("--extension") -and $helpText.Contains("--models"))
}

function Get-CodingAgentState {
    param(
        [string] $CommandName,
        [string] $DisplayName
    )

    $candidates = @(Get-InstalledCodingAgentCandidates -CommandName $CommandName)
    if ($candidates.Count -eq 0) {
        return [pscustomobject] @{
            CommandName = $CommandName; DisplayName = $DisplayName; State = "NotInstalled"
            Path = ""; Version = ""; Reason = ""; CandidateCount = 0
        }
    }

    # The first PATH entry is what the user's own shell would run, so only that
    # candidate decides the state. Extra copies are reported, never preferred.
    $command = $candidates[0]
    $state = [pscustomobject] @{
        CommandName = $CommandName; DisplayName = $DisplayName; State = "Unknown"
        Path = $command.Source; Version = ""; Reason = ""; CandidateCount = $candidates.Count
    }
    if ($DryRun) {
        $state.Reason = "the dry run does not execute coding agents"
        return $state
    }

    $probe = Invoke-AgentVersionProbe -FilePath $command.Source
    if ($probe.StartFailed) {
        $state.State = "Unknown"
        $state.Reason = "could not start the command: $(Get-ProbeDetailLine $probe)"
        return $state
    }
    if ($probe.TimedOut) {
        $state.State = "VersionCheckFailed"
        $state.Reason = "the command did not answer '--version' within $AgentProbeTimeoutSeconds seconds"
        return $state
    }
    if ($probe.ExitCode -ne 0) {
        $state.State = "Broken"
        $detail = Get-ProbeDetailLine $probe
        $state.Reason = "exit code $($probe.ExitCode)"
        if ($detail) {
            $state.Reason = "$($state.Reason): $detail"
        }
        return $state
    }
    if (-not (Test-CodingAgentIdentity -Command $command -CommandName $CommandName)) {
        $state.State = "Unrecognized"
        $state.Reason = "the command at this path is not the expected coding agent"
        return $state
    }
    if ([string]::IsNullOrWhiteSpace($probe.StandardOutput)) {
        $state.State = "VersionCheckFailed"
        $state.Reason = "the command exited successfully but printed no version"
        return $state
    }

    $state.State = "Working"
    # Report exactly what the agent printed, so the value is traceable to the
    # tool rather than to installer-side parsing.
    $state.Version = (Get-ProbeDetailLine $probe)
    return $state
}

function Write-CodingAgentDetectionReport {
    param([object[]] $States)

    Write-Step "Detecting existing coding agents"

    $working = 0
    $broken = 0
    $missing = 0
    $unknown = 0
    foreach ($state in $States) {
        if ($state.State -eq "NotInstalled") {
            $missing++
            continue
        }

        Write-Host ""
        Write-Host $state.DisplayName
        if ($state.State -eq "Working") {
            $working++
            Write-Host "  ok found and working"
            Write-Host "  Version: $($state.Version)"
            continue
        }
        if (Test-CodingAgentIsUsable $state) {
            # Unknown means the probe could not conclude, which is not a failure.
            $unknown++
            Write-Host "  ?  found but could not be validated"
            Write-Host "  Path: $($state.Path)"
            if ($state.Reason) {
                Write-Host "  Reason: $($state.Reason)"
            }
            continue
        }

        $broken++
        if ($state.State -eq "Unrecognized") {
            Write-Host "  !  found but is not the expected application"
        }
        else {
            Write-Host "  !  found but appears broken"
        }
        Write-Host "  Path: $($state.Path)"
        if ($state.Reason) {
            Write-Host "  Reason: $($state.Reason)"
        }
        if ($state.CandidateCount -gt 1) {
            Write-Host "  Note: $($state.CandidateCount) '$($state.CommandName)' commands are on PATH; the first one wins."
        }
    }

    Write-Host ""
    Write-Step "Existing agent summary"
    Write-Host "Working: $working"
    Write-Host "Broken: $broken"
    Write-Host "Not installed: $missing"
    if ($unknown -gt 0) {
        Write-Host "Undetermined: $unknown"
    }
    Write-Host ""
    Write-Host "A broken optional coding agent does not prevent luicode from installing."
}

function Read-CodingAgentSelection {
    param(
        [string] $CommandName,
        [string] $DisplayName,
        [string] $LuicodeCommand,
        [bool] $DefaultYes = $true,
        $State = $null
    )

    if ($null -eq $State) {
        $State = Get-CodingAgentState -CommandName $CommandName -DisplayName $DisplayName
    }
    if (Test-CodingAgentIsUsable $State) {
        if ($State.State -eq "Working") {
            Write-Host "$DisplayName already installed and working."
        }
        else {
            Write-Host "$DisplayName found on PATH; it will be verified during installation."
        }
        return $true
    }
    if (Test-CodingAgentIsBroken $State) {
        # Never overwrite a broken installation on the user's behalf. Reporting
        # and continuing keeps a stale launcher from blocking luicode.
        Write-Warning "$DisplayName was detected but failed validation. luicode does not depend on $DisplayName."
        if (-not (Read-YesNo -Prompt "Would you like luicode to attempt to repair ${DisplayName}?" -DefaultYes $false)) {
            Write-Host "Continuing without $DisplayName."
            return $false
        }
    }
    return Read-YesNo -Prompt "Install $DisplayName for ${LuicodeCommand}?" -DefaultYes $DefaultYes
}

function Select-CodingAgents {
    $states = @{}
    $ordered = @()
    foreach ($agent in $CodingAgentCatalog) {
        $state = Get-CodingAgentState -CommandName $agent.CommandName -DisplayName $agent.DisplayName
        $states[$agent.CommandName] = $state
        $ordered += $state
    }
    Write-CodingAgentDetectionReport -States $ordered

    # Cline keeps its historical npm-aware default for a genuinely absent agent.
    $defaults = @{}
    foreach ($agent in $CodingAgentCatalog) {
        $defaults[$agent.CommandName] = $agent.DefaultYes
    }
    $defaults["cline"] = $script:InstallCline

    while ($true) {
        Write-Step "Optional luicode coding agents"
        foreach ($agent in $CodingAgentCatalog) {
            $value = Read-CodingAgentSelection `
                -CommandName $agent.CommandName `
                -DisplayName $agent.DisplayName `
                -LuicodeCommand $agent.LuicodeCommand `
                -DefaultYes $defaults[$agent.CommandName] `
                -State $states[$agent.CommandName]
            switch ($agent.CommandName) {
                "claude" { $script:InstallClaudeCode = $value }
                "codex" { $script:InstallCodex = $value }
                "pi" { $script:InstallPi = $value }
                "opencode" { $script:InstallOpenCode = $value }
                "cline" { $script:InstallCline = $value }
                "hermes" { $script:InstallHermes = $value }
                "dsh" { $script:InstallDsh = $value }
                "grok" { $script:InstallGrok = $value }
                "muse" { $script:InstallMuse = $value }
                "aider" { $script:InstallAider = $value }
            }
        }

        if ($script:InstallClaudeCode -or $script:InstallCodex -or $script:InstallPi -or $script:InstallOpenCode -or $script:InstallCline -or $script:InstallHermes -or $script:InstallDsh -or $script:InstallGrok -or $script:InstallMuse -or $script:InstallAider) {
            break
        }
        Write-Host "Select at least one coding agent."
        Write-Host ""
    }

    if (-not $script:EnableRtk) {
        $rtkState = Get-CodingAgentState -CommandName "rtk" -DisplayName "RTK"
        if (Test-CodingAgentIsUsable $rtkState) {
            Write-Host "RTK already installed; will verify."
            $script:EnableRtk = $true
        }
        elseif (Test-CodingAgentIsBroken $rtkState) {
            Write-Host "RTK is installed but appears broken."
            Write-Host "luicode can continue without RTK."
            if (Read-YesNo -Prompt "Would you like luicode to attempt to repair RTK?" -DefaultYes $false) {
                Write-Host "Replacing RTK was accepted; the installer will install the pinned release."
                $script:EnableRtk = $true
            }
        }
        else {
            $script:EnableRtk = Read-YesNo `
                -Prompt "Enable RTK token optimization globally for the selected coding agents?" `
                -DefaultYes $false
        }
    }
}

function Format-Argument {
    param([string] $Value)

    if ($Value -match '^[A-Za-z0-9_./:@%+=,\[\]\\-]+$') {
        return $Value
    }

    return "'" + ($Value -replace "'", "''") + "'"
}

function Format-Command {
    param(
        [string] $FilePath,
        [string[]] $Arguments = @()
    )

    $parts = @($FilePath) + $Arguments
    return ($parts | ForEach-Object { Format-Argument ([string] $_) }) -join " "
}

function Invoke-NativeCommand {
    param(
        [string] $FilePath,
        [string[]] $Arguments = @()
    )

    $commandText = Format-Command -FilePath $FilePath -Arguments $Arguments
    Write-Host "+ $commandText"
    if ($DryRun) {
        return
    }

    $global:LASTEXITCODE = 0
    & $FilePath @Arguments
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0) {
        throw "Command failed with exit code ${exitCode}: $commandText"
    }
}

function Get-CommandShellExecutable {
    # .cmd and .bat launchers cannot be created directly by CreateProcess, so
    # they are run through the Windows command shell instead.
    if (-not [string]::IsNullOrWhiteSpace($env:ComSpec)) {
        return $env:ComSpec
    }

    $systemRoot = if ([string]::IsNullOrWhiteSpace($env:SystemRoot)) { $env:SYSTEMROOT } else { $env:SystemRoot }
    if (-not [string]::IsNullOrWhiteSpace($systemRoot)) {
        return (Join-Path $systemRoot "System32\cmd.exe")
    }

    throw "Unable to locate cmd.exe to validate a Windows command launcher."
}

function Format-NativeArgument {
    param([string] $Value)

    if ($Value -match '^[A-Za-z0-9_./:@%+=,\-]+$' -and ($Value -notmatch '^[A-Za-z0-9_.]+:$')) {
        return $Value
    }
    # Backslashes are only doubled when they precede a quote or end the argument.
    return '"' + (($Value -replace '(\\*)"', '$1$1\"') -replace '(\\+)$', '$1$1') + '"'
}

function New-AgentProbeResult {
    param(
        [string] $Path,
        [int] $ExitCode,
        [string] $StandardOutput = "",
        [string] $StandardError = "",
        [bool] $TimedOut = $false,
        [bool] $StartFailed = $false
    )

    return [pscustomobject] @{
        Path = $Path
        ExitCode = $ExitCode
        StandardOutput = $StandardOutput
        StandardError = $StandardError
        TimedOut = $TimedOut
        StartFailed = $StartFailed
    }
}

function Stop-ProbeProcessTree {
    param($Process)

    try {
        if ($null -ne $Process -and (-not $Process.HasExited)) {
            $taskkill = Join-Path $env:SystemRoot "System32\taskkill.exe"
            if (Test-Path -LiteralPath $taskkill -PathType Leaf) {
                $process = Start-Process -FilePath $taskkill -ArgumentList @("/PID", "$($Process.Id)", "/T", "/F") -WindowStyle Hidden -PassThru -Wait
                $process.Dispose()
            }
            else {
                $Process.Kill()
            }
        }
    }
    catch {
        # A probe that cannot be killed is reported as timed out below.
    }
}

function Invoke-AgentVersionProbe {
    # Runs a coding agent's version command under a hard timeout and returns the
    # outcome instead of throwing, so one broken agent cannot stop the install.
    param(
        [string] $FilePath,
        [string[]] $Arguments = @("--version"),
        [int] $TimeoutSeconds = 0
    )

    if ($TimeoutSeconds -le 0) {
        $TimeoutSeconds = $AgentProbeTimeoutSeconds
    }

    $argumentLine = ($Arguments | ForEach-Object { Format-NativeArgument $_ }) -join " "
    $extension = [IO.Path]::GetExtension($FilePath).ToLowerInvariant()
    $launcher = $FilePath
    $launcherArguments = $argumentLine
    if ($extension -notin @(".exe", ".com")) {
        $launcher = Get-CommandShellExecutable
        # The doubled outer quotes are what cmd requires for a quoted path.
        $launcherArguments = '/d /s /c ""{0}" {1}"' -f $FilePath, $argumentLine
    }

    $temporaryRoot = Join-Path ([IO.Path]::GetTempPath()) ("luicode-agent-probe-" + [guid]::NewGuid().ToString("N"))
    $stdoutPath = Join-Path $temporaryRoot "stdout.txt"
    $stderrPath = Join-Path $temporaryRoot "stderr.txt"
    $process = $null
    try {
        New-Item -ItemType Directory -Path $temporaryRoot -Force -ErrorAction Stop | Out-Null
        try {
            $process = Start-Process `
                -FilePath $launcher `
                -ArgumentList $launcherArguments `
                -WindowStyle Hidden `
                -PassThru `
                -RedirectStandardOutput $stdoutPath `
                -RedirectStandardError $stderrPath `
                -ErrorAction Stop
        }
        catch {
            return New-AgentProbeResult -Path $FilePath -ExitCode -1 -StartFailed $true `
                -StandardError $_.Exception.Message
        }

        # Windows PowerShell needs the handle retained to report the exit code.
        [void] $process.Handle
        if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
            Stop-ProbeProcessTree -Process $process
            [void] $process.WaitForExit(5000)
            return New-AgentProbeResult -Path $FilePath -ExitCode -1 -TimedOut $true
        }

        $standardOutput = if (Test-Path -LiteralPath $stdoutPath) { [IO.File]::ReadAllText($stdoutPath) } else { "" }
        $standardError = if (Test-Path -LiteralPath $stderrPath) { [IO.File]::ReadAllText($stderrPath) } else { "" }
        return New-AgentProbeResult -Path $FilePath -ExitCode $process.ExitCode `
            -StandardOutput $standardOutput -StandardError $standardError
    }
    catch {
        return New-AgentProbeResult -Path $FilePath -ExitCode -1 -StartFailed $true `
            -StandardError $_.Exception.Message
    }
    finally {
        if ($null -ne $process) { $process.Dispose() }
        Remove-Item -LiteralPath $temporaryRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Invoke-Utf8NativeCapture {
    param(
        [string] $FilePath,
        [string[]] $Arguments = @()
    )

    $commandText = Format-Command -FilePath $FilePath -Arguments $Arguments
    Write-Host "+ $commandText"
    $originalOutputEncoding = [Console]::OutputEncoding
    try {
        [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
        $global:LASTEXITCODE = 0
        $output = & $FilePath @Arguments
        $exitCode = $LASTEXITCODE
    }
    finally {
        [Console]::OutputEncoding = $originalOutputEncoding
    }
    if ($exitCode -ne 0) {
        throw "Command failed with exit code ${exitCode}: $commandText"
    }

    return ($output | Out-String).Trim()
}

function Get-ApplicationCommands {
    # Every PATH match, so a second installation can be reported instead of
    # silently shadowed by the first one.
    param([string] $Name)

    return @(Get-Command $Name -CommandType Application -ErrorAction SilentlyContinue)
}

function Get-ApplicationCommand {
    param([string] $Name)

    $commands = @(Get-ApplicationCommands -Name $Name)
    if ($commands.Count -eq 0) {
        return $null
    }

    return $commands[0]
}

function Get-PowerShellExecutable {
    param([string] $PowerShellHome = $PSHOME)

    $executableName = if ($PSVersionTable.PSEdition -eq "Core") {
        "pwsh.exe"
    }
    else {
        "powershell.exe"
    }
    $bundledExecutable = Join-Path $PowerShellHome $executableName
    if (Test-Path -LiteralPath $bundledExecutable -PathType Leaf) {
        return $bundledExecutable
    }

    $pathCommand = Get-ApplicationCommand ([IO.Path]::GetFileNameWithoutExtension($executableName))
    if ($pathCommand) {
        return $pathCommand.Source
    }

    throw "Unable to locate a PowerShell executable for the downloaded installer."
}

function Add-PathEntry {
    param([string] $PathEntry)

    if ([string]::IsNullOrWhiteSpace($PathEntry)) {
        return
    }

    $separator = [IO.Path]::PathSeparator
    $entries = @()
    if (-not [string]::IsNullOrEmpty($env:Path)) {
        $entries = $env:Path -split [regex]::Escape([string] $separator)
    }

    if ($entries -notcontains $PathEntry) {
        $env:Path = "$PathEntry$separator$env:Path"
    }
}

function Prioritize-PathEntry {
    param([string] $PathEntry)

    if ([string]::IsNullOrWhiteSpace($PathEntry)) {
        return
    }

    $separator = [IO.Path]::PathSeparator
    $env:Path = "$PathEntry$separator$env:Path"
}

function Add-KnownBinDirectories {
    if (-not [string]::IsNullOrWhiteSpace($env:USERPROFILE)) {
        Add-PathEntry (Join-Path $env:USERPROFILE ".local\bin")
        Add-PathEntry (Join-Path $env:USERPROFILE ".opencode\bin")
    }
    if (-not [string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
        Add-PathEntry (Join-Path $env:LOCALAPPDATA "hermes\hermes-agent\bin")
    }
    if (-not [string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
        Add-PathEntry (Join-Path $env:LOCALAPPDATA "Programs\OpenAI\Codex\bin")
        Add-PathEntry (Join-Path $env:LOCALAPPDATA "pi-node\current")
        Add-PathEntry (Join-Path $env:LOCALAPPDATA "Programs\Muse Code\bin")
    }
    if (-not [string]::IsNullOrWhiteSpace($env:APPDATA)) {
        Add-PathEntry (Join-Path $env:APPDATA "npm")
    }
    if ($env:GROK_BIN_DIR) {
        Add-PathEntry $env:GROK_BIN_DIR
    }
    elseif (-not [string]::IsNullOrWhiteSpace($env:USERPROFILE)) {
        Add-PathEntry (Join-Path $env:USERPROFILE ".grok\bin")
    }
}

function Add-NpmBinDirectories {
    if ($DryRun) {
        return
    }

    Add-KnownBinDirectories
    $npm = Get-ApplicationCommand "npm"
    if (-not $npm) {
        return
    }

    $prefix = (& $npm.Source prefix -g 2>$null | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($prefix)) {
        $prefix = (& $npm.Source config get prefix 2>$null | Out-String).Trim()
    }
    if ($LASTEXITCODE -eq 0 -and -not [string]::IsNullOrWhiteSpace($prefix)) {
        Add-PathEntry $prefix
    }
}

function Assert-NoLuicodeProcessesRunning {
    $running = @()
    foreach ($commandName in $LuicodeCommands) {
        $processes = @(Get-Process -Name $commandName -ErrorAction SilentlyContinue)
        foreach ($process in $processes) {
            $running += "$commandName (PID $($process.Id))"
        }
    }

    if ($running.Count -gt 0) {
        throw "luicode is still running ($($running -join ', ')). Stop those processes, then rerun the installer."
    }
}

function Invoke-DownloadedPowerShellInstaller {
    param(
        [string] $Url,
        [string] $Name,
        [switch] $NonInteractive,
        [string[]] $ScriptArguments = @()
    )

    if ($DryRun) {
        Write-Host "+ irm $Url -OutFile <temporary-script>"
        $prefix = if ($NonInteractive) { "CODEX_NON_INTERACTIVE=1 " } else { "" }
        $suffix = if ($ScriptArguments.Count -gt 0) {
            " " + (($ScriptArguments | ForEach-Object { Format-Argument $_ }) -join " ")
        }
        else {
            ""
        }
        Write-Host "+ ${prefix}powershell -NoProfile -ExecutionPolicy Bypass -File <temporary-script>$suffix"
        return
    }

    $temporaryScript = Join-Path ([IO.Path]::GetTempPath()) ("luicode-install-" + [guid]::NewGuid().ToString("N") + ".ps1")
    try {
        Write-Host "+ irm $Url -OutFile $(Format-Argument $temporaryScript)"
        Invoke-RestMethod -Uri $Url -OutFile $temporaryScript -ErrorAction Stop
        if ((-not (Test-Path -LiteralPath $temporaryScript)) -or ((Get-Item -LiteralPath $temporaryScript).Length -eq 0)) {
            throw "The downloaded $Name installer was empty."
        }

        $tokens = $null
        $parseErrors = $null
        [System.Management.Automation.Language.Parser]::ParseFile(
            $temporaryScript,
            [ref] $tokens,
            [ref] $parseErrors
        ) | Out-Null
        if ($parseErrors.Count -gt 0) {
            throw "The downloaded $Name installer from '$Url' is not valid PowerShell. A network proxy or filter may have replaced it with an HTML response."
        }

        $powerShellPath = Get-PowerShellExecutable

        $hadNonInteractive = Test-Path Env:CODEX_NON_INTERACTIVE
        $previousNonInteractive = $env:CODEX_NON_INTERACTIVE
        try {
            if ($NonInteractive) {
                $env:CODEX_NON_INTERACTIVE = "1"
            }
            $installerArguments = @(
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                $temporaryScript
            ) + $ScriptArguments
            Invoke-NativeCommand -FilePath $powerShellPath -Arguments $installerArguments
        }
        finally {
            if ($hadNonInteractive) {
                $env:CODEX_NON_INTERACTIVE = $previousNonInteractive
            }
            else {
                Remove-Item Env:CODEX_NON_INTERACTIVE -ErrorAction SilentlyContinue
            }
        }
    }
    finally {
        Remove-Item -LiteralPath $temporaryScript -Force -ErrorAction SilentlyContinue
    }
}

function Confirm-Application {
    param(
        [string] $CommandName,
        [string] $DisplayName
    )

    if ($DryRun) {
        Write-Host "+ $CommandName --version"
        return
    }

    $command = Get-ApplicationCommand $CommandName
    if (-not $command) {
        throw "$DisplayName was installed, but '$CommandName' is not available on PATH."
    }
    Invoke-NativeCommand -FilePath $command.Source -Arguments @("--version")
}

function Test-PiApplication {
    param($Command)

    try {
        $helpOutput = (& $Command.Source --help 2>$null | Out-String)
    }
    catch {
        return $false
    }
    return (
        $LASTEXITCODE -eq 0 -and
        $helpOutput.Contains("--extension") -and
        $helpOutput.Contains("--models")
    )
}

function Confirm-PiApplication {
    if ($DryRun) {
        Write-Host "+ pi --help (verify --extension and --models support)"
        Write-Host "+ pi --version"
        return
    }

    $command = Get-ApplicationCommand "pi"
    if (-not $command) {
        throw "Pi was installed, but 'pi' is not available on PATH."
    }
    if (-not (Test-PiApplication $command)) {
        throw "The 'pi' command at '$($command.Source)' is not a compatible Pi Coding Agent."
    }
    Invoke-NativeCommand -FilePath $command.Source -Arguments @("--version")
}

function Install-Rtk {
    $archiveUrl = "$RtkReleaseBaseUrl/$RtkWindowsAssetName"
    if ($DryRun) {
        Write-Host "+ irm $archiveUrl -OutFile <temporary-archive>"
        Write-Host "+ verify pinned SHA-256 for $RtkWindowsAssetName"
        Write-Host "+ extract and install rtk.exe to ~/.local/bin"
        return
    }

    $temporaryRoot = Join-Path ([IO.Path]::GetTempPath()) ("luicode-rtk-" + [guid]::NewGuid().ToString("N"))
    $archivePath = Join-Path $temporaryRoot $RtkWindowsAssetName
    $extractPath = Join-Path $temporaryRoot "extracted"
    try {
        New-Item -ItemType Directory -Path $temporaryRoot | Out-Null

        Write-Host "+ irm $archiveUrl -OutFile $(Format-Argument $archivePath)"
        Invoke-RestMethod -Uri $archiveUrl -OutFile $archivePath -ErrorAction Stop
        if ((-not (Test-Path -LiteralPath $archivePath -PathType Leaf)) -or ((Get-Item -LiteralPath $archivePath).Length -eq 0)) {
            throw "The RTK release archive was empty."
        }

        $sha256 = [Security.Cryptography.SHA256]::Create()
        $archiveStream = [IO.File]::OpenRead($archivePath)
        try {
            $actualHash = [BitConverter]::ToString($sha256.ComputeHash($archiveStream)).Replace("-", "").ToLowerInvariant()
        }
        finally {
            $archiveStream.Dispose()
            $sha256.Dispose()
        }
        if ($actualHash -ne $RtkWindowsAssetSha256) {
            throw "RTK checksum verification failed for $RtkWindowsAssetName."
        }

        Expand-Archive -LiteralPath $archivePath -DestinationPath $extractPath
        $extractedExecutable = Join-Path $extractPath "rtk.exe"
        if (-not (Test-Path -LiteralPath $extractedExecutable -PathType Leaf)) {
            throw "The verified RTK archive did not contain rtk.exe."
        }

        $installDirectory = Join-Path $env:USERPROFILE ".local\bin"
        New-Item -ItemType Directory -Force -Path $installDirectory | Out-Null
        Copy-Item -LiteralPath $extractedExecutable -Destination (Join-Path $installDirectory "rtk.exe") -Force
    }
    finally {
        if (Test-Path -LiteralPath $temporaryRoot) {
            Remove-Item -LiteralPath $temporaryRoot -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}

function Invoke-RtkCommand {
    param([string[]] $Arguments)

    if ($DryRun) {
        Write-Host "+ RTK_TELEMETRY_DISABLED=1 $(Format-Command -FilePath 'rtk' -Arguments $Arguments)"
        return
    }

    $command = Get-ApplicationCommand "rtk"
    if (-not $command) {
        throw "RTK was installed, but 'rtk' is not available on PATH."
    }

    $hadTelemetryDisabled = Test-Path Env:RTK_TELEMETRY_DISABLED
    $previousTelemetryDisabled = $env:RTK_TELEMETRY_DISABLED
    try {
        $env:RTK_TELEMETRY_DISABLED = "1"
        Invoke-NativeCommand -FilePath $command.Source -Arguments $Arguments
    }
    finally {
        if ($hadTelemetryDisabled) {
            $env:RTK_TELEMETRY_DISABLED = $previousTelemetryDisabled
        }
        else {
            Remove-Item Env:RTK_TELEMETRY_DISABLED -ErrorAction SilentlyContinue
        }
    }
}

function Ensure-RtkClaudeConfigDirectory {
    $claudeConfigDirectory = $env:CLAUDE_CONFIG_DIR
    if ([string]::IsNullOrWhiteSpace($claudeConfigDirectory)) {
        $claudeConfigDirectory = Join-Path $env:USERPROFILE ".claude"
    }

    if ($DryRun) {
        Write-Host "+ mkdir $(Format-Argument $claudeConfigDirectory)"
        return
    }

    New-Item -ItemType Directory -Force -Path $claudeConfigDirectory | Out-Null
}

function Confirm-RtkApplication {
    if ($DryRun) {
        Invoke-RtkCommand -Arguments @("--version")
        Invoke-RtkCommand -Arguments @("gain")
        return
    }

    $command = Get-ApplicationCommand "rtk"
    if (-not $command) {
        throw "RTK was installed, but 'rtk' is not available on PATH."
    }

    try {
        Invoke-RtkCommand -Arguments @("--version")
        Invoke-RtkCommand -Arguments @("gain")
    }
    catch {
        throw "The 'rtk' command at '$($command.Source)' is not a compatible Rust Token Killer installation. Remove the conflicting command from PATH, then rerun the installer. $($_.Exception.Message)"
    }
}

function Ensure-Rtk {
    if (Get-ApplicationCommand "rtk") {
        Write-Host "RTK already found on PATH; verifying it without updating it."
    }
    else {
        Install-Rtk
        Add-KnownBinDirectories
    }

    Confirm-RtkApplication
}

function Configure-RtkForSelectedAgents {
    if (-not $script:EnableRtk) {
        return
    }

    Write-Step "Installing and configuring RTK token optimization"
    Ensure-Rtk

    if ($script:InstallClaudeCode) {
        Ensure-RtkClaudeConfigDirectory
        Invoke-RtkCommand -Arguments @("init", "--global", "--auto-patch")
    }
    if ($script:InstallCodex) {
        Invoke-RtkCommand -Arguments @("init", "--global", "--codex")
    }
    if ($script:InstallPi -and $script:PiAvailable) {
        Invoke-RtkCommand -Arguments @("init", "--global", "--agent", "pi")
    }
    if ($script:InstallCline) {
        Write-Host "Optional for each project: cd <project>; `$env:RTK_TELEMETRY_DISABLED='1'; rtk init --agent cline"
    }
}

function Ensure-ClaudeCode {
    if (Get-ApplicationCommand "claude") {
        Write-Host "Claude Code already found on PATH; verifying it."
    }
    else {
        Invoke-DownloadedPowerShellInstaller -Url $ClaudeInstallUrl -Name "Claude Code"
        Add-KnownBinDirectories
    }

    Confirm-Application -CommandName "claude" -DisplayName "Claude Code"
}

function Ensure-Codex {
    if (Get-ApplicationCommand "codex") {
        Write-Host "Codex already found on PATH; verifying it."
    }
    else {
        Invoke-DownloadedPowerShellInstaller -Url $CodexInstallUrl -Name "Codex" -NonInteractive
        Add-KnownBinDirectories
    }

    Confirm-Application -CommandName "codex" -DisplayName "Codex"
}

function Ensure-Pi {
    $script:PiAvailable = $false
    Add-NpmBinDirectories
    $existingPi = Get-ApplicationCommand "pi"
    if ($existingPi -and ($DryRun -or (Test-PiApplication $existingPi))) {
        Write-Host "Pi already found on PATH; verifying it."
    }
    else {
        if ($existingPi) {
            Write-Host "The existing 'pi' command at '$($existingPi.Source)' is not Pi Coding Agent; installing Pi."
        }
        Invoke-DownloadedPowerShellInstaller -Url $PiInstallUrl -Name "Pi"
        Add-NpmBinDirectories

        if (-not $DryRun) {
            $currentPi = Get-ApplicationCommand "pi"
            $unchangedIncompatiblePi = (
                $currentPi -and
                $existingPi -and
                $currentPi.Source -eq $existingPi.Source -and
                -not (Test-PiApplication $currentPi)
            )
            if ((-not $currentPi) -or $unchangedIncompatiblePi) {
                Write-Host "Pi was not installed; continuing without it."
                return
            }
        }
    }

    Confirm-PiApplication
    $script:PiAvailable = $true
}

function Convert-SemanticVersionOutput {
    param([string] $Output)

    if ([string]::IsNullOrWhiteSpace($Output)) {
        return ""
    }
    if ($Output -match '(?m)^\s*(?:(?:uv|opencode|cline|dsh|node)(?:\s+version)?\s+|Hermes Agent\s+v?|v)?(?<version>\d+\.\d+\.\d+(?:[-+][0-9A-Za-z][0-9A-Za-z.-]*)?)(?:\s+\([^\r\n]*\))?\s*$') {
        return $Matches["version"]
    }
    return ""
}

function Test-SupportedStableVersion {
    param(
        [string] $Version,
        [string] $Minimum
    )

    $parsedVersion = Convert-SemanticVersionOutput $Version
    $parsedMinimum = Convert-SemanticVersionOutput $Minimum
    if ([string]::IsNullOrWhiteSpace($parsedVersion) -or [string]::IsNullOrWhiteSpace($parsedMinimum)) {
        throw "Unable to compare semantic versions."
    }
    if ($parsedVersion.Contains("-")) {
        return $false
    }

    $normalizedVersion = $parsedVersion -replace '\+.*$', ''
    $normalizedMinimum = $parsedMinimum -replace '\+.*$', ''
    return ([version] $normalizedVersion) -ge ([version] $normalizedMinimum)
}

function Read-OpenCodeVersionOutput {
    param([string] $OpenCodePath)

    # Shares the bounded probe so a hung OpenCode cannot stall the installer,
    # while keeping this call site's throwing contract.
    $probe = Invoke-AgentVersionProbe -FilePath $OpenCodePath
    if ($probe.TimedOut) {
        throw "OpenCode version probe timed out at '$OpenCodePath'."
    }
    if ($probe.StartFailed) {
        throw "OpenCode version probe could not start '$OpenCodePath'."
    }
    if ($probe.ExitCode -ne 0) {
        throw "OpenCode version probe failed at '$OpenCodePath' (exit code $($probe.ExitCode))."
    }
    return $probe.StandardOutput
}

function Get-OpenCodeVersion {
    param([string] $OpenCodePath)

    $output = Read-OpenCodeVersionOutput $OpenCodePath
    if ($output -match '(?m)^\s*(?:opencode(?:\s+version)?\s+)?v?(?<version>\d+\.\d+\.\d+(?:\+[0-9A-Za-z.-]+)?)\s*$') {
        return $Matches["version"]
    }
    return ""
}

function Get-OpenCodeRtkPlugin {
    $pluginPath = Join-Path $env:USERPROFILE ".config\opencode\plugins\rtk.ts"
    try {
        $plugin = Get-Item -LiteralPath $pluginPath -Force -ErrorAction Stop
    }
    catch [System.Management.Automation.ItemNotFoundException] {
        return $null
    }
    if ($plugin.PSIsContainer -or ($plugin.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw "Disable or migrate the RTK plugin at '$pluginPath' manually, then rerun the installer."
    }
    # These include the backup's parent; a junction must not redirect either move.
    foreach ($relativePath in @(".config", ".config\opencode", ".config\opencode\plugins")) {
        $parent = Get-Item -LiteralPath (Join-Path $env:USERPROFILE $relativePath) -Force -ErrorAction Stop
        if ($parent.Attributes -band [IO.FileAttributes]::ReparsePoint) {
            throw "The RTK plugin directory is linked: '$($parent.FullName)'. Disable or migrate it manually, then rerun the installer."
        }
    }
    $sha256 = [Security.Cryptography.SHA256]::Create()
    try {
        $hash = [BitConverter]::ToString($sha256.ComputeHash([IO.File]::ReadAllBytes($pluginPath))).Replace("-", "").ToLowerInvariant()
    }
    finally {
        $sha256.Dispose()
    }
    if ($hash -ne "6530c131946c84892f9522abd68d4e513e1e658d8ddbad1f59388c86ebbcb6bb") {
        throw "The RTK plugin at '$pluginPath' was modified or is unrecognized. Disable or migrate it manually, then rerun the installer."
    }
    return $pluginPath
}

function Get-OpenCodeWindowsAssetName {
    $architecture = $env:PROCESSOR_ARCHITEW6432
    if ([string]::IsNullOrWhiteSpace($architecture)) {
        $architecture = $env:PROCESSOR_ARCHITECTURE
    }
    if ([string]::IsNullOrWhiteSpace($architecture)) {
        $architecture = [Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
    }

    switch ($architecture.ToUpperInvariant()) {
        "ARM64" { return "opencode-windows-arm64.zip" }
        "AMD64" { return "opencode-windows-x64-baseline.zip" }
        "X64" { return "opencode-windows-x64-baseline.zip" }
        "X86_64" { return "opencode-windows-x64-baseline.zip" }
        default { throw "OpenCode does not provide a supported Windows release for architecture '$architecture'." }
    }
}

function Assert-NoOpenCodeProcessesRunning {
    if (@(Get-Process -Name opencode,opencode2 -ErrorAction SilentlyContinue).Count -gt 0) {
        throw "Close OpenCode before replacing its executable or RTK plugin, then rerun the installer."
    }
}

function Install-OpenCode {
    $assetName = Get-OpenCodeWindowsAssetName
    $installDirectory = Join-Path $env:USERPROFILE ".opencode\bin"
    if ($DryRun) {
        Write-Host "+ resolve latest stable OpenCode 2 and download $assetName"
        Write-Host "+ extract and install opencode.exe to $(Format-Argument $installDirectory)"
        return
    }

    $release = Invoke-RestMethod -Uri "https://opencode.ai/update/api/latest/cli/npm" -ErrorAction Stop
    if ($release.version -isnot [string] -or $release.version -notmatch '^2\.\d+\.\d+$') {
        throw "The OpenCode release channel did not return a stable OpenCode 2 version."
    }
    $archiveUrl = "$OpenCodeReleaseBaseUrl/$($release.version)/$assetName"

    $temporaryRoot = Join-Path ([IO.Path]::GetTempPath()) ("luicode-opencode-" + [guid]::NewGuid().ToString("N"))
    $archivePath = Join-Path $temporaryRoot $assetName
    $extractPath = Join-Path $temporaryRoot "extracted"
    $temporaryInstallPath = Join-Path $installDirectory (".opencode-" + [guid]::NewGuid().ToString("N") + ".exe")
    try {
        New-Item -ItemType Directory -Path $temporaryRoot | Out-Null
        Write-Host "+ irm $archiveUrl -OutFile $(Format-Argument $archivePath)"
        Invoke-RestMethod -Uri $archiveUrl -OutFile $archivePath -ErrorAction Stop
        if ((-not (Test-Path -LiteralPath $archivePath -PathType Leaf)) -or ((Get-Item -LiteralPath $archivePath).Length -eq 0)) {
            throw "The OpenCode release archive was empty."
        }

        Expand-Archive -LiteralPath $archivePath -DestinationPath $extractPath
        $executables = @(Get-ChildItem -LiteralPath $extractPath -Recurse -File -Filter "opencode.exe")
        if ($executables.Count -ne 1) {
            throw "The OpenCode release archive did not contain exactly one opencode.exe."
        }
        $version = Get-OpenCodeVersion $executables[0].FullName
        if (($version -replace '\+.*$', '') -ne $release.version) {
            throw "The OpenCode archive did not contain the selected stable version $($release.version)."
        }

        New-Item -ItemType Directory -Force -Path $installDirectory | Out-Null
        Copy-Item -LiteralPath $executables[0].FullName -Destination $temporaryInstallPath
        if ((-not (Test-Path -LiteralPath $temporaryInstallPath -PathType Leaf)) -or ((Get-Item -LiteralPath $temporaryInstallPath).Length -eq 0)) {
            throw "The extracted OpenCode executable was empty."
        }
        Assert-NoOpenCodeProcessesRunning
        Move-Item -LiteralPath $temporaryInstallPath -Destination (Join-Path $installDirectory "opencode.exe") -Force
    }
    finally {
        Remove-Item -LiteralPath $temporaryInstallPath -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $temporaryRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Ensure-OpenCode {
    $command = if ($script:OriginalOpenCode) { $script:OriginalOpenCode } else { Get-ApplicationCommand "opencode" }
    $nativePath = Join-Path $env:USERPROFILE ".opencode\bin\opencode.exe"
    if ($DryRun) {
        Write-Host "+ opencode --version"
        Write-Host "Install stable OpenCode 2 if absent, or migrate v1 at '$nativePath'; external v1 requires manual upgrade."
        Write-Host "Check and back up the recognized old OpenCode RTK plugin if present."
        if (-not $command) { Install-OpenCode }
        return
    }

    $install = $true
    if ($command) {
        $version = Get-OpenCodeVersion $command.Source
        if ($version -match '^2\.') {
            $install = $false
        }
        elseif ($version -match '^1\.') {
            if (-not (Test-EquivalentPath $command.Source $nativePath)) {
                throw "OpenCode 1 at '$($command.Source)' requires manual migration. Remove it with its package manager (npm: npm uninstall -g opencode-ai), then rerun this installer. See https://opencode.ai/v2/docs/migrate-v1/"
            }
        }
        else {
            throw "OpenCode at '$($command.Source)' is not a recognized stable v1 or v2. Correct that installation, then rerun the installer. See https://opencode.ai/v2/docs/migrate-v1/"
        }
    }
    $pluginPath = Get-OpenCodeRtkPlugin
    if ($install -or $pluginPath) {
        Assert-NoOpenCodeProcessesRunning
    }
    if ($install) {
        foreach ($target in @((Join-Path $env:USERPROFILE ".opencode"), (Split-Path -Parent $nativePath), $nativePath)) {
            $item = Get-Item -LiteralPath $target -Force -ErrorAction SilentlyContinue
            if ($null -ne $item -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
                throw "OpenCode installation path is linked: '$target'. Migrate it manually."
            }
        }
        Install-OpenCode
        Add-KnownBinDirectories
        if ((Get-OpenCodeVersion $nativePath) -notmatch '^2\.') {
            throw "The OpenCode installer did not install stable OpenCode 2 at '$nativePath'."
        }
    }
    # Check the command selected after the installer's PATH additions.
    $command = Get-ApplicationCommand "opencode"
    if (-not $command) { throw "OpenCode is not available on PATH after installation." }
    $version = Get-OpenCodeVersion $command.Source
    if ($version -notmatch '^2\.') {
        throw "OpenCode at '$($command.Source)' is not stable OpenCode 2. Correct PATH, then rerun the installer."
    }
    Write-Host "Verified OpenCode $version at '$($command.Source)'."
    if ($pluginPath) {
        $pluginPath = Get-OpenCodeRtkPlugin
        if (-not $pluginPath) { return }
        $backupPath = Join-Path (Split-Path -Parent (Split-Path -Parent $pluginPath)) ("rtk-v1-" + [guid]::NewGuid().ToString("N") + ".bak")
        Assert-NoOpenCodeProcessesRunning
        Move-Item -LiteralPath $pluginPath -Destination $backupPath -ErrorAction Stop
        Write-Host "OpenCode 2 RTK support is unavailable; the old plugin was saved at '$backupPath'."
    }
}

function Ensure-Cline {
    Add-NpmBinDirectories

    $command = Get-ApplicationCommand "cline"
    if ($command) {
        Write-Host "Cline already found on PATH; verifying it."
    }
    else {
        $npm = Get-ApplicationCommand "npm"
        if (-not $npm) {
            throw "Cline installation requires npm. Install Node.js from https://nodejs.org/en/download, then rerun the installer."
        }
        Invoke-NativeCommand -FilePath $npm.Source -Arguments @("install", "-g", "cline")
        Add-NpmBinDirectories
    }

    Confirm-Application -CommandName "cline" -DisplayName "Cline"
}

function Confirm-HermesArchitecture {
    $architecture = $env:PROCESSOR_ARCHITEW6432
    if ([string]::IsNullOrWhiteSpace($architecture)) {
        $architecture = $env:PROCESSOR_ARCHITECTURE
    }
    if ([string]::IsNullOrWhiteSpace($architecture)) {
        $architecture = [Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
    }
    if ($architecture.ToUpperInvariant() -notin @("ARM64", "AMD64", "X64", "X86_64")) {
        throw "Hermes Agent does not provide a supported Windows release for architecture '$architecture'."
    }
}

function Install-Hermes {
    Confirm-HermesArchitecture
    Invoke-DownloadedPowerShellInstaller `
        -Url $HermesInstallUrl `
        -Name "Hermes Agent" `
        -ScriptArguments @("-NonInteractive", "-SkipSetup")
    Add-KnownBinDirectories
}

function Ensure-Hermes {
    $command = Get-ApplicationCommand "hermes"
    if ($command) {
        Write-Host "Hermes Agent already found on PATH; verifying it."
    }
    else {
        Install-Hermes
    }

    Confirm-Application -CommandName "hermes" -DisplayName "Hermes Agent"
}

function Install-Grok {
    Invoke-DownloadedPowerShellInstaller -Url $GrokInstallUrl -Name "Grok Build"
    Add-KnownBinDirectories
}

function Ensure-Grok {
    $command = Get-ApplicationCommand "grok"
    if ($command) {
        Write-Host "Grok Build already found on PATH; verifying it."
    }
    else {
        Install-Grok
    }

    Confirm-Application -CommandName "grok" -DisplayName "Grok Build"
}

function Install-Aider {
    $uvPath = "uv"
    if (-not $DryRun) {
        $uvCommand = Get-ApplicationCommand "uv"
        if (-not $uvCommand) {
            throw "Aider installation requires the verified uv command, but it is not available on PATH."
        }
        $uvPath = $uvCommand.Source
    }

    Invoke-NativeCommand -FilePath $uvPath -Arguments @(
        "tool",
        "install",
        "--force",
        "--python",
        "python3.12",
        "--with",
        "pip",
        "aider-chat@latest"
    )
}

function Add-UvToolBinDirectory {
    param([string] $UvPath)

    $toolBin = Invoke-Utf8NativeCapture -FilePath $UvPath -Arguments @("tool", "dir", "--bin")
    if ([string]::IsNullOrWhiteSpace($toolBin)) {
        throw "uv returned an empty tool bin directory."
    }

    Add-PathEntry $toolBin
    return $toolBin
}

function Ensure-Aider {
    $command = Get-ApplicationCommand "aider"
    if ((-not $command) -and (-not $DryRun)) {
        $uvCommand = Get-ApplicationCommand "uv"
        if (-not $uvCommand) {
            throw "Aider installation requires the verified uv command, but it is not available on PATH."
        }
        $null = Add-UvToolBinDirectory -UvPath $uvCommand.Source
        $command = Get-ApplicationCommand "aider"
    }

    if ($command) {
        Write-Host "Aider already found on PATH; verifying it."
    }
    else {
        Install-Aider
    }

    Confirm-Application -CommandName "aider" -DisplayName "Aider"
}

function Ensure-Muse {
    $script:MuseAvailable = $false
    Invoke-DownloadedPowerShellInstaller -Url $MuseInstallUrl -Name "Muse Code"
    Add-KnownBinDirectories
    $commandName = "muse"
    if (-not $DryRun) {
        $command = Find-InstalledCodingAgent "muse"
        if (-not $command) {
            throw "Muse Code was installed, but 'muse' is not available on PATH."
        }
        $commandName = $command.Source
    }
    Confirm-Application -CommandName $commandName -DisplayName "Muse Code"
    $script:MuseAvailable = $true
}

function Get-DshVersion {
    param([string] $DshPath)

    $output = Invoke-Utf8NativeCapture -FilePath $DshPath -Arguments @("--version")
    $version = Convert-SemanticVersionOutput $output
    if ([string]::IsNullOrWhiteSpace($version) -or (-not $version.Contains("-"))) {
        throw "DeepSeek Harness is present, but 'dsh --version' did not return its preview semantic version."
    }
    return $version
}

function Get-DshNodeVersion {
    param([string] $NodePath)

    $output = Invoke-Utf8NativeCapture -FilePath $NodePath -Arguments @("--version")
    $version = Convert-SemanticVersionOutput $output
    if ([string]::IsNullOrWhiteSpace($version)) {
        throw "DeepSeek Harness requires a readable Node.js version."
    }
    return $version
}

function Test-DshNodeVersion {
    param([string] $Version)

    try {
        $parsed = [version] (($Version -replace '^v', '') -replace '[-+].*$', '')
    }
    catch {
        return $false
    }
    return (
        (($parsed.Major -eq 22) -and ($parsed.Minor -ge 19)) -or
        ($parsed.Major -ge 24)
    )
}

function Test-DshToolchain {
    $node = Get-ApplicationCommand "node"
    $npm = Get-ApplicationCommand "npm"
    if ((-not $node) -or (-not $npm)) {
        return $false
    }
    try {
        return (Test-DshNodeVersion -Version (Get-DshNodeVersion $node.Source))
    }
    catch {
        return $false
    }
}

function Confirm-DshToolchain {
    $node = Get-ApplicationCommand "node"
    if (-not $node) {
        throw "DeepSeek Harness requires Node.js ^22.19.0 or >=24.0.0 and npm. Install Node.js, then rerun the installer."
    }
    $npm = Get-ApplicationCommand "npm"
    if (-not $npm) {
        throw "DeepSeek Harness requires npm. Install npm, then rerun the installer."
    }
    $version = Get-DshNodeVersion $node.Source
    if (-not (Test-DshNodeVersion $version)) {
        throw "DeepSeek Harness requires Node.js ^22.19.0 or >=24.0.0; found Node.js $version."
    }
    return $npm.Source
}

function Confirm-DshApplication {
    if ($DryRun) {
        Write-Host "+ dsh --version"
        return
    }

    $command = Get-ApplicationCommand "dsh"
    if (-not $command) {
        throw "DeepSeek Harness was installed, but 'dsh' is not available on PATH."
    }
    $version = Get-DshVersion $command.Source
    if ($version -ne $DshVersion) {
        throw "DeepSeek Harness $DshVersion is required; found $version after installation."
    }
    Write-Host "Verified DeepSeek Harness $version."
}

function Install-Dsh {
    $npmPath = Confirm-DshToolchain
    Invoke-NativeCommand -FilePath $npmPath -Arguments @("install", "-g", $DshPackage)
    Add-NpmBinDirectories
}

function Ensure-Dsh {
    Add-NpmBinDirectories

    if ($DryRun) {
        if (Get-ApplicationCommand "dsh") {
            Write-Host "+ dsh --version"
            Write-Host "The exact supported DeepSeek Harness preview will be preserved; another version will be replaced."
        }
        else {
            $node = Get-ApplicationCommand "node"
            $npm = Get-ApplicationCommand "npm"
            if ((-not $node) -or (-not $npm)) {
                throw "DeepSeek Harness requires Node.js ^22.19.0 or >=24.0.0 and npm. Install Node.js, then rerun the installer."
            }
            $npmPath = $npm.Source
            Write-Host "+ $(Format-Command -FilePath $npmPath -Arguments @('install', '-g', $DshPackage))"
        }
        Confirm-DshApplication
        return
    }

    [void] (Confirm-DshToolchain)
    $command = Get-ApplicationCommand "dsh"
    if ($command) {
        $version = Get-DshVersion $command.Source
        if ($version -eq $DshVersion) {
            Write-Host "DeepSeek Harness $version already matches the supported preview; leaving it unchanged."
            return
        }
        Write-Host "DeepSeek Harness $version does not match $DshVersion; replacing it with the supported preview."
    }

    Install-Dsh
    Confirm-DshApplication
}

function Ensure-SelectedCodingAgents {
    if ($script:InstallClaudeCode) {
        Write-Step "Ensuring Claude Code is installed"
        Ensure-ClaudeCode
    }

    if ($script:InstallCodex) {
        Write-Step "Ensuring Codex is installed"
        Ensure-Codex
    }

    if ($script:InstallPi) {
        Write-Step "Checking or installing Pi"
        Ensure-Pi
    }

    if ($script:InstallOpenCode) {
        Write-Step "Ensuring OpenCode is installed"
        Ensure-OpenCode
    }

    if ($script:InstallCline) {
        Write-Step "Ensuring Cline CLI is installed"
        Ensure-Cline
    }

    if ($script:InstallHermes) {
        Write-Step "Ensuring Hermes Agent is installed"
        Ensure-Hermes
    }

    if ($script:InstallDsh) {
        Write-Step "Ensuring DeepSeek Harness is installed"
        Ensure-Dsh
    }

    if ($script:InstallGrok) {
        Write-Step "Ensuring Grok Build is installed"
        Ensure-Grok
    }

    if ($script:InstallMuse) {
        Write-Step "Ensuring Muse Code is installed"
        Ensure-Muse
    }

    if ($script:InstallAider) {
        Write-Step "Ensuring Aider is installed"
        Ensure-Aider
    }

    if ((-not $script:InstallClaudeCode) -and (-not $script:InstallCodex) -and (-not $script:PiAvailable) -and (-not $script:InstallOpenCode) -and (-not $script:InstallCline) -and (-not $script:InstallHermes) -and (-not $script:InstallDsh) -and (-not $script:InstallGrok) -and (-not $script:MuseAvailable) -and (-not $script:InstallAider)) {
        throw "No selected coding agent was installed. Re-run the installer and choose at least one."
    }
}

function Get-UvVersion {
    param([string] $UvPath)

    $output = Invoke-Utf8NativeCapture -FilePath $UvPath -Arguments @("--version")
    $version = Convert-SemanticVersionOutput $output
    if ([string]::IsNullOrWhiteSpace($version)) {
        throw "uv is present, but 'uv --version' did not return a valid version."
    }

    return $version
}

function Confirm-Uv {
    if ($DryRun) {
        Write-Host "+ uv --version"
        return
    }

    $uvCommand = Get-ApplicationCommand "uv"
    if (-not $uvCommand) {
        throw "uv was installed, but it is not available on PATH."
    }

    $version = Get-UvVersion $uvCommand.Source
    if (-not (Test-SupportedStableVersion -Version $version -Minimum $MinUvVersion)) {
        throw "Stable uv $MinUvVersion or newer is required; found uv $version after installation."
    }
    Write-Host "Verified uv $version."
}

function Get-UvInstallBinDirectory {
    $forceInstallDirectory = if (-not [string]::IsNullOrWhiteSpace($env:UV_INSTALL_DIR)) {
        $env:UV_INSTALL_DIR
    }
    elseif (-not [string]::IsNullOrWhiteSpace($env:UV_UNMANAGED_INSTALL)) {
        $env:UV_UNMANAGED_INSTALL
    }
    else {
        $null
    }

    if (-not [string]::IsNullOrWhiteSpace($forceInstallDirectory)) {
        $cargoHome = if (-not [string]::IsNullOrWhiteSpace($env:CARGO_HOME)) {
            $env:CARGO_HOME
        }
        elseif (-not [string]::IsNullOrWhiteSpace($HOME)) {
            Join-Path $HOME ".cargo"
        }
        else {
            $null
        }
        if ($cargoHome -and $forceInstallDirectory.Replace("\\", "\") -eq $cargoHome) {
            return Join-Path $forceInstallDirectory "bin"
        }
        return $forceInstallDirectory
    }
    if (-not [string]::IsNullOrWhiteSpace($env:XDG_BIN_HOME)) {
        return $env:XDG_BIN_HOME
    }
    if (-not [string]::IsNullOrWhiteSpace($env:XDG_DATA_HOME)) {
        return Join-Path $env:XDG_DATA_HOME "..\bin"
    }
    if (-not [string]::IsNullOrWhiteSpace($env:USERPROFILE)) {
        return Join-Path $env:USERPROFILE ".local\bin"
    }

    throw "Could not determine where the standalone uv installer places uv."
}

function Ensure-Uv {
    if ($DryRun) {
        if (Get-ApplicationCommand "uv") {
            Write-Host "+ uv --version"
            Write-Host "A compatible existing uv will be left unchanged; an obsolete one will be replaced by the standalone installer."
        }
        else {
            Write-Host "uv is not installed; the current standalone uv would be installed."
            Invoke-DownloadedPowerShellInstaller -Url $UvInstallUrl -Name "uv"
            Confirm-Uv
        }
        return
    }

    $uvCommand = Get-ApplicationCommand "uv"
    if ($uvCommand) {
        $version = Get-UvVersion $uvCommand.Source
        if (Test-SupportedStableVersion -Version $version -Minimum $MinUvVersion) {
            Write-Host "uv $version already satisfies >=$MinUvVersion; leaving it unchanged."
            return
        }
        Write-Host "uv $version does not satisfy stable >=$MinUvVersion; installing the current standalone uv."
    }
    else {
        Write-Host "uv is not installed; installing the current standalone uv."
    }

    Invoke-DownloadedPowerShellInstaller -Url $UvInstallUrl -Name "uv"
    Prioritize-PathEntry (Get-UvInstallBinDirectory)
    Confirm-Uv
}

function Get-LatestReleaseTag {
    # The releases feed lists published releases newest-first, but that order is by
    # publish date, so sort by [version] to keep v1.0.10 ahead of v1.0.9.
    $response = Invoke-WebRequest -Uri $RepoReleasesFeedUrl -UseBasicParsing
    [xml] $feed = $response.Content
    if ($null -eq $feed.DocumentElement) {
        throw "Could not read $RepoReleasesFeedUrl."
    }
    # SelectNodes rather than $feed.feed.entry: a feed with no entries has no
    # 'entry' property, and Set-StrictMode turns reading it into a terminating
    # error instead of the "no published release" message below.
    $entries = $feed.SelectNodes("/*[local-name()='feed']/*[local-name()='entry']")
    $versions = @()
    foreach ($entry in $entries) {
        $titleNode = $entry.SelectSingleNode("*[local-name()='title']")
        if ($null -eq $titleNode) {
            continue
        }
        if ($titleNode.InnerText -notmatch '^v(\d+\.\d+\.\d+)$') {
            continue
        }
        $versions += [version] $Matches[1]
    }
    if ($versions.Count -eq 0) {
        throw "No published release tag was found at $RepoReleasesFeedUrl."
    }
    return "v$(($versions | Sort-Object -Descending)[0])"
}

function Resolve-LatestRelease {
    Write-Step "Resolving the newest published release"
    $script:LuicodeReleaseTag = Get-LatestReleaseTag
    Write-Host "Newest published release: $script:LuicodeReleaseTag"
}

function Get-LuicodeVersion {
    $command = Get-ApplicationCommand -Name "luicode-server"
    if ($null -eq $command) {
        return ""
    }
    $output = Invoke-Utf8NativeCapture -FilePath $command.Source -Arguments @("--version")
    # `luicode-server --version` prints "luicode <version>". The shared
    # Convert-SemanticVersionOutput only understands the uv/node/dsh/hermes output
    # shapes, so match the version directly, as the shell installer does with awk.
    $match = [regex]::Match(($output -join "`n"), '\d+\.\d+\.\d+')
    if (-not $match.Success) {
        return ""
    }
    return $match.Value
}

function Stop-IfAlreadyOnLatestRelease {
    # luicode-server is only on PATH once the installer has set up its bin
    # directories, so a lookup failure just means "assume an upgrade is needed".
    $installed = Get-LuicodeVersion
    if ([string]::IsNullOrWhiteSpace($installed)) {
        return
    }
    $latest = $script:LuicodeReleaseTag.TrimStart('v')
    if ($installed -eq $latest) {
        Write-Host ""
        Write-Host "luicode is already on the newest release, $($script:LuicodeReleaseTag). Nothing to do."
        exit 0
    }
    Write-Host "Installed version: $installed"
}

function Get-ReleasePinFile {
    return (Join-Path (Join-Path $env:USERPROFILE ".luicode") ".release-pin")
}

function Write-WarningWhenReleasePinned {
    if (-not $LatestRelease) {
        $pinFile = Get-ReleasePinFile
        if (Test-Path -LiteralPath $pinFile) {
            $pinned = (Get-Content -LiteralPath $pinFile -Raw -ErrorAction SilentlyContinue)
            if (-not [string]::IsNullOrWhiteSpace($pinned)) {
                $pinned = $pinned.Trim()
                Write-Warning "This installation is pinned to release $pinned by luicode-upgrade."
                Write-Warning "This run installs from the main branch, so you will move back to main."
                Write-Warning 'Run "luicode-upgrade" instead to stay on a published release.'
            }
        }
    }
}

function Write-ReleasePin {
    if (-not $LatestRelease) {
        return
    }
    $configDir = Join-Path $env:USERPROFILE ".luicode"
    $pinFile = Get-ReleasePinFile
    if ($DryRun) {
        Write-Host "+ write $script:LuicodeReleaseTag -> $pinFile"
        return
    }
    if (-not (Test-Path -LiteralPath $configDir)) {
        New-Item -ItemType Directory -Path $configDir -Force | Out-Null
    }
    # WriteAllText rather than Set-Content -Encoding utf8NoBOM: the luicode-upgrade.cmd
    # shim runs Windows PowerShell 5.1, where that encoding name does not exist.
    [IO.File]::WriteAllText($pinFile, "$script:LuicodeReleaseTag`n")
    Write-Host "Recorded release pin $script:LuicodeReleaseTag in $pinFile"
}

function Get-PackageSpec {
    # NVIDIA NIM voice ships in the standard install, so only the local Whisper
    # extra is selectable. The spec points at a GitHub archive rather than PyPI so
    # the install works on platforms with no trusted-publishing support, including
    # Android/Termux. A release upgrade swaps the branch archive for a tag archive.
    $archiveUrl = $RepoArchiveUrl
    if ($LatestRelease) {
        $archiveUrl = "https://github.com/$RepoSlug/archive/refs/tags/$script:LuicodeReleaseTag.zip"
    }
    if ($VoiceLocal) {
        return "luicode[voice_local] @ $archiveUrl"
    }
    return "luicode @ $archiveUrl"
}

function Install-Luicode {
    Assert-NoLuicodeProcessesRunning
    $packageSpec = Get-PackageSpec
    $arguments = @(
        "tool",
        "install",
        "--force",
        "--refresh-package",
        "luicode",
        "--python",
        $PythonRequest
    )
    if (-not [string]::IsNullOrWhiteSpace($TorchBackend)) {
        $arguments += @("--torch-backend", $TorchBackend)
    }
    $arguments += $packageSpec

    $uvPath = "uv"
    if (-not $DryRun) {
        $uvCommand = Get-ApplicationCommand "uv"
        if (-not $uvCommand) {
            throw "uv is not available for the luicode installation."
        }
        $uvPath = $uvCommand.Source
    }
    Invoke-NativeCommand -FilePath $uvPath -Arguments $arguments
}

function Export-LuicodeDesktopIcon {
    param(
        [string] $DesktopCommand,
        [string] $IconPath
    )

    $arguments = @("--export-icon", $IconPath)
    $commandText = Format-Command -FilePath $DesktopCommand -Arguments $arguments
    Write-Host "+ $commandText"
    if ($DryRun) {
        return
    }

    # PowerShell does not wait when directly invoking a Windows GUI executable.
    $process = Start-Process `
        -FilePath $DesktopCommand `
        -ArgumentList @("--export-icon", ('"' + $IconPath + '"')) `
        -WindowStyle Hidden `
        -Wait `
        -PassThru
    try {
        $exitCode = $process.ExitCode
    }
    finally {
        $process.Dispose()
    }
    if ($exitCode -ne 0) {
        throw "Command failed with exit code ${exitCode}: $commandText"
    }
    if (-not (Test-Path -LiteralPath $IconPath -PathType Leaf)) {
        throw "luicode did not export its Windows app icon to '$IconPath'."
    }
}

function Configure-AndConfirmLuicode {
    $iconPath = Join-Path $env:USERPROFILE ".luicode\app-icon.ico"
    if ($DryRun) {
        Write-Host "+ uv tool update-shell"
        Write-Host "+ uv tool dir --bin"
        Write-Host "+ verify luicode-desktop, luicode-server, luicode-claude, luicode-codex, luicode-pi, luicode-opencode, luicode-cline, luicode-hermes, luicode-dsh, luicode-grok, luicode-muse, and luicode-aider in the uv tool bin directory"
        Write-Host "+ luicode-server --version"
        Export-LuicodeDesktopIcon `
            -DesktopCommand "<uv-tool-bin>\luicode-desktop.exe" `
            -IconPath $iconPath
        Install-LuicodeDesktopShortcuts `
            -DesktopCommand "<uv-tool-bin>\luicode-desktop.exe" `
            -IconPath $iconPath
        return
    }

    $uvCommand = Get-ApplicationCommand "uv"
    if (-not $uvCommand) {
        throw "uv is not available for PATH configuration."
    }
    Invoke-NativeCommand -FilePath $uvCommand.Source -Arguments @("tool", "update-shell")
    $toolBin = Add-UvToolBinDirectory -UvPath $uvCommand.Source
    $toolBinPath = ([IO.Path]::GetFullPath($toolBin)).TrimEnd(
        [IO.Path]::DirectorySeparatorChar,
        [IO.Path]::AltDirectorySeparatorChar
    )
    $installedCommands = @{}
    foreach ($commandName in @("luicode-desktop", "luicode-server", "luicode-claude", "luicode-codex", "luicode-pi", "luicode-opencode", "luicode-cline", "luicode-hermes", "luicode-dsh", "luicode-grok", "luicode-muse", "luicode-aider", "luicode-update.cmd")) {
        $command = Get-ApplicationCommand $commandName
        if (-not $command) {
            throw "luicode installation did not create '$commandName'."
        }
        $commandDirectory = ([IO.Path]::GetFullPath((Split-Path -Parent $command.Source))).TrimEnd(
            [IO.Path]::DirectorySeparatorChar,
            [IO.Path]::AltDirectorySeparatorChar
        )
        if (-not $commandDirectory.Equals($toolBinPath, [StringComparison]::OrdinalIgnoreCase)) {
            throw "'$commandName' resolved outside the uv tool bin directory: $($command.Source)"
        }
        $installedCommands[$commandName] = $command.Source
    }

    Invoke-NativeCommand -FilePath $installedCommands["luicode-server"] -Arguments @("--version")
    Export-LuicodeDesktopIcon `
        -DesktopCommand $installedCommands["luicode-desktop"] `
        -IconPath $iconPath
    Install-LuicodeDesktopShortcuts `
        -DesktopCommand $installedCommands["luicode-desktop"] `
        -IconPath $iconPath
}

function Test-EquivalentPath {
    param(
        [string] $Left,
        [string] $Right
    )

    if ([string]::IsNullOrWhiteSpace($Left) -or [string]::IsNullOrWhiteSpace($Right)) {
        return $false
    }
    try {
        return [string]::Equals(
            [IO.Path]::GetFullPath($Left),
            [IO.Path]::GetFullPath($Right),
            [StringComparison]::OrdinalIgnoreCase
        )
    }
    catch {
        return $false
    }
}

function Install-LuicodeDesktopShortcuts {
    param(
        [string] $DesktopCommand,
        [string] $IconPath
    )

    $shortcutPaths = @(
        (Join-Path $env:USERPROFILE "Desktop\luicode.lnk"),
        (Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\luicode.lnk")
    )
    foreach ($shortcutPath in $shortcutPaths) {
        Write-Host "+ create shortcut $(Format-Argument $shortcutPath) -> $(Format-Argument $DesktopCommand)"
    }
    if ($DryRun) {
        return
    }

    $shell = New-Object -ComObject WScript.Shell
    foreach ($shortcutPath in $shortcutPaths) {
        if (Test-Path -LiteralPath $shortcutPath) {
            try {
                $existingShortcut = $shell.CreateShortcut($shortcutPath)
                $isLuicodeShortcut = Test-EquivalentPath -Left $existingShortcut.TargetPath -Right $DesktopCommand
            }
            catch {
                $isLuicodeShortcut = $false
            }
            if (-not $isLuicodeShortcut) {
                Write-Host "A shortcut not managed by luicode already exists at $shortcutPath; leaving it unchanged."
                continue
            }
        }
        $parent = Split-Path -Parent $shortcutPath
        New-Item -ItemType Directory -Force -Path $parent | Out-Null
        $shortcut = $shell.CreateShortcut($shortcutPath)
        $shortcut.TargetPath = $DesktopCommand
        $shortcut.WorkingDirectory = $env:USERPROFILE
        $shortcut.IconLocation = "$IconPath,0"
        $shortcut.Description = "Run luicode in the background"
        $shortcut.Save()
    }
}

if ($Help) {
    Show-Usage
    return
}

if ($RemainingArgs.Count -gt 0) {
    Show-Usage
    throw "Unknown option: $($RemainingArgs -join ' ')"
}

if ((-not [string]::IsNullOrWhiteSpace($TorchBackend)) -and (-not $VoiceLocal)) {
    throw "-TorchBackend requires -VoiceLocal."
}

# Preserve the user's winning command before adding installer search paths.
$script:OriginalOpenCode = Get-ApplicationCommand "opencode"
Add-KnownBinDirectories

if ($LatestRelease) {
    Resolve-LatestRelease
    # After Add-KnownBinDirectories so the installed luicode-server answers.
    Stop-IfAlreadyOnLatestRelease
}
else {
    Write-WarningWhenReleasePinned
}

$script:InstallCline = [bool] ((Get-ApplicationCommand "cline") -or (Get-ApplicationCommand "npm"))
Write-Step "Checking for running luicode processes"
Assert-NoLuicodeProcessesRunning

if (-not (Test-InteractiveInstaller)) {
    $hasDsh = [bool] (Get-ApplicationCommand "dsh")
    $hasDryRunToolchain = [bool] (
        $DryRun -and
        (Get-ApplicationCommand "node") -and
        (Get-ApplicationCommand "npm")
    )
    $script:InstallDsh = $hasDsh -or $hasDryRunToolchain -or (Test-DshToolchain)
}

if (Test-InteractiveInstaller) {
    Write-Step "Choosing coding agents"
    Select-CodingAgents
}

Write-Step "Ensuring uv $MinUvVersion or newer is installed"
Ensure-Uv

Ensure-SelectedCodingAgents
Configure-RtkForSelectedAgents

Write-Step "Installing or updating luicode"
Install-Luicode

Write-Step "Configuring PATH and verifying luicode"
Configure-AndConfirmLuicode

# Recorded only after verification passed, so a failed upgrade leaves no pin.
Write-ReleasePin

Write-Host ""
if ($DryRun) {
    Write-Host "Dry run complete. No changes were made."
}
else {
    Write-Host "luicode is installed and verified. Open the luicode desktop shortcut to run it in the background."
    Write-Host "For terminal use, start the proxy with: luicode-server"
    if ($script:InstallClaudeCode) {
        Write-Host "Run Claude Code with: luicode-claude"
    }
    if ($script:InstallCodex) {
        Write-Host "Run Codex with: luicode-codex"
    }
    if ($script:PiAvailable) {
        Write-Host "Run Pi with: luicode-pi"
    }
    if ($script:InstallOpenCode) {
        Write-Host "Run OpenCode with: luicode-opencode"
    }
    if ($script:InstallCline) {
        Write-Host "Run Cline with: luicode-cline"
    }
    else {
        Write-Host "The luicode-cline wrapper is ready after you install Cline CLI."
    }
    if ($script:InstallHermes) {
        Write-Host "Run Hermes Agent with: luicode-hermes"
    }
    else {
        Write-Host "The luicode-hermes wrapper is ready after you install Hermes Agent."
    }
    if ($script:InstallDsh) {
        Write-Host "Run DeepSeek Harness with: luicode-dsh"
    }
    else {
        Write-Host "The luicode-dsh wrapper is ready after you install DeepSeek Harness $DshVersion."
    }
    if ($script:InstallGrok) {
        Write-Host "Run Grok Build with: luicode-grok"
    }
    else {
        Write-Host "The luicode-grok wrapper is ready after you install Grok Build."
    }
    if ($script:MuseAvailable) {
        Write-Host "Run Muse Code with: luicode-muse"
    }
    else {
        Write-Host "The luicode-muse wrapper is ready after you install Muse Code."
    }
    if ($script:InstallAider) {
        Write-Host "Run Aider with: luicode-aider"
    }
    else {
        Write-Host "The luicode-aider wrapper is ready after you install Aider."
    }
}
