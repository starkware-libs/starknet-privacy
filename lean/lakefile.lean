import Lake
open Lake DSL

package «privacy» {
}

require mathlib from git
  "https://github.com/leanprover-community/mathlib4.git"

@[default_target]
lean_lib privacy {
}
