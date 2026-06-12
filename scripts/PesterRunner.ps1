# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.
#
# PesterRunner.ps1
# ----------------
# Drives Pester from the vscode-powershell extension. The extension spawns this
# script in a separate `pwsh`/`powershell.exe` process and parses the JSON it
# emits on stdout to populate the VS Code Test Explorer (`TestController`).
#
# Portions of the JSON event protocol below are inspired by the `PesterInterface.ps1`
# script in https://github.com/pester/vscode-adapter (MIT, copyright Justin Grote),
# adapted and used here with the author's permission.
#
# Operations
# ----------
#   -Discover -Path <files...>
#       Discover tests without executing them. Emits one `{"type":"file",...}`
#       JSON line per test container, followed by `{"type":"end"}`.
#
#   -Run -Path <files...> [-LineNumber <n>] [-Coverage] [-CoveragePath <xml>]
#        [-CoverageSourcePath <files...>] [-OutputVerbosity <level>]
#       Run tests. Emits one `{"type":"result",...}` JSON line per test result,
#       followed by `{"type":"end"}`. When `-Coverage` is set, writes a JaCoCo
#       XML report to `-CoveragePath`.
#
# All structured output goes to **stdout** as one JSON document per line. Any
# non-JSON noise (Pester banner output, host writes, errors) goes to stderr.

[CmdletBinding(DefaultParameterSetName = 'Discover')]
param(
    [Parameter(Mandatory, ParameterSetName = 'Discover')]
    [switch]$Discover,

    [Parameter(Mandatory, ParameterSetName = 'Run')]
    [switch]$Run,

    [Parameter(Mandatory, ParameterSetName = 'Serve')]
    [switch]$Serve,

    [Parameter(Mandatory, ParameterSetName = 'Discover')]
    [Parameter(Mandatory, ParameterSetName = 'Run')]
    [string[]]$Path,

    [Parameter(ParameterSetName = 'Run')]
    [int[]]$LineNumber,

    [Parameter(ParameterSetName = 'Run')]
    [switch]$Coverage,

    [Parameter(ParameterSetName = 'Run')]
    [string]$CoveragePath,

    [Parameter(ParameterSetName = 'Run')]
    [string[]]$CoverageSourcePath,

    [Parameter(ParameterSetName = 'Run')]
    [ValidateSet('None', 'Minimal', 'Normal', 'Detailed', 'Diagnostic', 'FromPreference')]
    [string]$OutputVerbosity = 'Normal'
)

$ErrorActionPreference = 'Stop'

# Pester 5/6 uses $PSStyle in newer PowerShell hosts to render its progress
# output. Force ANSI rendering so the colour codes survive our stream capture
# and end up in VS Code's test-output panel exactly as a terminal would draw
# them. This is a no-op on Windows PowerShell 5.1 (where $PSStyle is missing).
if ($PSVersionTable.PSVersion -ge [version]'7.2.0' -and $null -ne $PSStyle) {
    $PSStyle.OutputRendering = 'ANSI'
}

function Write-JsonLine {
    param([Parameter(Mandatory)] $Payload)
    if ($null -ne $script:CurrentRequestId -and $Payload -is [System.Collections.IDictionary]) {
        # Tag every event with the active serve-mode request id so the TS
        # side can route output back to the right invocation. The legacy
        # single-shot CLI modes leave $script:CurrentRequestId unset, so
        # this is a no-op there.
        if (-not $Payload.Contains('requestId')) {
            $Payload['requestId'] = $script:CurrentRequestId
        }
    }
    # -Depth 8 covers Describe > Context > Context > It with extra room.
    $json = $Payload | ConvertTo-Json -Depth 8 -Compress
    [Console]::Out.WriteLine($json)
}

# Convert a ConsoleColor to an ANSI SGR escape sequence so VS Code's test-output
# panel can render Pester's coloured Write-Host calls. Returns an empty string
# for unknown colours so callers can safely concatenate.
$script:AnsiColorByName = @{
    'Black'       = 30
    'DarkBlue'    = 34
    'DarkGreen'   = 32
    'DarkCyan'    = 36
    'DarkRed'     = 31
    'DarkMagenta' = 35
    'DarkYellow'  = 33
    'Gray'        = 37
    'DarkGray'    = 90
    'Blue'        = 94
    'Green'       = 92
    'Cyan'        = 96
    'Red'         = 91
    'Magenta'     = 95
    'Yellow'      = 93
    'White'       = 97
}

