# Coverage fixture: exercises Add-Numbers but never Get-UncoveredValue, so the
# JaCoCo report has both covered and missed lines in one source file.

BeforeAll {
    . (Join-Path $PSScriptRoot 'src' 'Calculator.ps1')
}

Describe 'Calculator' {
    It 'adds two numbers' {
        Add-Numbers 1 2 | Should -Be 3
    }
}
