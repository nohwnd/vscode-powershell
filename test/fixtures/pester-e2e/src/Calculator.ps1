# Coverage subject. Add-Numbers is exercised by Calculator.Tests.ps1;
# Get-UncoveredValue deliberately never runs, so a correct coverage report has
# to show covered lines in the first function and missed lines in the second.

function Add-Numbers {
    param($A, $B)

    $sum = $A + $B
    return $sum
}

function Get-UncoveredValue {
    $never = 'this line is never executed'
    return $never
}