function ConvertTo-AnsiText {
    param(
        [string]$Text,
        [Nullable[System.ConsoleColor]]$Foreground
    )
    if ([string]::IsNullOrEmpty($Text)) { return $Text }
    if (-not $Foreground.HasValue) { return $Text }
    $code = $script:AnsiColorByName[$Foreground.Value.ToString()]
    if (-not $code) { return $Text }
    return [string]([char]27) + "[${code}m" + $Text + [string]([char]27) + "[0m"
}

# Convert one element of the redirected pipeline into a chunk of test output.
# Returns $null when there's nothing worth surfacing so the caller can skip.
function ConvertTo-OutputText {
    param($Item)

    if ($null -eq $Item) { return $null }

    if ($Item -is [System.Management.Automation.InformationRecord]) {
        $data = $Item.MessageData
        if ($data -is [System.Management.Automation.HostInformationMessage]) {
            $line = ConvertTo-AnsiText -Text ([string]$data.Message) -Foreground $data.ForegroundColor
            if (-not $data.NoNewline) { $line += "`r`n" }
            return $line
        }
        return [string]$data + "`r`n"
    }

    if ($Item -is [System.Management.Automation.ErrorRecord]) {
        return (ConvertTo-AnsiText -Text ([string]$Item) -Foreground ([System.ConsoleColor]::Red)) + "`r`n"
    }
    if ($Item -is [System.Management.Automation.WarningRecord]) {
        return (ConvertTo-AnsiText -Text ("WARNING: $($Item.Message)") -Foreground ([System.ConsoleColor]::Yellow)) + "`r`n"
    }
    if ($Item -is [System.Management.Automation.VerboseRecord]) {
        return "VERBOSE: $($Item.Message)`r`n"
    }
    if ($Item -is [System.Management.Automation.DebugRecord]) {
        return "DEBUG: $($Item.Message)`r`n"
    }

    if ($Item -is [string]) { return $Item + "`r`n" }

    # Fallback: format the object the way the default host would.
    $text = $Item | Out-String -Width 200
    return $text.TrimEnd("`r","`n") + "`r`n"
}

function Get-CompatiblePester {
    $candidate = Get-Module Pester -ListAvailable |
        Where-Object { $_.Version -ge [version]'5.0.0' } |
        Sort-Object Version -Descending |
        Select-Object -First 1
    if (-not $candidate) {
        Write-JsonLine @{
            type    = 'error'
            message = 'Pester 5.0.0 or newer is required. Install with: Install-Module Pester -MinimumVersion 5.0.0 -Scope CurrentUser -Force'
        }
        exit 2
    }
    Import-Module -ModuleInfo $candidate -Force
    return $candidate
}

function Get-TestId {
    param(
        [Parameter(Mandatory)][string]$File,
        [Parameter(Mandatory)][string[]]$Chain
    )
    # Stable identifier: <absolute file path>::<chain joined by ' > '>.
    # The chain mirrors Pester's `ExpandedPath`/`Path` view of a test.
    return "${File}::" + ($Chain -join ' > ')
}

# Pester normalises `$container.Item.FullName` (e.g. drive-letter casing on
# Windows) which can drift from the path the caller passed in. The TS side
# keys items by `vscode.Uri.fsPath`, so any drift breaks the round-trip of
# discovery and result events. Map the container's path back to the matching
# input path whenever possible so emitted ids round-trip exactly.
function Resolve-OriginalPath {
    param(
        [Parameter(Mandatory)][string]$ContainerPath,
        [string[]]$InputPaths
    )
    if (-not $InputPaths) {
        return $ContainerPath
    }
    foreach ($candidate in $InputPaths) {
        if ([string]::Equals(
                [System.IO.Path]::GetFullPath($candidate),
                [System.IO.Path]::GetFullPath($ContainerPath),
                [System.StringComparison]::OrdinalIgnoreCase)) {
            return $candidate
        }
    }
    return $ContainerPath
}

