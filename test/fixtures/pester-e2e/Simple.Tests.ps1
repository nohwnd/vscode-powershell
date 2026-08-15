# Baseline shape: nested blocks and one test of each outcome, so a run can
# assert that passed / failed / skipped all land on the right test item.

Describe 'Simple' {
    Context 'Arithmetic' {
        It 'adds two numbers' {
            1 + 1 | Should -Be 2
        }

        It 'fails on purpose' {
            1 + 1 | Should -Be 3
        }

        It 'is skipped' -Skip {
            1 | Should -Be 1
        }
    }

    Context 'Strings' {
        It 'concatenates' {
            ('a' + 'b') | Should -Be 'ab'
        }
    }
}
