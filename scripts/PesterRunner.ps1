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

    [Parameter(Mandatory)]
    [string[]]$Path,

    [Parameter(ParameterSetName = 'Run')]
    [int]$LineNumber,

    [Parameter(ParameterSetName = 'Run')]
    [switch]$Coverage,

    [Parameter(ParameterSetName = 'Run')]
    [string]$CoveragePath,

    [Parameter(ParameterSetName = 'Run')]
    [string[]]$CoverageSourcePath,

    [Parameter(ParameterSetName = 'Run')]
    [ValidateSet('None', 'Minimal', 'Normal', 'Detailed', 'Diagnostic', 'FromPreference')]
    [string]$OutputVerbosity = 'None'
)

$ErrorActionPreference = 'Stop'

function Write-JsonLine {
    param([Parameter(Mandatory)] $Payload)
    # -Depth 8 covers Describe > Context > Context > It with extra room.
    $json = $Payload | ConvertTo-Json -Depth 8 -Compress
    [Console]::Out.WriteLine($json)
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
        $children += [pscustomobject]@{
            id       = Get-TestId -File $File -Chain ($ownChain + @($it.Name))
            label    = $it.Name
            kind     = 'test'
            file     = $File
            line     = [int]$it.StartLine
            children = @()
        }
    }

    return ,$children
}

function Emit-Discovery {
    param($PesterResult)
    foreach ($container in $PesterResult.Containers) {
        $file = $container.Item.FullName
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

        $payload = [ordered]@{
            type       = 'result'
            id         = Get-TestId -File $File -Chain ($ownChain + @($it.Name))
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
    param($PesterResult)
    foreach ($container in $PesterResult.Containers) {
        $file = $container.Item.FullName
        foreach ($block in $container.Blocks) {
            Emit-ResultsForBlock -Block $block -File $file -Parents @()
        }
    }
}

# Main ------------------------------------------------------------------------

$pester = Get-CompatiblePester
Write-JsonLine @{
    type    = 'start'
    pester  = "$($pester.Version)"
    op      = $PSCmdlet.ParameterSetName
}

$cfg = New-PesterConfiguration
$cfg.Run.Path = $Path
$cfg.Run.PassThru = $true
$cfg.Output.Verbosity = $OutputVerbosity

if ($Discover) {
    $cfg.Run.SkipRun = $true
    $result = Invoke-Pester -Configuration $cfg
    Emit-Discovery -PesterResult $result
}
else {
    if ($PSBoundParameters.ContainsKey('LineNumber') -and $LineNumber -gt 0) {
        $filterLines = foreach ($p in $Path) { "${p}:${LineNumber}" }
        $cfg.Filter.Line = $filterLines
    }

    if ($Coverage) {
        if (-not $CoveragePath) {
            Write-JsonLine @{ type = 'error'; message = '-Coverage requires -CoveragePath.' }
            exit 2
        }
        $cfg.CodeCoverage.Enabled = $true
        # Pester 5.x supports both 'JaCoCo' and 'CoverageGutters'. They use the same
        # element shape but disagree on how they split paths between <package> and
        # <sourcefile>; the TS-side parser handles both via suffix matching, so the
        # only thing that matters here is picking a format that exists in the version
        # of Pester we found:
        #   * Pester 5.x ships 'CoverageGutters' (kept here for backwards compat).
        #   * Pester 6.x dropped 'CoverageGutters' and only ships 'JaCoCo'.
        $cfg.CodeCoverage.OutputFormat = if ($pester.Version.Major -ge 6) { 'JaCoCo' } else { 'CoverageGutters' }
        $cfg.CodeCoverage.OutputPath = $CoveragePath
        if ($CoverageSourcePath) {
            $cfg.CodeCoverage.Path = $CoverageSourcePath
        }
    }

    $result = Invoke-Pester -Configuration $cfg
    Emit-RunResults -PesterResult $result
}

Write-JsonLine @{ type = 'end' }