# Resolve `<placeholder>` tokens in a Pester test name against its `Data`
# hashtable. Mirrors what Pester does for ExpandedName *after* a test
# actually executes — but ExpandedName is empty during -SkipRun discovery,
# which leaves every ForEach iteration sharing a single template name and
# colliding on id. Doing the expansion ourselves at discovery time gives
# each iteration a stable, unique id that round-trips with the run-time
# result events (where Pester's own ExpandedName is set).
function Expand-PesterName {
    param(
        [string]$Template,
        $Data
    )
    if ([string]::IsNullOrEmpty($Template)) { return $Template }
    if ($Template.IndexOf('<') -lt 0) { return $Template }
    if ($null -eq $Data) { return $Template }

    $result = $Template
    if ($Data -is [System.Collections.IDictionary]) {
        foreach ($key in $Data.Keys) {
            $value = $Data[$key]
            $token = '<' + [string]$key + '>'
            $result = $result.Replace($token, [string]$value)
        }
        if ($Data.Count -eq 1) {
            $only = @($Data.Values)[0]
            $result = $result.Replace('<_>', [string]$only)
        }
    }
    else {
        # Pester also accepts a single non-hashtable value (e.g.
        # `-ForEach @(1, 2, 3)`); the implicit token is `<_>`.
        $result = $result.Replace('<_>', [string]$Data)
    }
    return $result
}

# Prefer Pester's own ExpandedName when populated (always true post-run),
# otherwise expand the template ourselves so discovery and run agree on
# the per-iteration name even before tests have executed.
function Get-DisplayName {
    param($Item)
    if ($Item.PSObject.Properties['ExpandedName'] -and
        $Item.ExpandedName -and
        $Item.ExpandedName -ne $Item.Name) {
        return [string]$Item.ExpandedName
    }
    $data = if ($Item.PSObject.Properties['Data']) { $Item.Data } else { $null }
    return Expand-PesterName -Template ([string]$Item.Name) -Data $data
}

function Get-BlockChildren {
    param(
        [Parameter(Mandatory)] $Block,
        [Parameter(Mandatory)][string]$File,
        [Parameter(Mandatory)][AllowEmptyCollection()][string[]]$Parents
    )

    $children = @()
    $ownChain = $Parents + @($Block.Name)

    foreach ($child in $Block.Blocks) {
        $children += [pscustomobject]@{
            id       = Get-TestId -File $File -Chain ($ownChain + @($child.Name))
            label    = $child.Name
            kind     = 'block'
            file     = $File
            line     = [int]$child.StartLine
            children = Get-BlockChildren -Block $child -File $File -Parents $ownChain
        }
    }

    foreach ($it in $Block.Tests) {
        $name = Get-DisplayName -Item $it
        $children += [pscustomobject]@{
            id       = Get-TestId -File $File -Chain ($ownChain + @($name))
            label    = $name
            kind     = 'test'
            file     = $File
            line     = [int]$it.StartLine
            children = @()
        }
    }

    return ,$children
}

function Emit-Discovery {
    param($PesterResult, [string[]]$InputPaths)
    foreach ($container in $PesterResult.Containers) {
        $file = Resolve-OriginalPath -ContainerPath $container.Item.FullName -InputPaths $InputPaths
        $tree = @()
        foreach ($block in $container.Blocks) {
            $tree += [pscustomobject]@{
                id       = Get-TestId -File $file -Chain @($block.Name)
                label    = $block.Name
                kind     = 'block'
                file     = $file
                line     = [int]$block.StartLine
                children = Get-BlockChildren -Block $block -File $file -Parents @()
            }
        }
        Write-JsonLine @{ type = 'file'; file = $file; tests = $tree }
    }
}

function Emit-ResultsForBlock {
    param(
        [Parameter(Mandatory)] $Block,
        [Parameter(Mandatory)][string]$File,
        [Parameter(Mandatory)][AllowEmptyCollection()][string[]]$Parents
    )

    $ownChain = $Parents + @($Block.Name)

    foreach ($it in $Block.Tests) {
        $status = switch ($it.Result) {
            'Passed'        { 'passed' }
            'Failed'        { 'failed' }
            'Skipped'       { 'skipped' }
            'NotRun'        { 'skipped' }
            'Inconclusive'  { 'skipped' }
            default         { 'errored' }
        }

        # Use ExpandedName when Pester supplies one (always for -ForEach
        # / -TestCases tests post-run); fall back to expanding the template
        # ourselves so iteration ids agree between discovery and run.
        $itName = Get-DisplayName -Item $it

        $payload = [ordered]@{
            type       = 'result'
            id         = Get-TestId -File $File -Chain ($ownChain + @($itName))
            status     = $status
            durationMs = [double]$it.Duration.TotalMilliseconds
        }

        if ($status -eq 'failed' -and $it.ErrorRecord) {
            $errs = @()
            foreach ($err in $it.ErrorRecord) {
                $errs += [ordered]@{
                    message = "$($err.Exception.Message)"
                    stack   = "$($err.ScriptStackTrace)"
                }
            }
            $payload.errors = $errs
        }

        Write-JsonLine $payload
    }

    foreach ($child in $Block.Blocks) {
        Emit-ResultsForBlock -Block $child -File $File -Parents $ownChain
    }
}

