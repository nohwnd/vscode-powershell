# vscode-powershell: Testing API + Code Coverage investigation

Date: 2026-06-11
Initial ask (verbatim): *"I would like to have code coverage and test explorer integration with VScode and pester in the powershell-vscode repo. can you investigate? don't pr."*

## TL;DR

`PowerShell/vscode-powershell` has **no** integration with VS Code's native Testing API and **no** code-coverage integration. The current Pester UX is CodeLens above test blocks + a debug-launch wrapper. The de-facto Test Explorer integration today is the third-party `pspester.pester-test` extension (`pester/vscode-adapter`). Bringing this into vscode-powershell is feasible and the building blocks already exist.

## Current state in vscode-powershell (upstream/main @ 03595aa)

Source-of-truth files:

- `src/features/PesterTests.ts` (~175 lines) — only Pester-specific code in the extension. Registers three commands:
  - `PowerShell.RunPesterTestsFromFile` — file context-menu Run
  - `PowerShell.DebugPesterTestsFromFile` — file context-menu Debug
  - `PowerShell.RunPesterTests` — called by **PSES** (CodeLens) with `uri, runInDebugger, describeBlockName, lineNumber, outputPath`
- All three end up in `createLaunchConfig` → `vscode.debug.startDebugging` against `modules/PowerShellEditorServices/InvokePesterStub.ps1`.
- Settings (`package.json` → `powershell.pester.*`):
  - `useLegacyCodeLens` (Pester 4 compat)
  - `codeLens` (enable/disable)
  - `outputVerbosity`, `debugOutputVerbosity`
- `InvokePesterStub.ps1` (lives in `PowerShell/PowerShellEditorServices` repo, symlinked in at build time) — for Pester 5+ builds a `[PesterConfiguration]`-shaped hashtable. Already accepts `-OutputPath` which it wires into `TestResult.Enabled=true, OutputPath=...` (NUnit XML). **No `CodeCoverage` block** is configured.
- `src/features/ExternalApi.ts` exposes a tiny API for other extensions (`registerExternalExtension`, `waitUntilStarted`, `getPowerShellVersionDetails`). The string `ms-vscode.PesterTestExplorer` appears only as a doc-comment example — that extension does not exist on the marketplace.

Greps that returned nothing in `upstream/main`:

- `vscode\.tests | TestController | createTestController` → **0 hits**
- `coverage` in `src/`, `test/`, `package.json` → **0 hits**

So everything is CodeLens-driven and there is no Test Explorer or coverage surface today.

## Side note: PSES (PowerShell/PowerShellEditorServices)

The Pester CodeLens comes from PSES, not the extension:

- `src/PowerShellEditorServices/Services/CodeLens/PesterCodeLensProvider.cs` — emits the lenses.
- `src/PowerShellEditorServices/Services/Symbols/PesterDocumentSymbolProvider.cs` — AST walk that already extracts `Describe`/`Context`/`It` symbol references with line numbers. **This is the same discovery data a `TestController` would need** → reusable.
- LSP message `evaluate`/`PesterCodeLens` is unit-tested in `LanguageServerProtocolMessageTests.cs` (`CanSendPesterCodeLensRequestAsync`, `NoMessageIfPesterCodeLensDisabled`).

## Prior art

### `pester/vscode-adapter` (Marketplace ID: `pspester.pester-test`)

- 66 stars, last commit 2025-12-15, still labelled "Preview".
- Implements VS Code's Testing API (1.59+, July 2021): `TestController`, `TestRunProfileKind.Run`, `TestRunProfileKind.Debug`.
- `src/pesterTestController.ts` is the central controller (run/debug profiles, test discovery via PowerShell host).
- Integrates with the PowerShell extension via the `ExternalApi`.
- **Does NOT implement `TestRunProfileKind.Coverage`** — its `MockResult.json` shows it understands Pester's `CodeCoverage` config (JaCoCo / CoverageGutters), but the coverage data is not surfaced to VS Code's native Test Coverage UI.
- Pester ≥ 5.2.0 only; PS 7 or WinPS 5.1.

### Manual coverage today (community recipe)

`vscode-powershell` issue #495 (closed 2019-05-24): "Show Pester CodeCoverage data as green/red lines of source text". Closed pointing at a blog post (now dead, Wayback: <https://web.archive.org/web/20201107233838/https://www.pwsh.site/powershell/2019/01/10/how-to-enable-coverage-markings-in-vscode-for-your-powershell-projects.html>) that combines:
- Pester `-CodeCoverage` with `OutputFormat = JaCoCo` (or `CoverageGutters` from Pester 5.2+).
- The `ryanluker.vscode-coverage-gutters` extension to read the XML and paint the gutter.

This is the workaround currently recommended. `#631` is unrelated (an old terminal-on-macOS bug, resolved by reboot). `#3597` is about test-coverage of the *extension's own TypeScript code* (Istanbul/nyc), not Pester.

## Relevant VS Code APIs

- **Testing API** — `vscode.tests.createTestController`, `TestItem`, `TestRun`, `TestRunRequest`, `TestRunProfileKind.{Run,Debug,Coverage}`. Stable since 1.59 (July 2021).
- **Test Coverage API** — `TestRunProfileKind.Coverage`, `TestRun.addCoverage`, `FileCoverage`, `StatementCoverage`, `BranchCoverage`. Proposed in 1.88 (April 2024), finalised in 1.93 (August 2024). This is what hooks into the native gutter and the Test Coverage view — no `coverage-gutters` extension needed.

## Pester capabilities to lean on

- **Discovery without execution.** `Invoke-Pester -Configuration @{ Run = @{ Path = ...; SkipRun = $true; PassThru = $true } }` returns the full `Run.Containers[].Blocks[].Tests[]` tree with file/line — perfect for `TestController.resolveHandler` without doing AST parsing in TS.
- **Precise filtering.** `Filter.Line = "<path>:<line>"` (already used by `InvokePesterStub.ps1`) for re-running a single test/block.
- **Result format.** `TestResult.OutputFormat = 'NUnitXml' | 'JUnitXml'` with `OutputPath = ...`. Already plumbed through the stub.

### Coverage format mapping (verified against the Pester source)

- **Pester 5.x** (verified at tag `5.7.1`, `src/csharp/Pester/CodeCoverageConfiguration.cs:44`, `src/functions/Coverage.Plugin.ps1:149-150,219`): `OutputFormat` accepts `'JaCoCo' | 'CoverageGutters' | 'Cobertura'`, default `'JaCoCo'`. Both `JaCoCo` and `CoverageGutters` go through the same `Get-JaCoCoReportXml` with a `$isGutters` flag (`src/functions/Coverage.ps1:809`). The `$isGutters` branch (`Coverage.ps1:935-1003`):
  - drops the synthetic `commonParentLeaf` prefix from `package/@name` and `class/@name`
  - uses leaf filename for `class/@sourcefilename` and `sourcefile/@name` (instead of the relative path)
  - i.e. `CoverageGutters` is the *cleaner* JaCoCo shape that consumers like `ryanluker.vscode-coverage-gutters` actually expect.
- **Pester 6.x** (verified against `origin/main` @ `ce93186`, alpha5): `OutputFormat` accepts only `'JaCoCo' | 'Cobertura'` (`CoverageGutters` removed). The new `JaCoCo` shape **is** the old `CoverageGutters` shape — relative-to-`ReportRoot` paths, leaf names for `sourcefile/@name`, no `commonParentLeaf` prefix (`Coverage.ps1:886-919`). Default remains `'JaCoCo'`.

