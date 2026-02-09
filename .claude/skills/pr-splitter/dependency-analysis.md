# Dependency Analysis by Language

How to determine import/dependency relationships between changed files.

## General Strategy

1. Parse imports/includes in each changed file
2. Resolve them to file paths within the project
3. Filter to only relationships between changed files (ignore unchanged deps)
4. Build a directed graph: edge from A → B means "A depends on B"
5. Topological sort gives you the slice ordering foundation

## Rust

**Import patterns:**
- `use crate::module::item` → look for `src/module.rs` or `src/module/mod.rs`
- `use super::item` → parent module
- `use self::submodule` → child module
- `mod submodule;` declarations in `mod.rs` or `lib.rs` → the submodule file
- Re-exports: `pub use` in a module makes items available to consumers

**Key files:**
- `Cargo.toml` — workspace member changes affect build graph
- `lib.rs` / `mod.rs` — module tree declarations
- `build.rs` — build-time codegen

**Tips:**
- Trait definitions must come before `impl Trait for X` blocks
- Type aliases and newtypes often form dependency roots
- `#[derive(...)]` with custom derives may pull in proc-macro crates
- Check `cfg` attributes — some code is platform-conditional

## TypeScript / JavaScript

**Import patterns:**
- `import { X } from './module'` → `./module.ts`, `./module/index.ts`
- `import X from './module'` → default export
- `require('./module')` → CommonJS
- `export * from './module'` → re-exports (barrel files)
- Path aliases: check `tsconfig.json` `paths` for `@/` or `~/` prefixes

**Key files:**
- `package.json` — dependency changes
- `tsconfig.json` — path mappings, project references
- Barrel files (`index.ts`) — re-export hubs, often central to dependency graph

**Tips:**
- Circular imports are common in TS — flag these for the user
- Type-only imports (`import type`) are less critical for runtime ordering
- CSS/SCSS imports create implicit dependencies

## Python

**Import patterns:**
- `from package.module import X` → `package/module.py`
- `import package.module` → same
- Relative imports: `from . import sibling`, `from ..parent import X`
- `__init__.py` — package initialization, re-exports

**Key files:**
- `setup.py` / `pyproject.toml` — package configuration
- `__init__.py` — determines what's importable
- `conftest.py` — pytest fixtures shared across test modules

**Tips:**
- Python allows circular imports at module level (but not at import time)
- `TYPE_CHECKING` blocks contain type-only imports — less critical for ordering
- Django has model dependencies that create implicit ordering

## Go

**Import patterns:**
- `import "project/pkg/name"` → `pkg/name/` directory
- All `.go` files in a directory are one package
- `_test.go` files can use `package_test` (external test package)

**Key files:**
- `go.mod` — module path and dependencies
- `go.sum` — checksums (usually not relevant for slicing)

**Tips:**
- Interface definitions are often in separate files from implementations
- Circular package imports are compile errors in Go — slice ordering matters
- `internal/` packages restrict importability

## General Heuristics

When language-specific analysis is insufficient:

1. **String search**: grep for the file's exported names in other changed files
2. **Test files**: tests almost always depend on the code they test
3. **Config files**: usually depended on by everything, put them in slice 1
4. **Migration files**: ordered by timestamp, must maintain order
5. **Generated code**: depends on the generator config/schema, group together
