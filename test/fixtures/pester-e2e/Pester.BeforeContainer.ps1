# Dot-sourced by Pester into the run session state before each container is
# discovered and run. The E2E fixtures use it the same way the Pester repo's own
# self-tests do: to define helpers that a .Tests.ps1 file needs at DISCOVERY
# time but that are not defined inside the file itself.
#
# Must be idempotent — the persistent -Serve worker re-runs it before every
# discovery command.

Get-Module E2EHelpers | Remove-Module -Force -ErrorAction SilentlyContinue
New-Module -Name E2EHelpers -ScriptBlock {
    # Called at discovery time by Helper.Tests.ps1. If the BeforeContainer
    # bridge regresses, discovery of that file fails with
    # "The term 'Get-FixtureCases' is not recognized", which is exactly the
    # InPesterModuleScope failure mode this fixture stands in for.
    function Get-FixtureCases {
        @('alpha', 'beta')
    }
} | Out-Null