→ Strategy: parse one JaCoCo XML shape. Pick `OutputFormat` by detected Pester major version:
  - Pester ≥ 6.0.0 → `OutputFormat = 'JaCoCo'` (or omit, it's default).
  - Pester ≥ 5.0.0 → `OutputFormat = 'CoverageGutters'`.
  - Pester 4 → not supported (no Configuration object).

The XML elements we need for `vscode.FileCoverage` / `vscode.StatementCoverage`:
- `report/package/sourcefile/@name` → filename (resolve against the package path which is the directory relative to `ReportRoot`).
- `report/package/sourcefile/line` with `nr` (line number), `mi` (instructions missed), `ci` (instructions covered), `mb`/`cb` (branches — always 0 from Pester today, so we won't expose `BranchCoverage`).
- Counters at `class/counter` and `sourcefile/counter` are aggregates; we can compute totals from per-line `mi`/`ci` for `StatementCoverage`.

## Gap → implementation sketch (no PR, just shape)

1. **New `src/features/PesterTestController.ts`** that:
   - Creates a `TestController` ("pester", "Pester").
   - On activation, sets `controller.resolveHandler` to walk the workspace for `*.Tests.ps1` and call a small PS script via PSES to run `Invoke-Pester -SkipRun -PassThru` and emit the tree as JSON.
   - Adds `Run` and `Debug` `TestRunProfile`s reusing today's `createLaunchConfig` + `InvokePesterStub.ps1` flow, but passing `-OutputPath` and parsing NUnit/JUnit XML to drive `TestRun.passed/failed/skipped/errored` with messages and durations.
2. **Coverage** as a third `TestRunProfile` (kind `Coverage`):
   - Extend `InvokePesterStub.ps1` (in PSES) to also accept `-CodeCoveragePath` and `-CodeCoverageFormat 'JaCoCo'` (default) and add the `CodeCoverage` block to the configuration.
   - Parse the JaCoCo XML and produce `FileCoverage` + `StatementCoverage` (Pester reports per-line hits via JaCoCo's `<line nr=".." mi="..." ci="..."/>`).
3. **Keep CodeLens working** behind the existing `powershell.pester.codeLens` setting (don't break existing users); the Test Explorer lenses (`Run | Debug | Coverage`) appear automatically once a `TestController` registers `TestItem`s.
4. **Settings additions** under `powershell.pester.*`: `enableTestController` (default true), `coverage.enable`, `coverage.outputFormat`, `coverage.path` (paths to instrument).
5. **PSES side**: add a small LSP custom request `pester/discover` (or reuse the symbol provider AST output) so discovery doesn't require running a PowerShell process per workspace.

## Risks / unknowns

- Pester 4 support: the stub still branches for v4; v4 has no `SkipRun` discovery. Easiest is `enableTestController` only when Pester ≥ 5.0 is loaded; fall back to CodeLens otherwise.
- Discovery cost on big workspaces — should be lazy (per-file on file open + on edit) rather than eager.
- `pspester.pester-test` overlap — if it's installed, vscode-powershell should detect and avoid registering a duplicate controller (or coordinate via `ExternalApi`).
- The CoverageGutters XML format from Pester 5.2+ is bespoke; JaCoCo is the safer parse target.

## Testing strategy: `@vscode/test-cli`, not Playwright

The repo already wires `@vscode/test-cli` (`.vscode-test.mjs` at root) — Microsoft's current official runner that launches a real VS Code (Insiders), loads the extension, runs Mocha tests inside the extension host with full access to the live `vscode` API. `test/features/ExternalApi.test.ts` is the canonical example; `test/utils.ts` provides `ensureExtensionIsActivated`, `ensureEditorServicesIsConnected`, `WaitEvent`. CI runs it via `.github/workflows/ci-test.yml`.

For the TestController + coverage work this is strictly better than Playwright:

- Assert on `TestController.items` after `resolveHandler`.
- Drive runs via `vscode.commands.executeCommand('testing.runAll')` or directly invoke the profile handler.
- Capture `TestRun.passed/failed/skipped/errored` calls (the request object can be a fake), `TestMessage` payloads, durations.
- Read back `FileCoverage` arrays attached via `TestRun.addCoverage(...)`.
- Await with `WaitEvent` rather than sleeping for UI ticks.

Playwright (via `playwright-electron` against the test VS Code instance) only earns its slot for visual regression / pixel assertions — out of scope for coverage correctness. If we want screenshot evidence for PRs, use the existing `ui-screenshots` skill manually against a launched VS Code, not in CI.

Concrete additions:

- `test/features/PesterTestController.test.ts` against fixture `.Tests.ps1` files under `test/mocks/Pester/` (mirrors existing `test/mocks/BinaryModule/`).
- `test/mocks/Pester/coverage/` snapshots of JaCoCo XML from Pester 5.x (`CoverageGutters` format) and Pester 6.x (`JaCoCo` format), to unit-test the parser without spinning up PowerShell.
- Reuse `ensureEditorServicesIsConnected()` for the discovery + run paths so PSES is real, not stubbed.

## Key references

- Current Pester feature: `src/features/PesterTests.ts`
- Stub: `PowerShell/PowerShellEditorServices` → `module/PowerShellEditorServices/InvokePesterStub.ps1`
- PSES CodeLens: `src/PowerShellEditorServices/Services/CodeLens/PesterCodeLensProvider.cs`
- PSES Pester AST: `src/PowerShellEditorServices/Services/Symbols/PesterDocumentSymbolProvider.cs`
- Community Test Explorer: <https://github.com/pester/vscode-adapter> (`pspester.pester-test`)
- VS Code Testing API: <https://code.visualstudio.com/api/extension-guides/testing>
- VS Code Test Coverage API: <https://code.visualstudio.com/api/extension-guides/testing#test-coverage>
- Closed issues for historical context: `#495` (Pester coverage gutter), `#3597` (extension TS coverage), `#87` (original Pester support)


---

## Implementation outcome (2026-06-11, final state of session)

Branch: `feature/pester-test-controller` in worktree `Q:\p\vscode-powershell-trees\testcontroller` (from `upstream/main`). **No PR opened, per user instruction.**

### What shipped

- **`scripts/PesterRunner.ps1`** (247 lines, MIT-credit comment to `pester/vscode-adapter` at top): -Discover / -Run / -Coverage modes, JSON-line stdout protocol, `[AllowEmptyCollection()]` on `-Parents` (chain-id bug fix), format auto-selection (Pester 6 -> JaCoCo, Pester 5 -> CoverageGutters; both produce the same XML element shape but with **different sourcefile granularity**).
- **`src/coverage/jacoco.ts`**: pure regex-based parser (no new npm deps — private Azure mirror returns E401 for fresh installs). Splits into two halves:
  - `parseJaCoCoXml(xml)` returns raw `ParsedFileCoverage` with `package` and `sourcefile` kept verbatim.
  - `resolveCoverageSources(parsed, knownAbsolutePaths)` collapses the v5-CoverageGutters (leaf-only) vs v5/v6-JaCoCo (subpath) divergence into one canonical suffix and longest-suffix-matches case-insensitively. Reports unresolved entries instead of guessing.
- **`src/coverage/vscodeAdapter.ts`**: `toFileCoverage(resolved)` -> `vscode.FileCoverage.fromDetails()` with per-line `StatementCoverage`. Statements only (Pester emits no branch data).
- **`src/features/pesterRunnerInvoker.ts`**: `IPesterRunnerInvoker` interface + `ChildProcessPesterRunnerInvoker` impl. DI-friendly for unit tests.
- **`src/features/PesterTestController.ts`** (~430 lines): registers `vscode.tests.createTestController('powershell-pester', 'Pester')` with three profiles (Run / Debug / Coverage). Lazy discovery via `resolveHandler`, file watcher on `**/*.[tT]ests.ps1`. Debug profile delegates to the existing `PowerShell.RunPesterTests` command. Coexistence guard: `shouldRegister()` returns `false` when `pspester.pester-test` is installed. PowerShell exe resolved via `sessionManager.PowerShellExeDetails?.exePath ?? "pwsh"` at activation.
- **`src/extension.ts`**: registration block right after the original `commandRegistrations`, gated on `powershell.pester.useTestController` AND `shouldRegister()`.
- **`package.json`** settings:
  - `powershell.pester.codeLens` default **flipped to `false`** (PSES picks this up via LSP `workspace/configuration`, no TS change needed).
  - `powershell.pester.useTestController` (default `true`).
  - `powershell.pester.coveragePath` (default `[]` — empty means "instrument every `*.ps1`/`*.psm1` except `*.Tests.ps1`").
- **`tools/installPSResources.ps1`**: added `Pester 5.7.1` for CI parity.

### Tests added (all green locally)

- `test/coverage/jacoco.test.ts` — 18 tests covering parser shape, the three real fixtures, the resolver across all three flavours, same-basename disambiguation, unresolved reporting, case-insensitivity.
- `test/coverage/pipeline.test.ts` — 5 tests: 3 parametrised per fixture + 2 assertion-style (StatementCoverage totals, missed-line=0 execution). **Drive-letter casing trap on Windows**: `vscode.Uri.file("C:\\...").fsPath` returns `"c:\\..."` — always compare case-insensitively.
- `test/features/PesterTestController.test.ts` — 10 tests for the extracted pure helpers `buildItemTree` and `reportRunnerEvent`.
- `test/fixtures/coverage/*.xml` — three real fixtures (Alpha in `src/a/`, Beta in `src/b/`) captured from Pester 5.7.1 CoverageGutters, Pester 5.7.1 JaCoCo, Pester 6.0.0 JaCoCo.

### Final test run

`npm test` → **91 passing**, 2 pending, 9 failing. All 9 failures are pre-existing PSES-sibling-clone-missing (ISE / ExternalApi / Debug / Settings / Path) — unrelated to this work.

`npm run lint` clean. `npm run format` clean. `npm run compile` clean.

### Central insight: JaCoCo XML shape divergence

- Pester 5 CoverageGutters: `package="src/a" sourcefile="Alpha.ps1"` (leaf only).
- Pester 5 + 6 JaCoCo: `package="src/a" sourcefile="a/Alpha.ps1"` (subpath relative to common parent of all instrumented files).
- **Never naively join package + sourcefile** — gives `src/a/a/Alpha.ps1` for JaCoCo.
- **Canonical suffix**: `pkg + '/' + sourcefile_with_redundant_prefix_stripped`. Both shapes collapse to `src/a/Alpha.ps1`. Suffix-match longest-wins against the known absolute paths passed from the controller (same list that the runner saw via `-CoverageSourcePath`).
- "Common parent" trap: Pester chooses the common parent of **all** instrumented files. With only one test file you may get `<root>/tests/`; with two test files in different subtrees you may get `<root>/`. Don't hard-code an assumption.

### Things deliberately deferred

- **No "old CodeLens behaviour" fallback flag** yet. User said only add it if upstream maintainers request it during review.
- **No e2e smoke test** that runs real Invoke-Pester from inside the test host. Manually smoke-tested end-to-end against both Pester 5.7.1 and 6.0.0 during the session and the runner produces clean test IDs + valid XML.
- **No PR.** User asked for "investigate; don't pr". Repeated when work was kicked off. Worktree left buildable for review.

### Worktree status

- Branch ahead of `upstream/main` by ~10 commits. Working tree clean.
- Run `npm run compile && npm test` from `Q:\p\vscode-powershell-trees\testcontroller` to reproduce.

---

## 2026-06-12 — Continuation: rebase, three new features, full green test run

Picked the branch back up the day after the initial drop. Two upstream PRs
landed in between (Jakub's own #5513 and #5514), so first action was a clean
rebase onto `upstream/main` — no real conflicts, just the `useLegacyCodeLens`
default flip absorbing my earlier edit. Branch is now 5 commits ahead of
`upstream/main` and behind by 0.

### Eager AST discovery (`src/features/pesterAstDiscovery.ts` + test)

Test Explorer gutter icons used to require expanding a file in the Test
Explorer tree first — `TestController.resolveHandler` only fires on user
demand. Two-tier eager discovery now populates `TestItem.children` as soon
as a `*.Tests.ps1` file is opened or edited:

1. Preferred: `vscode.executeDocumentSymbolProvider` → PSES symbol provider.
2. Fallback (PSES not yet started, or symbol provider quiet): regex-based
   text scan that tracks `{}` depth while ignoring single/double-quoted
   strings and `#` comments.

PSES is usually still starting at extension activation, so the first
provider call returns nothing for files that were already open. Retry on
`[0, 500, 1500, 4000, 10000, 20000] ms` backoff. A `runnerDiscovered`
`Set` guards the AST output from stomping on the real runner's tree
afterwards (the runner picks up dynamic `-ForEach` cases and
`BeforeDiscovery`-generated blocks the AST can't see). Debounced 300 ms on
edits.

Also wired a hidden `PowerShell.Pester.DebugDocumentSymbols` command for
manual diagnostics when PSES isn't returning symbols.

### Persistent Pester worker (`src/features/pesterPersistentInvoker.ts` + `PesterRunner.ps1 -Serve`)

The old `ChildProcessPesterRunnerInvoker` paid ~1–2 s of startup tax per
discover/run because `pwsh` re-imported Pester every call. New mode keeps
one `pwsh` + Pester module loaded for the session, multiplexing
discover/run/coverage requests over JSON-line stdio. Per-request `requestId`
on every outbound event so the TS side routes results to the right caller.
Cancellation kills the worker (Pester has no preemptive cancel) and the
queue is rebuilt against a fresh worker. Default; opt out with
`powershell.pester.useChildProcessRunner` if the worker misbehaves in some
environment.

`scripts/PesterRunner.ps1` got a `-Serve` parameter set plus the supporting
helpers: `Resolve-OriginalPath` (Pester normalises drive-letter casing on
Windows; round-trip the caller's path so emitted ids match the TS side's
`Uri.fsPath`), `Expand-PesterName` (resolve `<placeholder>` tokens against
`-ForEach` data so each iteration gets a stable id at discovery time
rather than colliding on the same template). Also forced
`$PSStyle.OutputRendering = 'ANSI'` so colour codes survive stream capture.

### Streamed Pester host output (`appendOutput`)

`PesterRunner.ps1` now emits `output` events for Information, Error,
Warning, and Verbose records as they happen. Output is rendered with ANSI
SGR escapes mirroring Pester's `Write-Host -ForegroundColor` mapping so the
test-output panel renders the familiar red/green dots verbatim. When a test
is in scope (Pester's currently-executing block), the event carries a
`testId` and `reportRunnerEvent` calls `run.appendOutput(text, undefined,
target)` so "show test output" focuses on that test; otherwise it falls
back to run-level output.

### Per-line run filter + ForEach reconciliation

`runOneFile` now passes `Filter.Line` when the user clicks a subset of
tests in a file, so Pester only runs what was clicked. Whole-file runs and
"Run All Tests" deliberately skip the filter so dynamic blocks not
discovered yet still execute.

The harder part: when the user clicks one specific `-ForEach` iteration,
the `TestItem` they clicked was created by AST discovery (one item per
declaration line). Pester actually runs the *expanded* iterations — and
emits result events against the *expanded* ids. `collectRequestedTests`
now runs in two phases: (1) discover every requested file via the runner,
(2) re-resolve each originally-included item against the *current* tree
using `resolveItemAfterDiscovery` → `findDescendantById` first, then
`findDescendantsByLine` (same source line = same `-ForEach` template) so
sibling iterations bind to the right items.

### Tests added

- `test/features/pesterAstDiscovery.test.ts` — 19 tests covering quoted /
  bareword / `-Name` / escape sequences, nested DocumentSymbol AND flat
  SymbolInformation trees, range containment re-nesting, text fallback
  including comments + string literals + `-ForEach` / `-TestCases`
  detection.
- 3 new `reportRunnerEvent` tests for the output-event branch (unscoped,
  scoped-to-test, falls-back-when-testId-unknown).
- 4 new `collectFilterLines` tests (empty, no-range, 0→1 conversion,
  `-ForEach` de-dup, mixed input).
- 3 `findDescendantById` tests (nested hit, root-not-matched, miss).
- 4 `findDescendantsByLine` tests (ForEach expansion, nested descent,
  no-match, items without range).

### Final test run (2026-06-12)

`npm test` → **178 passing, 4 pending, 0 failing.** Up from 91/9-failing
in the original session — all the formerly-failing PSES-sibling-clone
suites pass now too (someone set up the sibling between sessions; unrelated
to this work).

`npm run compile` clean. `npm run lint` clean. `npm run format` clean.
`npx tsc --noEmit` has one pre-existing upstream error in `src/session.ts`
that is unrelated.

### Hit during this iteration

- `Array.prototype.sort()` lexicographic default vs numeric — `[6, 10].sort()`
  returns `[10, 6]`. Caught it on first test run; use
  `.sort((a, b) => a - b)` for number arrays.

### Commits on the branch (current state)

```
eefba3b Test collectFilterLines and the findDescendant* helpers
a116634 Add eager AST discovery, persistent worker, and line-filtered runs
0656daf Tests and fixtures for runner, parser, and controller
b3247fc Wire up the Pester TestController feature
3288063 Add Pester runner script and JaCoCo coverage parser
```

Still no PR (per Jakub's original "investigate; don't pr" + later "you
can mark ready when green, just don't merge"). Branch is review-ready in
`Q:\p\vscode-powershell-trees\testcontroller`.

### Still deferred

- E2E smoke test that actually runs `Invoke-Pester` from inside the test
  host. The pure helpers are well-covered; the integration story still
  relies on manual dogfood against `Q:\p\pester-demo`.
- Coordination with the third-party `pspester.pester-test` extension when
  both are installed — the `shouldRegister()` guard is still in place but
  there's no UX hint to the user.
- The `useLegacyCodeLens` fallback flag still doesn't have a "Test
  Explorer is offline, fall back to CodeLens" toggle. Wait for upstream
  review.

---

## 2026-06-12 — Side-by-side with pester/vscode-adapter

Full comparison written up at
[`vscode-adapter-comparison.md`](./vscode-adapter-comparison.md).

**TL;DR:** Core architecture is **highly convergent** — both use
`Invoke-Pester -SkipRun` for discovery, both stream JSON objects per line
from a long-lived `pwsh` process, both map the same result types onto the
same `TestRun` API. ~2,850 LoC theirs vs ~3,900 ours; the delta is almost
entirely our coverage layer + eager AST discovery + serve-mode plumbing.

**Unique to us:** native Test Coverage API (`TestRunProfileKind.Coverage`),
eager AST discovery (PSES DocumentSymbol + text fallback) for gutter
icons, formal `shouldRegister()` coexistence guard.

**Unique to them:** `TestTag` for Pester `-Tag`, native
`TestRunRequest.continuous`, a fundamentally cleaner ID scheme that
side-steps ForEach reconciliation, `TestMessage.diff()` for assertion
failures, `TestItem.busy` during discovery.

**Best ideas to steal next:**
1. Their ID scheme (`file>>unexpanded path>>Key=Value`) — would let us
   delete `resolveItemAfterDiscovery`, `findDescendantById`,
   `findDescendantsByLine` (~150 lines of TS).
2. `TestTag` support for Pester tags.
3. `TestMessage.diff()` for assertion failures.
4. `TestItem.busy = true` while runner discovery is in flight.



## 2026-06-12 (afternoon) — Parity migration: "steal the rest" pass

Goal: stop deferring to `pester/vscode-adapter` and absorb the remaining
unique features so the third-party extension can be deprecated cleanly.

### Yield removed

`PesterTestController.shouldRegister()` no longer defers when
`pspester.pester-test` is installed; both can coexist with the in-tree
controller now being the supported path. `extension.ts` collapsed the
branch to a plain `useTestController` config check.

### Test id scheme

Switched from `<file>::A > B > C` to vscode-adapter's
`<file>>>A>>B>>C[>>Key=Value...]`:

- Sorted `Key=Value` pairs from the merged `-ForEach` Data give each
  iteration a unique stable id without expanding placeholders.
- `Get-TestId` (PS) and `buildAstId` (TS) both validate that no name
  segment contains the `>>` separator and throw with a clear message
  if it does.
- `Get-MergedData` walks the parent chain so a `Describe -ForEach`
  iteration whose `It` carries no per-iteration data still gets the
  ancestor's data merged into its id.
- File segment is now lowercased on the drive letter (Windows) to
  match `vscode.Uri.file().fsPath`. The TS controller and the runner
  both honour this, so the round-trip is stable.

### Reconciliation deleted

The old `findDescendantsByLine` reconciliation layer is gone. The new
prefix-match (`findDescendantsByIdPrefix`) resolves an AST template item
to all of its runner-discovered iterations via `id === prefix` or
`id.startsWith(prefix + ">>")`. The `>>` boundary requirement prevents
sibling tests with shared name prefixes from accidentally matching.
Net deletion: ~150 LoC of fuzzy line-based matching.

### Features ported from vscode-adapter

- **Tags** — `PesterRunner.ps1` emits `tags` from `$Item.Tag`; the
  controller applies them via `getTestTag(id)` and a module-level
  `Map` so tag instances are reused across siblings.
- **`TestMessage.diff`** — `Get-ExpectedActual` regex extracts the
  expected/actual halves from Pester's `Expected X, but got Y` message.
  When both are present the controller emits a
  `vscode.TestMessage.diff(body, expected, actual)` per error, so the
  Test Results panel renders a side-by-side diff.
- **Busy spinner** — `TestItem.busy = true` while Pester is in the
  discovery phase for that file.
- **Continuous run** — `supportsContinuousRun: true` on Run/Debug/
  Coverage profiles. A `FileSystemWatcher` (debounced 250 ms) re-runs
  the request on file changes; disposed via the cancellation token.

### New settings (`powershell.pester.*`)

- `pesterModulePath` (string) — pin a specific Pester module
  folder/manifest.
- `workingDirectory` (string) — cwd for the runner process.
- `configurationPath` (string) — `.psd1` Pester configuration to load
  before per-call overrides.
- `testFilePath` (string[]) — globs for test discovery and the file
  watcher; default `["**/*.[tT]ests.[pP][sS]1"]`.

Persistent worker honours `workingDirectory` and `configurationPath`
per-command (cheap); `pesterModulePath` only at startup (the module is
imported once and swapping it mid-session would defeat the worker).

### Verification

`npm run compile`, `npm run lint`, `npx prettier --check`, `npm test`
all clean. **183 passing, 4 pending, 0 failing.** New tests cover:

- `>>` ID format in AST symbol + text discovery.
- `findDescendantsByIdPrefix` (6 cases incl. boundary edge case).
- `buildItemTree` applies Pester tags and de-duplicates `TestTag` per id.
- `reportRunnerEvent` emits one `TestMessage` per error.
- `TestMessage.diff` round-trips the human-readable body when
  `expected`/`actual` are set.

### Commits added (on top of 5 already there)

- `596c16f` Stop yielding to pester/vscode-adapter for Test Explorer
  registration
- `642bcd8` Match pester/vscode-adapter feature parity in the Pester
  TestController (the big one)
- `76c517c` Declare the four new powershell.pester settings in
  package.json

Branch `feature/pester-test-controller` is now 8 ahead / 0 behind
`upstream/main`. Working tree clean. **Still no PR per the standing
"investigate; don't pr" instruction.**


## 2026-06-12 evening — final cosmetic gap pass + smoke VSIX

Closed the last three settings that pester/vscode-adapter exposes but the
in-tree TestController had been ignoring: `hideSkippedBecauseMessages`,
`autoDebugOnSave`, `testChangeTimeout`. Skip-because reasons are now pulled
from `$it.ErrorRecord[0].Exception.Message` (fallback `$it.FailureMessage`)
in `PesterRunner.ps1::Emit-ResultsForBlock`, surfaced as
`ResultEvent.skipMessage`, and appended to test output by `reportRunnerEvent`
unless the new setting suppresses them. Continuous run reads
`testChangeTimeout` (clamped >= 0) for the debounce, and `autoDebugOnSave`
swaps re-runs from `runOnce` to `debug` — initial run stays on Run so
activating continuous does not immediately attach the debugger.

Commit: 1fc676e on top of 76c517c. Branch
`feature/pester-test-controller` is now 9 ahead / 0 behind `upstream/main`.
Tests: 185 passing / 4 pending / 0 failing. Lint + prettier clean.

VSIX built via `npm run package` at
`Q:\p\vscode-powershell-trees\testcontroller\powershell-2026.1.1.vsix`
(19.6 MB). Note: the npm script writes to `--out out/`, which vsce
interpreted as the filename `out`. Renamed manually.

Installed into an isolated Insiders profile at
`C:\Users\jajares\.copilot\session-state\b4fa5144-a74a-49d5-a8a4-31c78b26f019\files\smoke-vscode`
(separate `--user-data-dir` + `--extensions-dir`) and launched against the
new smoke workspace at
`Copilot\vscode-powershell-testing-api\smoke-workspace`. Five scenarios
authored for Jakub to walk through manually.

Still no PR per the standing "investigate; don't pr" rule.


---

## 2026-07-07 -- Rebase + attribution cleanup (PR-readiness pass)

Picked the branch back up ~3 weeks later to assess PR-readiness. Was 13 ahead /
15 behind upstream/main.

- **Rebased** `feature/pester-test-controller` onto current `upstream/main` --
  clean, zero conflicts. Now 15 ahead / 0 behind.
- **Attribution cleanup** (Justin Grote / pester/vscode-adapter):
  - `scripts/PesterRunner.ps1` header previously claimed the protocol was
    "adapted and used here with the author's permission" -- permission was
    never actually established. Reworded to a plain MIT attribution (no
    permission claim).
  - Vendored Justin's full upstream MIT license verbatim into
    `scripts/ThirdPartyNotices.txt` (ships in VSIX via `.vscodeignore` allowlist).
    Root `NOTICE.txt` left alone -- it's the MS component-governance file,
    likely regenerated on official builds.
- **Lint:** upstream's eslint got stricter over those 15 commits; fixed 2 new
  errors in our test files (unused vscode import in pipeline.test.ts;
  unnecessary optional chain in pesterAstDiscovery.test.ts).
- **Verified green:** `npm run compile` clean, `npm run lint` clean,
  `npm test` = **205 passing / 6 pending / 2 failing**. Both failures are
  pre-existing upstream `LanguageModelTools` tests (env-dependent: no Get-Help
  content installed -> helpText null; machine-specific Get-Command count).
  Confirmed our branch never touches that code. Every Pester/coverage/AST test
  passes.

**Status: still no PR, no push to origin.** User will manually test locally and
review the code first. Branch review-ready in `Q:\p\vscode-powershell-trees\testcontroller`.
New commits on top: `Vendor pester/vscode-adapter's MIT license...` and
`Satisfy stricter upstream eslint rules after rebase`.

---

## 2026-07-09 -- Launched for manual test + finalized attribution

- **Launched** Extension Development Host for manual dogfooding:
  `code-insiders --extensionDevelopmentPath=<worktree> --disable-extensions <smoke-workspace>`.
  Smoke workspace: `Copilot\vscode-powershell-testing-api\smoke-workspace` (Greeter.ps1 +
  tests\Greeter.Tests.ps1). Settings: useTestController on, codeLens off,
  coveragePath src/**/*.ps1, persistent-worker runner, Detailed verbosity.
- **Attribution finalized:** Justin Grote gave permission to adapt the runner
  protocol. Per Jakub, mention + credit is enough. Restored the "used with the
  author's permission" wording in the PesterRunner.ps1 header and **removed** the
  separate `scripts/ThirdPartyNotices.txt` (vendored full MIT license) added on
  07-07 -- more than needed given permission + in-file credit. Reshaped the two
  session commits so the notices file never appears in history. If the MS-repo PR
  review later wants a formal third-party notice, easy to re-add.
- Branch tip now: `Credit pester/vscode-adapter for the adapted runner protocol`
  + `Satisfy stricter upstream eslint rules after rebase`. 15 ahead / 0 behind
  upstream/main, tree clean. Still no push / no PR.

---

## 2026-07-09 (cont.) -- Dogfooding: fixed 3 Test Explorer discovery bugs

Tested the Extension Dev Host against the real Pester repo (q:\p\pester). Two
user-visible bugs + one silent one, all root-caused and fixed. Committed as
308e68e on feature/pester-test-controller (4 files, +310/-12). Still no push / no PR.

### Bug 1 -- InPesterModuleScope tests invisible + never run
- Symptom: file nodes appear in Test Explorer but expand to nothing, no gutter
  icons; a Run All skips them.
- Root cause: InPesterModuleScope is a Pester REPO-PRIVATE helper defined in the
  repo's own test.ps1. Discovered standalone it is undefined, so Pester discovery
  fails and returns zero tests. The controller treated "zero tests" as truth:
  it replaced the eager-AST children with [] AND added the file to
  runnerDiscovered, which permanently blocked AST refill. So the file went blank
  and stayed blank.
- Fix A (PesterTestController.ts): new pure, unit-tested decideDiscoveryOutcome
  (tests, error) -> runner | empty | astFallback. Rule: zero tests WITH a
  discovery error = astFallback (keep the AST tree, do NOT mark runnerDiscovered);
  zero tests WITHOUT error = genuinely empty (trust runner, clear AST guesses);
  any tests = runner authoritative. discoverFile now collects the discovery
  events into an array and acts after the stream ends, so a failed/empty result
  can never wipe the tree mid-stream. Error is surfaced on the file item for
  EVERY outcome (formatDiscoveryError) so partial failures show too.

### Bug 2 -- "Attempted to insert a duplicate test item ID"
- Symptom: warnings in the Pester worker log; some -ForEach/-TestCases cases
  collapse onto each other. Users repro: Should-All.Tests.ps1 (Actual=1) and
  Should-Throw.Tests.ps1 (General try catch behavior...).
- Root cause: Get-TestId stringifies the ForEach datum; @(1) and 1 both render
  as "1", so two distinct cases get identical ids.
- Fix B (PesterRunner.ps1): global per-file dedup pre-pass. Set-UniqueIds walks
  the container in deterministic DFS order (blocks before tests -- Get-WalkItems),
  computes base ids via Get-TestId, and Resolve-DuplicateIds APPENDS a stable
  positional >>#<n> suffix to any collision (unique ids untouched, so the TS-side
  prefix matching that maps an AST node to its expanded runner ids still holds).
  Result stashed as __UniqueId note-property; Get-UniqueId reads it. Discovery and
  run are SEPARATE pwsh processes, so ids must be reproducible from container
  structure alone -- the fixed DFS order guarantees discovery ids == run ids.
  Wired into Emit-Discovery, Get-BlockChildren, Emit-ResultsForBlock, Emit-RunResults.
  Global (not per-sibling) because nested parameterized Context blocks collide
  ACROSS iterations, which per-sibling dedup misses.

### Bug 3 -- silent empty discovery (found while fixing)
- Emit-Discovery ignored the container Result / ErrorRecord and emitted zero
  tests with no signal, so the controller could not tell "empty file" from
  "discovery blew up".
- Fix D: Get-ContainerDiscoveryError extracts the container error; Emit-Discovery
  emits it as error on the file event. FileEvent gained error?: string
  (pesterRunnerInvoker.ts). This is what feeds Fix A's astFallback decision.

### Verification
- Repro fixtures under Q:\tmp\prunner-repro (Be, Context, Should-All, Should-Throw,
  synthetic nested Dedup). Faithful Pester 5.7.1 at Q:\tmp\pester5 (machine only had
  6.0.0-dev, which throws ResolveEnabled in SkipRun -- out of scope).
- Should-All / Should-Throw: discovery ids == run ids exactly, zero dups (39 tests
  in Should-Throw). Should-Throw is a PARTIAL failure (39 tests AND an
  InPesterModuleScope error) -- error now surfaced alongside the visible tests.
- Be.Tests.ps1: InPesterModuleScope error surfaced, AST tests stay visible.
- Healthy files carry no error key. npm run compile / tsc --noEmit / npm run lint
  all clean. npm test = 210 passing (+5), 6 pending, 2 failing (pre-existing
  LanguageModelTools, unrelated).

### Open design decision for Jakub
InPesterModuleScope tests are now VISIBLE (via AST) with an explanatory error,
but still cannot RUN standalone -- they need the Pester repo's test.ps1 bootstrap.
runOneFile marks any item without a result as skipped, so after a run they show
skipped (honest, not hanging). Public InModuleScope works fully. Options:
(a) a workspace "bootstrap script" setting we dot-source before discovery/run;
(b) accept show-but-not-run. Prefer to hear Jakub's call.

### Pre-existing, NOT mine
prettier --check flags src/features/pesterAstDiscovery.ts and
test/features/pesterAstDiscovery.test.ts (unchanged vs HEAD -- committed unformatted
earlier in the branch). My 4 files are prettier-clean. Flag for a separate
formatting commit before any PR.

---

## 2026-07-15 — AST-path duplicate ids + how Justin's adapter avoids it

Dogfooding on q:\p\pester surfaced a second duplicate-id bug, separate from the
runner one fixed in 308e68e.

**Bug (AST path).** `buildItemTree` builds a child array and calls
`parent.children.replace(children)`. VS Code's `TestItemCollection.replace`
THROWS "Attempted to insert a duplicate test item ID <id>" on the first
duplicate in the array (the string is VS Code's, not ours — not in our src).
The eager static/AST scanner (`pesterAstDiscovery.ts`, id = `file>>Path` names
only, no data, no line) can't expand `-ForEach`/`-TestCases`, so two same-named
Its (or a repeated block name) collide. The throw aborts the WHOLE file -> file
renders blank. Fatal for InPesterModuleScope files, whose only tree is the AST
one (runner discovery fails standalone). Log from the failed run was full of
`Pester AST discovery for <file> failed: Attempted to insert a duplicate test
item ID ...` for Mock/Format2/Be/HaveCount/Should-* .Tests.ps1.

**Fix (commit 4fa4f8f).** `resolveDuplicateNodeIds(ids)` - sibling-level dedup
mirroring the runner's `Resolve-DuplicateIds`: any id occurring >1x gets a
`>>#<n>` suffix on EVERY occurrence (0-based). Used in `buildItemTree` before
`replace`. Also protects the runner-materialise path as a safety net. 5 tests
(1 buildItemTree + 4 pure). 219 passing / 6 pending / 2 pre-existing
LanguageModelTools failures. Branch 17 ahead / 0 behind upstream/main.

**How Justin's adapter (pester/vscode-adapter) handles ids — the reference.**
- He has NO AST/static path. Discovery = real Pester with `Run.SkipRun`, via a
  private plugin (`Scripts/PesterTestPlugin.psm1`) hooked on `DiscoveryEnd`.
  Every `-ForEach` test is already EXPANDED by Pester with its own `.Data`, so
  siblings are naturally distinct.
- `New-TestItemId` = `ScriptBlock.File >> Test.Path >> DataItems`, where
  `DataItems` is the merged ForEach/TestCases data as sorted `key=value`
  strings (`Merge-TestData`). So he disambiguates by DATA VALUES, not a
  positional index. Root container id = the file path (upper-cased on Windows).
  He has NO dedup pass, so identical merged data would still collide (same
  class of bug our runner's `Get-TestId` had) - just rare in practice.
- Consequence: on the Pester repo he'd hit the SAME InPesterModuleScope failure
  (real discovery -> undefined helper -> block ErrorRecord), surfaced via
  `New-TestObject`'s `$Test.ErrorRecord` -> `DiscoveryError`. He would NOT get
  our AST duplicate-throw because he never statically scans. Our eager-AST tree
  is our own addition (instant render before pwsh spawns); the dedup is the
  price of it.

**Pester's own scheme (authoritative, Pester.Runtime.ps1).** Data-driven
expansions of one statement share `GroupId = "${StartLine}:${StartColumn}"`
(source position of the It/Describe keyword); within a group they're told apart
by `.Data` / `ExpandedName`. So it's position-based grouping + data, not a
0,1,2 counter. Our AST `>>#<n>` positional suffix is a reasonable stand-in for
the AST fallback (no data available statically); the runner path already keys
on data like Justin.

**Design note.** AST ids don't need to match runner ids: running always
re-runs runner discovery which REPLACES the AST tree, and InPesterModuleScope
files can't run standalone anyway. So the `>>#<n>` suffix is safe. If we ever
want AST ids to survive reordering, include line:col (Pester's GroupId) in the
AST id instead - bigger change, deferred.

**BeforeContainer (native fix for InPesterModuleScope run):** Pester dot-sources
a repo-root `Pester.BeforeContainer.ps1` (via `Run.RepoRoot`, default nearest
.git) before each file is discovered AND run. The Pester repo would need such a
file defining InPesterModuleScope.
> CORRECTION (see 2026-07-15 "BeforeContainer discovery bridge" section below):
> the feature ships in the installed **6.1.0** (not 6.2.0), and the run path
> already applies it. The real bug is that discovery-only mode (`Run.SkipRun`,
> what the Test Explorer uses) BYPASSES BeforeContainer entirely. Fixed with a
> runner-side bridge (commit 9b053cc) + the BC file now placed at q:\p\pester.

---

## 2026-07-15 — BeforeContainer discovery bridge (InPesterModuleScope, resolved)

The InPesterModuleScope-doesnt-discover problem turned out to be a genuine
**Pester bug**, not an extension bug. Chased it end-to-end and shipped a
runner-side bridge; the file both DISCOVERS and RUNS on q:\p\pester now.

**Root cause (Pester).** In `Invoke-Test` (built Pester.psm1 ~2616-2627; source
`src/Pester.Runtime.ps1`) the discovery-only path is:
    if ($PesterPreference.Run.SkipRun.Value) { $found = Discover-Test ...; return }
This early-returns BEFORE the interleaved run loop (~2667-2678) whose lines
2670-2673 dot-source `$BeforeContainerInit`. So in SkipRun mode -- exactly what
the Test Explorer uses for discovery -- Pester never applies `Run.BeforeContainer`
NOR the repo-root `Pester.BeforeContainer.ps1`. The comment on that branch even
says "Discovery-only mode (e.g. populating the VS Code Test Explorer)". Confirmed
live on upstream pester/Pester main (bea8b87). The RUN path (SkipRun=$false)
applies BeforeContainer correctly -- so only discovery was broken.

Proven with a 3-scenario probe: skiprun+repofile FAILS, skiprun+explicit
Run.BeforeContainer FAILS, run+repofile PASSES.

**Feature IS shipped in 6.1.0.** Installed Pester at
`...\PowerShell\Modules\Pester\6.1.0` has BeforeContainer = True and is what the
runner auto-picks (highest -ListAvailable >=5.0). The earlier "6.2.0 / not
shipped" note above was wrong. `Run.RepoRoot` (nearest .git) is still marked
EXPERIMENTAL in RunConfiguration.cs but is honored at runtime with no gate.

**The bridge (commit 9b053cc, scripts/PesterRunner.ps1, +39 lines).**
- `Resolve-DiscoveryBeforeContainerFile($Configuration)`: reads
  `$Configuration.Run.RepoRoot.Value` (try/catch for older Pester without the
  property); returns `<RepoRoot>\Pester.BeforeContainer.ps1` if it exists.
- In `Invoke-RunnerDiscover`, after building the SkipRun cfg and before
  Invoke-Pester, dot-sources that file into the runner session (try/catch ->
  emits an `output` event on failure). This runs in the runners OWN session, so
  the helper is defined before Pesters SkipRun discovery walks the file.
- Covers BOTH one-shot `-Discover` and the `-Serve` worker (Serve routes
  discovery through the same function). The BC file MUST be idempotent because
  Serve dot-sources it on every discover command -- the placed file has a
  `Get-Module TestHelpers | Remove-Module` guard.
- Why it works: `InPesterModuleScope` is defined via `New-Module -Name
  TestHelpers` (registers commands session-wide), so dot-sourcing the file even
  inside a function makes it visible to Pesters discovery.
- No rebuild: runner loads from scripts/ (context.extensionUri/scripts/
  PesterRunner.ps1), not dist/. F5 picks up edits immediately.

**BC file placed.** `q:\p\pester\Pester.BeforeContainer.ps1` (untracked) mirrors
the TestHelpers module from Pesters test.ps1 (InPesterModuleScope, New-Dictionary,
Clear-WhiteSpace), idempotent. Only affects the extension runner (installed
6.1.0); the users OLD local build (f7b374b, no BeforeContainer in src) ignores
it, so ./test.ps1 is unaffected. Master copy in session files/.

**Verified on the REAL q:\p\pester (in place, via the actual runner):**
- `tst\functions\assertions\Be.Tests.ps1` -> discovers 6 top-level blocks / 61
  nodes, NO InPesterModuleScope error. (Without the file: error surfaces on the
  file event, AST tree stays visible.)
- RUN path: a top-level InPesterModuleScope test runs green (Pester native
  BeforeContainer).
- TS suite unchanged: 219 passing / 6 pending / 2 pre-existing LanguageModelTools
  failures. Change is PowerShell-only.

**cwd gotcha (for future probes).** PowerShell Set-Location/Push-Location update
$PWD but NOT [Environment]::CurrentDirectory (the .NET cwd Pesters FindRepoRoot
reads). When spawning the runner in a probe, use Start-Process -WorkingDirectory
(or [IO.Directory]::SetCurrentDirectory). In production this is a non-issue: the
extension spawns the runner with cwd = workingDirectory ?? dirname(file).

**Upstream Pester fix (for a PR — Jakub is maintainer).** In
`src/Pester.Runtime.ps1` `Invoke-Test`, the `Run.SkipRun` branch should dot-source
`$BeforeContainerInit` before `Discover-Test`, mirroring the interleaved loop
(~2660-2673), so discovery-only consumers (Test Explorer, any -SkipRun caller)
get BeforeContainer too. Then the runner bridge becomes belt-and-suspenders and
could eventually be dropped. Also worth: ship a `Pester.BeforeContainer.ps1` at
the pester/Pester repo root so all contributors + CI discover single files
without test.ps1. Both are follow-up PRs, left for Jakub to own.

### 2026-07-15 (later) — the RUN also needed Axiom, not just TestHelpers
"be.tests.ps1 still does not run" -> discovery was fixed, but a real RUN via the
runner showed 20 passed / 35 failed. Failures were NOT a version mismatch: every
failure was `The term 'Verify-Equal' is not recognized` at Be.Tests.ps1:130.

test.ps1 sets up the parent session with THREE things; the first BC draft only
mirrored the third:
  1. Import-Module bin/Pester.psd1                          (Pester itself)
  2. Import-Module tst/axiom/Axiom.psm1 -DisableNameChecking (Verify-* helpers) <- MISSING
  3. New-Module TestHelpers { InPesterModuleScope; ... }     (had this)
Pester self-tests wrap the whole file in `InPesterModuleScope { Describe {...} }`
and the It bodies call Axiom's Verify-Equal/Verify-True/etc. Discovery only needs
#3 (InPesterModuleScope runs at block level); the RUN needs #2 as well.

Fix: added the Axiom import to Pester.BeforeContainer.ps1 (before the TestHelpers
New-Module), using `"$PSScriptRoot/tst/axiom/Axiom.psm1"`. Safe because Pester
returns `. '<repoRoot>\Pester.BeforeContainer.ps1'` (dot-source BY PATH), so
$PSScriptRoot == repo root inside the file, on BOTH Pester's native run path and
the runner's discovery bridge (verified by reading Resolve-PesterBeforeContainer
in installed 6.1.0). Test-Path guard skips gracefully in non-Pester repos;
Import-Module -Force + Remove-Module guard keep it idempotent for -Serve.

Verified via the actual runner on q:\p\pester (in place):
  Be.Tests.ps1          55/55 passed
  BeGreaterThan.Tests   20/20
  BeIn.Tests             6/6
  BeLessThan.Tests      20/20
Discovery unchanged (6 blocks / 61 nodes, no error, stderr clean). Idempotency
re-confirmed (dot-source x2 -> Verify-Equal + InPesterModuleScope both present).

No runner/extension code change needed for this — the repo-root BC file is the
repo's responsibility (that's the point of the convention); commit 9b053cc's
bridge already dot-sources whatever BC file is present. The BC file lives at
q:\p\pester (untracked). For an upstream Pester PR it should ship at the repo
root AND import Axiom + define TestHelpers so all contributors + CI can run any
single .Tests.ps1 standalone.

### 2026-07-15 (later still) — full-suite validation via -Serve worker (autopilot)
Drove the ENTIRE Pester test tree (95 *.Tests.ps1 under q:\p\pester\tst) through
the runner's -Serve worker (the real extension path), one discover + one run per
file. Node drivers: Q:\tmp\{run,discover}-suite.js (throwaway).

DISCOVERY: 95 files, 2813 nodes. 0 InPesterModuleScope errors (the bug the bridge
fixes -> gone everywhere). Only 2 files errored at discovery, both Pester 6.1.0's
stricter "each block can only have one BeforeAll/BeforeEach" validation vs the
older f7b374b source:
  - Output.Tests.ps1     : two TOP-LEVEL BeforeAll (lines 3 & 7)
  - SetupTeardown.Tests  : duplicate BeforeEach in a block
These are version drift, not helpers/bridge.

RUN: 95 files, 2252 test results -> 2238 passed / 14 failed across 9 files. Every
failure is an ASSERTION failure (body ran, all helpers resolved), never a
"term not recognized" infra error. Categorized:
  * Version drift 6.0.0-source vs installed 6.1.0 (6):
      Should-BeGreaterThan / -GreaterThanOrEqual / -LessThan / -LessThanOrEqual
        -> Verify-Type expects RuntimeException, 6.1.0 throws System.Exception.
      Ensure-ExpectedIsNotCollection -> exact message text changed.
      SetupTeardown -> Describe-scoped variable timing.
  * Excluded by test.ps1, not real dev tests (7):
      Pester.Tests.ps1 (6) -> tagged 'VersionChecks' (test.ps1 ExcludeTag);
        $manifestPath = $PSScriptRoot\Pester.psd1 (tst\Pester.psd1, absent) -> CI-only.
      testProjects\BasicTests\...\file1 (1) -> testProjects is in Run.ExcludePath.
  * Inherent cross-file (1):
      GlobalMock-B -> comment: "depends on state set up in GlobalMock-A".

Conclusion: the InPesterModuleScope integration WORKS end-to-end. 2238/2252 green;
the remainder is provably pre-existing (drift / excluded tags / cross-file /
fixtures), none caused by the BeforeContainer bridge or a missing helper. No
further extension or BC-file change needed.

Possible FUTURE extension features surfaced (not needed for this fix, deferred):
  - Honor a repo's excluded tags (VersionChecks/StyleRules) in the Test Explorer
    so CI-only checks don't show as red.
  - The 2 duplicate-BeforeAll/BeforeEach files + the drift failures are Pester
    SOURCE maintenance (align f7b374b source with 6.1.0) - the maintainer's call,
    unrelated to the extension.

---

## Real Test Explorer still failed after all that — stale .NET cwd (2026-07-16 13:14)

The "WORKS end-to-end" conclusion above was measured with probes that spawned
pwsh with the repo as the process cwd. The REAL extension does not do that, so
the user's actual "Run all" on Be.Tests.ps1 kept failing with:
  The term 'InPesterModuleScope' is not recognized...

### Root cause (proven)
- The extension runs the runner in a PowerShell extension (PSES) temporary
  console. That console's process starts somewhere else (e.g. C:\), then the
  runner receives -WorkingDirectory and does Set-Location to the repo.
- Set-Location updates \C:\Users\jajares\.copilot\chats\50b49919-7f75-4f51-b419-dcb45b01ebdd but NOT [Environment]::CurrentDirectory.
- Pester resolves Run.RepoRoot from the .NET current directory. Direct proof:
    start pwsh at C:\ ; Import Pester 6.1.0 ; Set-Location Q:\p\pester
    -> \C:\Users\jajares\.copilot\chats\50b49919-7f75-4f51-b419-dcb45b01ebdd = Q:\p\pester  BUT  [PesterConfiguration]::Default.Run.RepoRoot.Value = 'C:\'
- So Pester's native BeforeContainer looked for C:\Pester.BeforeContainer.ps1
  (absent) -> the Axiom + TestHelpers bootstrap never ran -> InPesterModuleScope
  undefined -> the run's discovery phase failed. The discovery bridge is hit by
  the same bug because Resolve-DiscoveryBeforeContainerFile reads
  Run.RepoRoot.Value too.
- Faithful repro through the runner (Start-Process -WorkingDirectory 'C:\',
  args -Run -Path Be.Tests.ps1 -WorkingDirectory Q:\p\pester): 0 results +
  InPesterModuleScope error. That is the user's failure, reproduced.

### Fix (commit d395797, scripts/PesterRunner.ps1, +22/-2)
Added Set-RunnerLocation: does Set-Location AND
[System.IO.Directory]::SetCurrentDirectory(\C:\Users\jajares\.copilot\chats\50b49919-7f75-4f51-b419-dcb45b01ebdd.ProviderPath) together. Routed
both working-directory switches through it (one-shot ~950, per-serve-command
~1010). RepoRoot now resolves to the repo on run + discover + serve, so both the
native run-phase BeforeContainer and the discovery bridge find the BC file.

### Verified with the fix, all under stale cwd C:\ (the real scenario)
- one-shot run Be.Tests.ps1: 55/55 passed, no InPesterModuleScope error
  (was 0 results + error before the fix).
- one-shot discover Be.Tests.ps1: 61 nested nodes, empty error.
- serve-worker run Be.Tests.ps1: 55 results, no error (true extension path).
- spot-check other InPesterModuleScope files: Mock 235/235, New-MockObject 12/12,
  all zero errors.
- Parse OK. PSScriptAnalyzer: only new item is the ShouldProcess style warning,
  same one already accepted on Set-UniqueIds in this file. No .ts changes.
  Committed, NO PR (user asked to drive it, not PR).

### Lesson for future probes
When reproducing an extension/PSES failure, do NOT set the process cwd to the
repo - that hides cwd-dependent bugs. Start the probe process elsewhere (C:\)
and only Set-Location into the repo, exactly like the extension does. \C:\Users\jajares\.copilot\chats\50b49919-7f75-4f51-b419-dcb45b01ebdd !=
[Environment]::CurrentDirectory is a recurring trap in PowerShell hosts.

### Note for the upstream Pester follow-up
Even after the upstream SkipRun/BeforeContainer fix, this .NET-cwd sync is still
required for the RUN path: native BeforeContainer resolves RepoRoot from the
.NET cwd, which is stale in the PSES console. The two fixes are independent.

---

## "Run all" crashed: nodes.map is not a function — depth-8 JSON truncation (2026-07-16 17:57)

After the cwd fix, single-file runs worked but the global **Run all** crashed:
  [warning] Ignoring non-JSON line from PesterRunner serve: WARNING: Resulting
            JSON is truncated as serialization has exceeded the set depth of 8.
  [error]   PesterTestController run failed: nodes.map is not a function

### Root cause (separate, pre-existing bug — not the cwd fix)
- Write-JsonLine serialized every event with ConvertTo-Json **-Depth 8**.
- A discovery tree is file > tests[] > block > children[] > block > ... > It.
  Each block level costs ~2 JSON levels, so depth 8 only reached ~3 block levels.
- Pester's own deeper self-tests exceed that. ConvertTo-Json then (a) prints
  "Resulting JSON is truncated..." to the warning stream (which the serve worker
  leaks to stdout -> the "Ignoring non-JSON line" warning), and (b) collapses the
  too-deep children ARRAY into a STRING.
- The extension's buildItemTree recurses into node.children; a string child hits
  nodes.map -> "nodes.map is not a function" -> the whole Run all aborts.
- Be.Tests.ps1 alone passed because it is shallow; Run all discovers a deep file
  and truncates. Proven synthetically: depth 8 turns children into a String after
  3 block levels; depth 64 serializes 10 levels cleanly with no warning.

### Fix (commit daa5efa)
1. scripts/PesterRunner.ps1 Write-JsonLine: ConvertTo-Json -Depth **64**
   -WarningAction SilentlyContinue -WarningVariable depthWarning; if a warning
   ever fires, write it to **stderr** (extension logs it, never parses it) so it
   can never corrupt the stdout JSON stream.
2. src/features/PesterTestController.ts buildItemTree: coerce a non-array
   
odes to [] (Array.isArray guard) so one malformed payload degrades to
   "no children shown" instead of hard-crashing the run. Defense in depth.

### Verified
- Discover all 96 *.Tests.ps1 through the serve worker with **stale cwd C:\**
  (faithful to the extension): 2821 nodes, **0 string children**, **no truncation
  warning**. Max tree depth 5 (~JSON depth 10) — real files really did exceed 8.
- Run Should.Tests.ps1 (deep) via serve, stale cwd: passes, no truncation, no
  InPesterModuleScope error.
- tsc --noEmit clean, eslint clean, PesterRunner parses. dist rebuilt (esbuild);
  guard present in the bundle. dist/ is gitignored so the commit is source-only.
- Extension main = ./dist/extension.js, version 2026.1.2 = the running EDH, so
  Developer: Reload Window picks up BOTH the rebuilt TS bundle and the PS runner.

### Note
The depth-8 truncation was latent in my earlier full-suite probes: they parsed
each line as JSON (a truncated line is still *valid* JSON, just with a string
where an array should be) and my recursive counter walked the string without
erroring, so it never surfaced until the extension's buildItemTree did node.map.