function Emit-RunResults {
    param($PesterResult, [string[]]$InputPaths)
    foreach ($container in $PesterResult.Containers) {
        $file = Resolve-OriginalPath -ContainerPath $container.Item.FullName -InputPaths $InputPaths
        foreach ($block in $container.Blocks) {
            Emit-ResultsForBlock -Block $block -File $file -Parents @()
        }
    }
}

function Invoke-RunnerDiscover {
    param(
        [Parameter(Mandatory)][string[]]$InputPaths
    )
    $cfg = New-PesterConfiguration
    $cfg.Run.Path = $InputPaths
    $cfg.Run.PassThru = $true
    $cfg.Run.SkipRun = $true
    # Discovery never needs host output — silence Pester to keep stdout pure
    # JSON. Any unexpected stream traffic still gets folded into `output`
    # events so it shows in VS Code's logs instead of corrupting the protocol.
    $cfg.Output.Verbosity = 'None'

    $script:__discoverResult = $null
    Invoke-Pester -Configuration $cfg *>&1 6>&1 2>&1 | ForEach-Object {
        if ($null -ne $_ -and $_.PSObject.Properties['Containers'] -and -not ($_ -is [System.Management.Automation.InformationRecord]) -and -not ($_ -is [System.Management.Automation.ErrorRecord])) {
            $script:__discoverResult = $_
            return
        }
        $text = ConvertTo-OutputText -Item $_
        if ($text) {
            Write-JsonLine @{ type = 'output'; text = $text }
        }
    }
    if ($null -ne $script:__discoverResult) {
        Emit-Discovery -PesterResult $script:__discoverResult -InputPaths $InputPaths
    }
}

function Invoke-RunnerRun {
    param(
        [Parameter(Mandatory)][string[]]$InputPaths,
        [int[]]$LineNumber,
        [switch]$Coverage,
        [string]$CoveragePath,
        [string[]]$CoverageSourcePath,
        [string]$OutputVerbosity = 'Normal'
    )

    $cfg = New-PesterConfiguration
    $cfg.Run.Path = $InputPaths
    $cfg.Run.PassThru = $true
    $cfg.Output.Verbosity = $OutputVerbosity

    if ($LineNumber -and $LineNumber.Count -gt 0) {
        $filterLines = foreach ($p in $InputPaths) {
            foreach ($ln in $LineNumber) {
                if ($ln -gt 0) { "${p}:${ln}" }
            }
        }
        $cfg.Filter.Line = $filterLines
    }

    if ($Coverage) {
        if (-not $CoveragePath) {
            Write-JsonLine @{ type = 'error'; message = '-Coverage requires -CoveragePath.' }
            return
        }
        $cfg.CodeCoverage.Enabled = $true
        # Pester 5.x supports both 'JaCoCo' and 'CoverageGutters'. They use the same
        # element shape but disagree on how they split paths between <package> and
        # <sourcefile>; the TS-side parser handles both via suffix matching, so the
        # only thing that matters here is picking a format that exists in the version
        # of Pester we found:
        #   * Pester 5.x ships 'CoverageGutters' (kept here for backwards compat).
        #   * Pester 6.x dropped 'CoverageGutters' and only ships 'JaCoCo'.
        $cfg.CodeCoverage.OutputFormat = if ($script:PesterModule.Version.Major -ge 6) { 'JaCoCo' } else { 'CoverageGutters' }
        $cfg.CodeCoverage.OutputPath = $CoveragePath
        if ($CoverageSourcePath) {
            $cfg.CodeCoverage.Path = $CoverageSourcePath
        }
    }

    $script:__runResult = $null
    $script:__hadRunObject = $false
    Invoke-Pester -Configuration $cfg *>&1 6>&1 2>&1 | ForEach-Object {
        if ($null -ne $_ -and $_.PSObject.Properties['Containers'] -and -not ($_ -is [System.Management.Automation.InformationRecord]) -and -not ($_ -is [System.Management.Automation.ErrorRecord])) {
            $script:__runResult = $_
            $script:__hadRunObject = $true
            return
        }
        $text = ConvertTo-OutputText -Item $_
        if ($text) {
            Write-JsonLine @{ type = 'output'; text = $text }
        }
    }
    if (-not $script:__hadRunObject) {
        Write-JsonLine @{ type = 'error'; message = 'Pester did not return a Run object (PassThru). Cannot emit results.' }
        return
    }
    Emit-RunResults -PesterResult $script:__runResult -InputPaths $InputPaths
}

