# Pester Test Explorer

The extension registers a native VS Code [Test Controller][testing-api] for
Pester, so `.Tests.ps1` files show up in the Test Explorer and in the editor
gutter with Run, Debug and Run with Coverage.

[testing-api]: https://code.visualstudio.com/api/extension-guides/testing

## Requirements

- Pester 5.0 or newer, resolved from `Get-Module Pester -ListAvailable` (the
  highest installed version that is at least 5.0 wins). Pester 4 has no
  `Configuration` object and is not supported by the Test Explorer, it still
  gets the old CodeLens.
- Pester 6.1.0 or newer if you need the `Pester.BeforeContainer.ps1` support
  described below.
- PowerShell 7, or Windows PowerShell 5.1.

## How it works

Two pieces:

- `src/features/PesterTestController.ts` is the controller. It owns the test
  tree, the three run profiles, and the translation from runner events to
  `TestRun` outcomes.
- `scripts/PesterRunner.ps1` is spawned as a separate PowerShell process and
  speaks a line delimited JSON protocol on stdout, one object per line. Any
  non-JSON noise goes to stderr and is logged, never parsed.

Discovery happens twice, on purpose. An eager pass parses the file's AST so the
tree and the gutter icons appear immediately, and the real Pester discovery
replaces it when it arrives. The runner is authoritative when it returns tests,
because it sees the `-ForEach` cases and `BeforeDiscovery` generated blocks the
AST cannot. When Pester fails to discover a file the AST tree is kept and the
error is shown on the file item, rather than the file silently going empty.

By default one long lived PowerShell worker serves every discover and run
request (`PesterRunner.ps1 -Serve`), which avoids paying PowerShell startup and
the Pester module import on each call. Set
`powershell.pester.useChildProcessRunner` to spawn a fresh process per request
instead.

## Tests whose helpers come from a repo bootstrap

Some repositories define helper functions for their tests in a bootstrap script
rather than in the `.Tests.ps1` files. Pester's own self-tests are the clearest
example: `test.ps1` defines `InPesterModuleScope` and imports the `Verify-*`
assertion helpers into the parent session, so a single file discovered on its
own has no idea what those are and discovery fails with:

```text
The term 'InPesterModuleScope' is not recognized as a name of a cmdlet, function, ...
```

The Test Explorer always discovers and runs files individually, so it hits this
whenever a helper is needed at **discovery** time (typically because it feeds
`-ForEach`).

Pester's `BeforeContainer` feature is the fix. Put a
`Pester.BeforeContainer.ps1` at the repository root and Pester dot-sources it
into the run session state before each container. Define the helpers there:

```powershell
Get-Module MyTestHelpers | Remove-Module -Force -ErrorAction SilentlyContinue
New-Module -Name MyTestHelpers -ScriptBlock {
    function Get-TestCases { @('alpha', 'beta') }
} | Out-Null
```

Make it idempotent. The persistent worker re-runs it before every discovery
command, so a plain `New-Module` without the `Remove-Module` guard will warn or
fail the second time.

Two implementation notes, both of which have bitten us:

- Pester's discovery-only mode returns from `Invoke-Test` before the native
  BeforeContainer dot-source, so the runner applies the file itself during
  discovery. The run path uses Pester's native handling.
- Pester resolves the repository root from the **.NET** current directory, which
  `Set-Location` does not change. The runner keeps `$PWD` and
  `[System.IO.Directory]::SetCurrentDirectory` in sync, otherwise the root
  resolves to wherever the host process happened to start and the file is never
  found.

## Coverage

The Coverage profile runs Pester with code coverage on and parses the JaCoCo XML
it produces into `FileCoverage` and per-line `StatementCoverage`, which drives
the native coverage UI and the inline gutter decorations. Branch coverage is not
exposed because Pester does not emit branch data.

The XML shape differs between versions and the parser normalises both: Pester 5
with `CoverageGutters` writes a leaf filename, Pester 5 and 6 with `JaCoCo`
write a path relative to the common parent of every instrumented file. Never
join the package and sourcefile attributes naively, that double-counts the
subdirectory for the JaCoCo shape.

Use `powershell.pester.coveragePath` to choose what gets instrumented. Empty,
the default, means every `*.ps1` and `*.psm1` in the workspace that is not
itself a test file.

## Settings

All under `powershell.pester`. See the Settings UI for the full list and
defaults; the ones worth knowing about:

| Setting | What it does |
|---|---|
| `useTestController` | Turns the Test Explorer integration off entirely. |
| `useChildProcessRunner` | Spawn a fresh PowerShell per request instead of reusing one worker. |
| `testFilePath` | Globs used to find test files. |
| `coveragePath` | Files to instrument for coverage. |
| `workingDirectory` | Directory the runner runs from. Defaults to the workspace folder. |
| `pesterModulePath` | Pin a specific Pester module instead of the newest installed. |
| `configurationPath` | A `.psd1` Pester configuration to use as the base. |
| `codeLens` | The older CodeLens above test blocks, off by default now that the Test Explorer exists. |

## Working on this feature

```powershell
npm test          # unit suite, fast, no PowerShell involved in most of it
npm run test:e2e  # end to end, drives real pwsh and real Pester
npm run test:all  # both
```

The end to end suite lives in `test/e2e` and runs against the fixture workspace
in `test/fixtures/pester-e2e`. It uses its own `vscode-test` config because it
needs its own workspace folder, and its files are named `*.e2e.ts` so the unit
glob does not pick them up. Pressing <kbd>F5</kbd> opens an Extension
Development Host on that same fixture workspace.

The fixtures are deliberately awkward, each one pins a bug that has already
happened once: seven levels of nested blocks, `-ForEach` data that stringifies
to identical test ids, a helper that only exists in `Pester.BeforeContainer.ps1`,
and a file that fails discovery on purpose.

Two things worth knowing when debugging this:

- **You do not need VS Code for runner work.** Drive `scripts/PesterRunner.ps1`
  directly and read the JSON. It is much faster.
- **Start the probe outside the repository.** The extension spawns the worker
  without setting a working directory, so it inherits whatever the extension
  host had. A probe launched from inside the repository hides every bug caused
  by that, because the .NET current directory is already correct.

The Debug profile needs a built PowerShellEditorServices, because it runs the
tests under the PSES debug adapter and recovers results from a sidecar event
log (stdout belongs to the debug REPL there). Clone it as a sibling and build:

```powershell
git clone https://github.com/PowerShell/PowerShellEditorServices.git ../PowerShellEditorServices
Invoke-Build Build
```
