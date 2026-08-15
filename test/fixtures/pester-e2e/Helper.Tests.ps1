# Regression fixture for the BeforeContainer discovery bridge.
#
# Get-FixtureCases is defined only in Pester.BeforeContainer.ps1 at the
# workspace root. Calling it from -ForEach forces it to be needed during the
# DISCOVERY phase, not the run phase — which is the case Pester's own
# Run.SkipRun path used to miss, and the case the runner bridges by
# dot-sourcing the repo-root BeforeContainer file before discovery.
#
# This stands in for the Pester repo's InPesterModuleScope without needing the
# Pester source tree checked out.

Describe 'Helper from BeforeContainer' {
    It 'discovers case <_>' -ForEach (Get-FixtureCases) {
        $_ | Should -BeIn @('alpha', 'beta')
    }
}
