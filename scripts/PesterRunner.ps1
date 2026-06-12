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
    [string]$OutputVerbosity = 'Normal',

    [Parameter(ParameterSetName = 'Discover')]
    [Parameter(ParameterSetName = 'Run')]
    [Parameter(ParameterSetName = 'Serve')]
    [string]$PesterModulePath,

    [Parameter(ParameterSetName = 'Discover')]
    [Parameter(ParameterSetName = 'Run')]
    [Parameter(ParameterSetName = 'Serve')]
    [string]$WorkingDirectory,

    [Parameter(ParameterSetName = 'Discover')]
    [Parameter(ParameterSetName = 'Run')]
    [string]$ConfigurationPath
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
    param(
        [string]$ModulePath
    )
    if ($ModulePath) {
        if (-not (Test-Path -LiteralPath $ModulePath)) {
            Write-JsonLine @{
                type    = 'error'
                message = "PesterModulePath '$ModulePath' does not exist."
            }
            exit 2
        }
        # Accept either a folder, a .psd1 manifest, or a .psm1 root module.
        Import-Module -Name $ModulePath -Force
        $candidate = Get-Module Pester | Sort-Object Version -Descending | Select-Object -First 1
        if (-not $candidate -or $candidate.Version -lt [version]'5.0.0') {
            Write-JsonLine @{
                type    = 'error'
                message = "Pester 5.0.0 or newer is required (got '$($candidate.Version)' from '$ModulePath')."
            }
            exit 2
        }
        return $candidate
    }
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

function Get-BaseConfiguration {
    param(
        [string]$ConfigurationPath
    )
    # Honour a user-supplied .psd1 Pester configuration: load it, then layer
    # the per-call overrides (paths, line numbers, coverage, verbosity) on
    # top in the caller. Matches the behaviour of pester/vscode-adapter.
    if (-not $ConfigurationPath) {
        return New-PesterConfiguration
    }
    if (-not (Test-Path -LiteralPath $ConfigurationPath)) {
        Write-JsonLine @{
            type    = 'error'
            message = "ConfigurationPath '$ConfigurationPath' does not exist."
        }
        exit 2
    }
    try {
        $data = Import-PowerShellDataFile -Path $ConfigurationPath
    } catch {
        Write-JsonLine @{
            type    = 'error'
            message = "Failed to load ConfigurationPath '$ConfigurationPath': $($_.Exception.Message)"
        }
        exit 2
    }
    return New-PesterConfiguration -Hashtable $data
}