# Main ------------------------------------------------------------------------

$script:PesterModule = Get-CompatiblePester
$script:CurrentRequestId = $null

Write-JsonLine @{
    type    = 'start'
    pester  = "$($script:PesterModule.Version)"
    op      = $PSCmdlet.ParameterSetName
}

if ($Discover) {
    Invoke-RunnerDiscover -InputPaths $Path
    Write-JsonLine @{ type = 'end' }
}
elseif ($Run) {
    Invoke-RunnerRun `
        -InputPaths $Path `
        -LineNumber $LineNumber `
        -Coverage:$Coverage `
        -CoveragePath $CoveragePath `
        -CoverageSourcePath $CoverageSourcePath `
        -OutputVerbosity $OutputVerbosity
    Write-JsonLine @{ type = 'end' }
}
elseif ($Serve) {
    # Persistent worker. The TS extension keeps this process alive and sends
    # one JSON command per line on stdin; every event we emit is tagged with
    # the command's `requestId` so the extension can route it back to the
    # right invocation. Avoiding pwsh startup + Pester module load on every
    # run is the single biggest speedup vs. one-shot mode.
    Write-JsonLine @{ type = 'ready' }
    $script:__keepServing = $true
    while ($script:__keepServing) {
        $line = [Console]::In.ReadLine()
        if ($null -eq $line) {
            break
        }
        $line = $line.Trim()
        if ([string]::IsNullOrEmpty($line)) {
            continue
        }

        $cmd = $null
        try {
            $cmd = $line | ConvertFrom-Json
        }
        catch {
            [Console]::Error.WriteLine("Ignoring non-JSON serve command: $line")
            continue
        }

        $script:CurrentRequestId = if ($cmd.PSObject.Properties['requestId']) { [string]$cmd.requestId } else { $null }
        $op = [string]$cmd.op
        try {
            switch ($op) {
                'discover' {
                    $paths = @($cmd.path)
                    Invoke-RunnerDiscover -InputPaths $paths
                }
                'run' {
                    $paths = @($cmd.path)
                    $lines = if ($cmd.PSObject.Properties['lineNumber'] -and $cmd.lineNumber) { @($cmd.lineNumber | ForEach-Object { [int]$_ }) } else { @() }
                    $cov = [bool]($cmd.PSObject.Properties['coverage'] -and $cmd.coverage)
                    $covPath = if ($cmd.PSObject.Properties['coveragePath']) { [string]$cmd.coveragePath } else { '' }
                    $covSrc = if ($cmd.PSObject.Properties['coverageSourcePath'] -and $cmd.coverageSourcePath) { @($cmd.coverageSourcePath | ForEach-Object { [string]$_ }) } else { @() }
                    $verb = if ($cmd.PSObject.Properties['outputVerbosity'] -and $cmd.outputVerbosity) { [string]$cmd.outputVerbosity } else { 'Normal' }
                    Invoke-RunnerRun `
                        -InputPaths $paths `
                        -LineNumber $lines `
                        -Coverage:$cov `
                        -CoveragePath $covPath `
                        -CoverageSourcePath $covSrc `
                        -OutputVerbosity $verb
                }
                'shutdown' {
                    $script:__keepServing = $false
                }
                default {
                    Write-JsonLine @{ type = 'error'; message = "Unknown serve op: $op" }
                }
            }
        }
        catch {
            Write-JsonLine @{ type = 'error'; message = "$($_.Exception.Message)" }
        }
        Write-JsonLine @{ type = 'end' }
        $script:CurrentRequestId = $null
    }
}
