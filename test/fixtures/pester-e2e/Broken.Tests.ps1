# Regression fixture for silent empty discovery.
#
# This file throws during discovery because the function does not exist
# anywhere. The runner must emit the container's error on the `file` event
# rather than silently reporting zero tests, and the controller must surface it
# on the file item while keeping the eager-AST tree visible.
#
# Discovery failing here must NOT prevent the other fixture files from being
# discovered or run.

Describe 'Broken discovery' {
    It 'never gets discovered <_>' -ForEach (Get-DefinitelyUndefinedFixtureHelper) {
        $true | Should -BeTrue
    }
}