function Get-TestId {
    param(
        [Parameter(Mandatory)][string]$File,
        [Parameter(Mandatory)][AllowEmptyCollection()][string[]]$Path,
        $Data
    )
    # Stable, ForEach-safe identifier matching the TS side and the original
    # pester/vscode-adapter scheme:
    #     <file>>>BlockName>>BlockName>>TestName[>>Key=Value...]
    # The name segments are the UNEXPANDED Pester names (e.g. `greets <Name>`),
    # not the expanded per-iteration label. The data suffix is a sorted list
    # of `Key=Value` from the test's merged Data hashtable so each ForEach
    # iteration gets a unique id without our having to expand placeholders.
    foreach ($segment in $Path) {
        if ([string]$segment -match '>>') {
            throw "Pester test names cannot contain '>>' (the test id separator). Offending name: '$segment' in chain '$($Path -join ' > ')'."
        }
    }
    $segments = New-Object System.Collections.Generic.List[string]
    $segments.Add($File) | Out-Null
    foreach ($segment in $Path) {
        $segments.Add([string]$segment) | Out-Null
    }
    if ($Data -is [System.Collections.IDictionary] -and $Data.Count -gt 0) {
        $sortedKeys = @($Data.Keys | Sort-Object { [string]$_ })
        foreach ($key in $sortedKeys) {
            $segments.Add("$key=$($Data[$key])") | Out-Null
        }
    }
    return ($segments -join '>>')
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
# actually executes. We only use the expanded form for the human-readable
# LABEL (Test Explorer column); test ids are always built from the
# unexpanded name + sorted data items so discovery and run agree without
# any reconciliation step.
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

# Walk a Pester Test/Block's ancestor chain and merge every `Data` hashtable
# along the way, with deeper-nested values overriding shallower ones — the
# same behaviour as pester/vscode-adapter's Merge-TestData. This makes the
# id stable when `-ForEach` is declared on a Describe/Context block rather
# than on the innermost `It`.
function Get-MergedData {
    param($Item)
    if ($null -eq $Item) { return $null }

    $chain = @()
    $current = $Item
    while ($null -ne $current) {
        $chain = @($current) + $chain
        $current = if ($current.PSObject.Properties['Parent']) { $current.Parent } else { $null }
    }

    $merged = [ordered]@{}
    foreach ($node in $chain) {
        $data = if ($node.PSObject.Properties['Data']) { $node.Data } else { $null }
        if ($null -eq $data) { continue }
        if ($data -is [System.Collections.IDictionary]) {
            foreach ($key in $data.Keys) {
                $merged[[string]$key] = $data[$key]
            }
        }
        else {
            # Non-dictionary `-ForEach` value lives under Pester's implicit
            # `_` key.
            $merged['_'] = $data
        }
    }
    return $merged
}

# Pester `Should -Be 'X'` failures use the message form
# `Expected 'X', but got 'Y'.`. Extract the two halves so the TS side can
# render a real TestMessage.diff() instead of a plain string. Mirrors the
# same regex used by pester/vscode-adapter.
$script:ExpectedActualRegex = [regex]::new(
    'Expected (?<expected>.+?), but (got )?(?<actual>.+?)\.\s*$',
    [System.Text.RegularExpressions.RegexOptions]::Singleline
)

function Get-ExpectedActual {
    param($ErrorRecord)
    if ($null -eq $ErrorRecord) { return $null }
    $message = [string]$ErrorRecord
    if ([string]::IsNullOrEmpty($message)) { return $null }
    $m = $script:ExpectedActualRegex.Match($message)
    if (-not $m.Success) { return $null }
    return [ordered]@{
        expected = $m.Groups['expected'].Value
        actual   = $m.Groups['actual'].Value
    }
}

# Collect Pester `-Tag` values into a clean string[] for emission. Both
# Block.Tag and Test.Tag may be `$null`, a single string, or a string[].
function Get-PesterTags {
    param($Item)
    if ($null -eq $Item) { return @() }
    if (-not $Item.PSObject.Properties['Tag']) { return @() }
    $raw = $Item.Tag
    if ($null -eq $raw) { return @() }
    $tags = @()
    foreach ($t in @($raw)) {
        if ($null -ne $t -and -not [string]::IsNullOrWhiteSpace([string]$t)) {
            $tags += [string]$t
        }
    }
    return ,$tags
}

# Prefer Pester's own ExpandedName when populated (always true post-run),
# otherwise expand the template ourselves so iteration LABELS match the
# Pester output. This is purely for display; ids never use the expanded
# name.
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
        [Parameter(Mandatory)][string]$File
    )

    $children = @()

    foreach ($child in $Block.Blocks) {
        $children += [pscustomobject]@{
            id       = Get-TestId -File $File -Path $child.Path -Data (Get-MergedData -Item $child)
            label    = Get-DisplayName -Item $child
            kind     = 'block'
            file     = $File
            line     = [int]$child.StartLine
            tags     = Get-PesterTags -Item $child
            children = Get-BlockChildren -Block $child -File $File
        }
    }

    foreach ($it in $Block.Tests) {
        $children += [pscustomobject]@{
            id       = Get-TestId -File $File -Path $it.Path -Data (Get-MergedData -Item $it)
            label    = Get-DisplayName -Item $it
            kind     = 'test'
            file     = $File
            line     = [int]$it.StartLine
            tags     = Get-PesterTags -Item $it
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
                id       = Get-TestId -File $file -Path $block.Path -Data (Get-MergedData -Item $block)
                label    = Get-DisplayName -Item $block
                kind     = 'block'
                file     = $file
                line     = [int]$block.StartLine
                tags     = Get-PesterTags -Item $block
                children = Get-BlockChildren -Block $block -File $file
            }
        }
        Write-JsonLine @{ type = 'file'; file = $file; tests = $tree }
    }
}

