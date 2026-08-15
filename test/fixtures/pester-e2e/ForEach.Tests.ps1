# Regression fixture for "Attempted to insert a duplicate test item ID".
#
# Get-TestId stringifies the -ForEach datum, so 1, '1' and 1.0 all render as
# "1" and collide into a single id. The runner's Set-UniqueIds dedup pre-pass
# has to disambiguate them, and discovery ids must match the ids the run emits
# (they are produced by separate pwsh invocations).

Describe 'ForEach id collisions' {
    It 'case <_>' -ForEach @(1, '1', 1.0) {
        $true | Should -BeTrue
    }
}

Describe 'ForEach with hashtable data' {
    It 'adds <A> and <B>' -ForEach @(
        @{ A = 1; B = 2; Sum = 3 }
        @{ A = 2; B = 3; Sum = 5 }
    ) {
        ($A + $B) | Should -Be $Sum
    }
}
