# Pester.BeforeContainer.ps1
#
# Drop this at the repository root (Run.RepoRoot, i.e. next to the .git dir -
# q:\p\pester\Pester.BeforeContainer.ps1). Pester (with the BeforeContainer
# feature) dot-sources it into the run session state BEFORE each test container
# is discovered and run, in both sequential and parallel runs.
#
# It reproduces the two helper sets that test.ps1 sets up for the parent session,
# so a single .Tests.ps1 file discovered/run in isolation - e.g. from the VS Code
# Test Explorer - sees the same helpers as a full ./test.ps1 run:
#   1. Axiom       - the Verify-* assertion helpers (tst/axiom/Axiom.psm1) that
#                    virtually every Pester self-test calls (Verify-Equal, ...).
#   2. TestHelpers - InPesterModuleScope / New-Dictionary / Clear-WhiteSpace,
#                    used at discovery time in several assertion tests.
#
# Dot-sourced by path, so $PSScriptRoot is the repo root here (true for both
# Pester's native BeforeContainer and the VS Code runner's discovery bridge).
# Idempotent: -Force re-import and the Remove-Module guard make it safe to run
# before EACH container (and before every -Serve discovery command).

# 1. Axiom - Verify-* helpers. Mirrors test.ps1:
#    Import-Module $PSScriptRoot/tst/axiom/Axiom.psm1 -DisableNameChecking
$axiomModule = "$PSScriptRoot/tst/axiom/Axiom.psm1"
if (Test-Path -LiteralPath $axiomModule) {
    Import-Module $axiomModule -DisableNameChecking -Force
}

# 2. TestHelpers - mirrors the New-Module block in test.ps1.
Get-Module TestHelpers | Remove-Module -Force -ErrorAction SilentlyContinue
New-Module -Name TestHelpers -ScriptBlock {
    function InPesterModuleScope {
        [CmdletBinding()]
        param (
            [Parameter(Mandatory = $true)]
            [scriptblock]
            $ScriptBlock
        )

        $module = Get-Module -Name Pester -ErrorAction Stop
        . $module $ScriptBlock
    }

    function New-Dictionary ([hashtable]$Hashtable) {
        $d = [System.Collections.Generic.Dictionary[string, object]]::new()
        $Hashtable.GetEnumerator() | ForEach-Object { $d.Add($_.Key, $_.Value) }

        $d
    }

    function Clear-WhiteSpace ($Text) {
        "$($Text -replace "(`t|`n|`r)"," " -replace "\s+"," ")".Trim()
    }
} | Out-Null
