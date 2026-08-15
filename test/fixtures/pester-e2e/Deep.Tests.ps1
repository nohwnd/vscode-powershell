# Regression fixture for the depth-8 JSON truncation that crashed "Run all"
# with "nodes.map is not a function".
#
# The discovery tree serializes as file > tests[] > block > children[] > ...,
# roughly two JSON levels per block level. Seven nested block levels lands
# around JSON depth 14, so if Write-JsonLine ever goes back to -Depth 8 the
# deepest `children` array collapses into a String and the controller's
# buildItemTree throws.

Describe 'Depth L1' {
    Context 'L2' {
        Context 'L3' {
            Context 'L4' {
                Context 'L5' {
                    Context 'L6' {
                        Context 'L7' {
                            It 'survives serialization at depth 7' {
                                $true | Should -BeTrue
                            }
                        }
                    }
                }
            }
        }
    }
}