function Emit-ResultsForBlock {
    param(
        [Parameter(Mandatory)] $Block,
        [Parameter(Mandatory)][string]$File
    )

    foreach ($it in $Block.Tests) {
        $status = switch ($it.Result) {
            'Passed'        { 'passed' }
            'Failed'        { 'failed' }
            'Skipped'       { 'skipped' }
            'NotRun'        { 'skipped' }
            'Inconclusive'  { 'skipped' }
            default         { 'errored' }
        }

        $payload = [ordered]@{
            type       = 'result'
            id         = Get-TestId -File $File -Path $it.Path -Data (Get-MergedData -Item $it)
            status     = $status
            durationMs = [double]$it.Duration.TotalMilliseconds
        }

        if ($status -eq 'failed' -and $it.ErrorRecord) {
            $errs = @()
            foreach ($err in $it.ErrorRecord) {
                $entry = [ordered]@{
                    message = "$($err.Exception.Message)"
                    stack   = "$($err.ScriptStackTrace)"
                }
                $diff = Get-ExpectedActual -ErrorRecord $err
                if ($diff) {
                    $entry.expected = $diff.expected
                    $entry.actual   = $diff.actual
                }
                $errs += $entry
            }
            $payload.errors = $errs
        }

        if ($status -eq 'skipped') {
            # Pester 5 records the `-Because` reason on ErrorRecord even
            # for skipped tests (Set-ItResult -Skipped -Because '...'),
            # and falls back to FailureMessage / StandardOutput for older
            # APIs. Surface whichever is non-empty so the TS controller
            # can decide whether to display it.
            $skipMsg = $null
            if ($it.ErrorRecord -and $it.ErrorRecord.Count -gt 0) {
                $skipMsg = "$($it.ErrorRecord[0].Exception.Message)"
            }
            if (-not $skipMsg -and $it.PSObject.Properties['FailureMessage'] -and $it.FailureMessage) {
                $skipMsg = [string]$it.FailureMessage
            }
            if ($skipMsg) {
                $payload.skipMessage = $skipMsg
            }
        }

        Write-JsonLine $payload
    }

    foreach ($child in $Block.Blocks) {
        Emit-ResultsForBlock -Block $child -File $File
    }
}

function Emit-RunResults {
    param($PesterResult, [string[]]$InputPaths)
    foreach ($container in $PesterResult.Containers) {
        $file = Resolve-OriginalPath -ContainerPath $container.Item.FullName -InputPaths $InputPaths
        foreach ($block in $container.Blocks) {
            Emit-ResultsForBlock -Block $block -File $file
        }
    }
}

function Invoke-RunnerDiscover {
    param(
        [Parameter(Mandatory)][string[]]$InputPaths,
        [string]$ConfigurationPath
    )
    $cfg = Get-BaseConfiguration -ConfigurationPath $ConfigurationPath
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
        [string]$OutputVerbosity = 'Normal',
        [string]$ConfigurationPath
    )

    $cfg = Get-BaseConfiguration -ConfigurationPath $ConfigurationPath
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

$script:PesterModule = Get-CompatiblePester -ModulePath $PesterModulePath
$script:CurrentRequestId = $null

if ($WorkingDirectory) {
    if (-not (Test-Path -LiteralPath $WorkingDirectory)) {
        Write-JsonLine @{
            type    = 'error'
            message = "WorkingDirectory '$WorkingDirectory' does not exist."
        }
        exit 2
    }
    Set-Location -LiteralPath $WorkingDirectory
}

Write-JsonLine @{
    type    = 'start'
    pester  = "$($script:PesterModule.Version)"
    op      = $PSCmdlet.ParameterSetName
}

if ($Discover) {
    Invoke-RunnerDiscover -InputPaths $Path -ConfigurationPath $ConfigurationPath
    Write-JsonLine @{ type = 'end' }
}
elseif ($Run) {
    Invoke-RunnerRun `
        -InputPaths $Path `
        -LineNumber $LineNumber `
        -Coverage:$Coverage `
        -CoveragePath $CoveragePath `
        -CoverageSourcePath $CoverageSourcePath `
        -OutputVerbosity $OutputVerbosity `
        -ConfigurationPath $ConfigurationPath
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
            # Per-call working directory: cheaper than restarting the worker.
            # We rely on Pester resolving test paths from the cwd, so honour
            # the setting on every command rather than once at startup.
            if ($cmd.PSObject.Properties['workingDirectory'] -and $cmd.workingDirectory) {
                $wd = [string]$cmd.workingDirectory
                if (Test-Path -LiteralPath $wd) {
                    Set-Location -LiteralPath $wd
                } else {
                    Write-JsonLine @{ type = 'error'; message = "workingDirectory '$wd' does not exist." }
                }
            }
            $cfgPath = if ($cmd.PSObject.Properties['configurationPath']) { [string]$cmd.configurationPath } else { '' }
            switch ($op) {
                'discover' {
                    $paths = @($cmd.path)
                    Invoke-RunnerDiscover -InputPaths $paths -ConfigurationPath $cfgPath
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
                        -OutputVerbosity $verb `
                        -ConfigurationPath $cfgPath
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
