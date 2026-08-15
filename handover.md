# Handover — Pester Test Explorer + Coverage integration

**If you can read this file on the remote branch, the previous agent's push is
complete.** It is intentionally the last file committed to
`handoff/pester-test-controller`.

This document is written for the next agent picking up on a different machine.
It is self-contained: everything that lives outside this repo is either inlined
below or copied into `handover-assets/`.

---

## 1. TL;DR — current state

We built a first-class **Pester** integration for the PowerShell VS Code
extension: native Test Explorer discovery/run, debug, and code coverage, adapted
from the protocol of `pester/vscode-adapter` (Justin Grote's extension — we have
his permission, credited in commit `f8da090`).

The feature **works end to end** and has been dogfooded on the real Pester repo
(`q:\p\pester`). Three discovery/run bugs found while dogfooding are all fixed
and verified. As of the last commit the tree is green: `tsc --noEmit`, `eslint`,
and `npm run compile` all pass clean.

**Not yet done / your job:**
- Decide whether to open the PR to `PowerShell/vscode-powershell` (previous agent
  was explicitly told **not** to open a PR — see Constraints).
- Decide whether `handover.md` and `handover-assets/` should stay on the branch.
  They are internal handoff notes, roughly 1500 lines, and do not belong in an
  upstream PR.
- Optional deferred polish (honor repo excluded tags so CI-only checks don't
  render red). See Known issues.

**Do NOT open a PR or force-push without checking Section 11 (Constraints).**

### Update, 2026-08-15 (macOS session)

The "Run all" confirmation is done, and it is now covered by tests instead of by
clicking. Details in Section 16.

- Full real Pester suite through the runner, from a stale cwd: **2907 results,
  2899 passed, 4 skipped, 4 failed**, no `nodes.map` crash, no depth truncation,
  no `InPesterModuleScope` errors. The 4 failures are not ours, plain
  `Invoke-Pester` with no runner involved reproduces exactly the same 4 (three
  are source-vs-installed-6.1.0 drift, one is an intentionally failing fixture
  under `tst/testProjects`).
- New end to end suite, `npm run test:e2e`, 17 tests covering discovery, run,
  run all, line filtered runs, coverage and the Debug profile against real
  `pwsh` and real Pester.
- Unit suite is now fully green (**216 passing, 6 pending, 0 failing**) once
  PowerShellEditorServices is cloned as a sibling and built. The 10 failures the
  previous session saw were only the missing PSES checkout.
- Everything above was done on macOS. The branch needed one real fix to run
  there at all, see Section 16.

---

## 2. Where everything lives

| Thing | Location |
|---|---|
| Fork (push here) | `origin` = `https://github.com/nohwnd/vscode-powershell.git` |
| Upstream (source of truth) | `upstream` = `https://github.com/PowerShell/vscode-powershell.git` |
| Feature branch | `feature/pester-test-controller` (tracks `upstream/main`) |
| **This handoff branch** | `handoff/pester-test-controller` (branched from the feature HEAD; carries all code + this doc + assets) |
| Worktree on the previous machine | `Q:\p\vscode-powershell-trees\testcontroller` |
| The Pester repo we dogfood against | `q:\p\pester` (a **different** repo; HEAD was `f7b374b`, main) |
| Topic notes (may sync via OneDrive) | `…\OneDrive - Microsoft\Documents\Copilot\vscode-powershell-testing-api\notes.md` |

The handoff branch is **23 files / ~7516 insertions** ahead of `upstream/main`
(merge-base `25a49c6`). All the code is in those commits — see the commit log in
Section 12.

### Getting started on your machine
```powershell
git clone https://github.com/nohwnd/vscode-powershell.git
cd vscode-powershell
git fetch origin
git checkout handoff/pester-test-controller
npm install            # node_modules is gitignored
npm run compile        # builds dist/extension.js (also gitignored)
```
Then open the folder in VS Code and press **F5** (see Section 5).

---

## 3. THE CRITICAL EXTERNAL FILE — `Pester.BeforeContainer.ps1`

This is the single thing most likely to trip you up. The Pester **self-tests**
(e.g. `Be.Tests.ps1`) call helpers such as `InPesterModuleScope`, `Verify-Equal`,
`New-Dictionary` that are **not** defined inside the `.Tests.ps1` files — Pester's
own `test.ps1` sets them up for the parent session. When the Test Explorer
discovers/runs a single file in isolation, those helpers are missing and
discovery fails with:

```
The term 'InPesterModuleScope' is not recognized as a name of a cmdlet, function, ...
```

The fix is a `Pester.BeforeContainer.ps1` file placed **at the Pester repo root**
(`q:\p\pester\Pester.BeforeContainer.ps1`). Pester's `BeforeContainer` feature
dot-sources it into the run session state before each container is discovered/run,
so an isolated file sees the same helpers as a full `./test.ps1`.

**It is untracked in the Pester repo** (it's not committed upstream yet — see
Section 10), so it can't ride along in this vscode-powershell branch. **You must
recreate it at your Pester repo root.** A copy is in
`handover-assets/Pester.BeforeContainer.ps1`; the full content is also inlined
here so this doc stands alone:

```powershell
# Pester.BeforeContainer.ps1
#
# Drop this at the repository root (Run.RepoRoot, i.e. next to the .git dir -
# q:\p\pester\Pester.BeforeContainer.ps1). Pester (with the BeforeContainer
# feature) dot-sources it into the run session state BEFORE each test container
# is discovered and run, in both sequential and parallel runs.
#
# It reproduces the two helper sets that test.ps1 sets up for the parent session,
# so a single .Tests.ps1 file discovered/run in isolation - e.g. from the VS Code
# Test Explorer - sees the same helpers as a full ./test.ps1 run:
#   1. Axiom       - the Verify-* assertion helpers (tst/axiom/Axiom.psm1) that
#                    virtually every Pester self-test calls (Verify-Equal, ...).
#   2. TestHelpers - InPesterModuleScope / New-Dictionary / Clear-WhiteSpace,
#                    used at discovery time in several assertion tests.
#
# Dot-sourced by path, so $PSScriptRoot is the repo root here (true for both
# Pester's native BeforeContainer and the VS Code runner's discovery bridge).
# Idempotent: -Force re-import and the Remove-Module guard make it safe to run
# before EACH container (and before every -Serve discovery command).

# 1. Axiom - Verify-* helpers. Mirrors test.ps1:
#    Import-Module $PSScriptRoot/tst/axiom/Axiom.psm1 -DisableNameChecking
$axiomModule = "$PSScriptRoot/tst/axiom/Axiom.psm1"
if (Test-Path -LiteralPath $axiomModule) {
    Import-Module $axiomModule -DisableNameChecking -Force
}

# 2. TestHelpers - mirrors the New-Module block in test.ps1.
Get-Module TestHelpers | Remove-Module -Force -ErrorAction SilentlyContinue
New-Module -Name TestHelpers -ScriptBlock {
    function InPesterModuleScope {
        [CmdletBinding()]
        param (
            [Parameter(Mandatory = $true)]
            [scriptblock]
            $ScriptBlock
        )

        $module = Get-Module -Name Pester -ErrorAction Stop
        . $module $ScriptBlock
    }

    function New-Dictionary ([hashtable]$Hashtable) {
        $d = [System.Collections.Generic.Dictionary[string, object]]::new()
        $Hashtable.GetEnumerator() | ForEach-Object { $d.Add($_.Key, $_.Value) }

        $d
    }

    function Clear-WhiteSpace ($Text) {
        "$($Text -replace "(`t|`n|`r)"," " -replace "\s+"," ")".Trim()
    }
} | Out-Null
```

Notes:
- If you dogfood against a **different** repo than Pester, you don't need this
  file at all — it is specific to Pester's self-tests. For any normal user's test
  suite the feature works without it.
- The first draft had only `TestHelpers` and discovery worked but the RUN failed
  on `Verify-Equal`; adding the Axiom import fixed the run. Keep both blocks.

---

## 4. Environment requirements

- **Pester ≥ 6.1.0** installed and picked up by `Get-CompatiblePester`
  (it selects the highest `-ListAvailable` ≥ 5.0). 6.1.0 is required because it
  ships the **`BeforeContainer`** feature the fix relies on. On the previous
  machine: `C:\Users\jajares\OneDrive - Microsoft\Documents\PowerShell\Modules\Pester\6.1.0`.
  If your machine resolves an older Pester, the `InPesterModuleScope` path won't
  work.
- **PowerShell 7.6.3** (any recent 7.x is fine).
- **VS Code 1.126.0** (or newer).
- **Node** for the extension build (`npm install`).
- We deliberately **gave up** on loading a locally-built Pester from the source
  tree: the extension autoloads the installed Pester as soon as it sees `It`, and
  we can't rebuild Pester's C# assemblies to match, so a source Pester conflicts
  in the built-in session. Use the **installed** Pester ≥ 6.1.0. (This was a
  user decision — don't reopen it without asking.)

---

## 5. Build / run / iterate

- **Bundler:** esbuild bundles `src/extension.ts` → `dist/extension.js`
  (`npm run compile`). esbuild does **not** type-check.
- **Type-check separately:** `node_modules\.bin\tsc.cmd --noEmit -p tsconfig.json`
- **Lint:** `node_modules\.bin\eslint.cmd src test --ext .ts`
- **Unit tests:** `npm test` (vscode-test; downloads/launches a VS Code instance).
- **Run the feature:** press **F5** → "Run Extension" launches an Extension
  Development Host. `.vscode/launch.json` opens the EDH on `q:/p/pester` with
  `--extensionDevelopmentPath` + `--disable-extensions`, and runs the `compile`
  task first (`.vscode/tasks.json`). Both files are in this branch.
- **Fast inner loop after editing TS or the PS runner:** a plain
  **"Developer: Reload Window"** in the EDH reloads both the rebuilt bundle and
  the PowerShell runner script. Extension `main` = `./dist/extension.js`
  (version `2026.1.2`), so a compile + reload is all it takes.
- `dist/` and `node_modules/` are **gitignored** — the branch is source-only.
  After clone you MUST `npm install && npm run compile` before F5.

---

## 6. Feature architecture (what was built)

Two moving parts: a TypeScript controller in the extension, and a PowerShell
runner script the controller spawns.

- **`src/features/PesterTestController.ts`** (~1711 lines) — the VS Code
  `TestController`. Highlights:
  - **Eager AST discovery** (`src/features/pesterAstDiscovery.ts`): parses
    `*.Tests.ps1` with the PowerShell AST to populate the tree instantly, before
    the runner has spoken. This is the fallback when runner discovery is empty.
  - `discoverFile` (~line 313 / decision at ~382): merges AST results with runner
    results via `decideDiscoveryOutcome` (~line 1530), a **pure** function:
    - `tests present` → runner is authoritative.
    - `empty + error` → keep the AST tree (`astFallback`), do **not** mark
      discovered, and surface the error on the file item.
    - `empty + no error` → trust the runner (genuinely empty file).
  - `buildItemTree` (~line 1581) — turns the runner's node tree into VS Code test
    items. **Has an `Array.isArray(nodes)` guard** (see Fix 3).
  - Run handler (~line 577 calls `buildItemTree`; run path ~600–664),
    `createDefaultRunnerInvoker` (~line 1334) loads `scripts/PesterRunner.ps1`.
  - Coverage: `loadDetailedCoverage` wired for inline decorations; JaCoCo XML
    parsed by the coverage parser (commit `a9207e2`, `e308a76`).
- **`scripts/PesterRunner.ps1`** (~1068 lines) — the runner the extension spawns.
  Speaks a line-delimited JSON protocol on stdout (one JSON object per line; see
  Section 7). Modes: one-shot `-Discover`, one-shot run, and a persistent
  `-Serve` worker that accepts discover/run commands on stdin (fast repeated
  discovery without paying PowerShell startup each time). Key functions:
  - `Write-JsonLine` (line 95) — serializes protocol events (see Fix 3).
  - `Set-RunnerLocation` (line 155) — sets cwd correctly (see Fix 2).
  - `Set-UniqueIds` (line 453) / `Get-ContainerDiscoveryError` (line 492) —
    id dedup + error surfacing (see the "earlier fixes" note below).
  - `Resolve-DiscoveryBeforeContainerFile` (line 799) +
    `Invoke-RunnerDiscover` (line 823) — the BeforeContainer discovery bridge
    (see Fix 1). `Invoke-RunnerRun` (line 870) relies on native BeforeContainer.

The runner is shipped inside the packaged VSIX (commit `184fc42`).

---

## 7. Runner protocol (so you can debug it standalone)

`scripts/PesterRunner.ps1` writes **one JSON object per line** to stdout. Each
line has a `type`. The controller reads them and mutates the test tree. Rough
event shapes:

- `file`  — a discovered container: `{ type:'file', path, tests:[…node tree…], error?:string }`
  where each node is `{ id, label, type:'block'|'it', line, children?:[…] }`.
- `result` — a run outcome for one test: `{ type:'result', id, outcome:'passed'|'failed'|'skipped', duration, message?, … }`.
- Coverage / summary lines for the run.

You can run it by hand to see the stream. The important part for reproducing the
cwd bug is to **spawn it from a directory that is NOT the repo** and pass
`-WorkingDirectory` (Section 9), exactly like the extension does.

---

## 8. The bugs fixed this session (root cause → fix → verification)

Earlier fixes (previous sessions, already on the branch) — for context:
- **Duplicate test-item ids** for `-ForEach`/`-TestCases` (`Get-TestId` stringified
  data; `@(1)` and `1` both → `"1"`). Fixed with a global per-file dedup pre-pass
  (`Set-UniqueIds`). Commits `308e68e`, `4fa4f8f`.
- **Discovery errors silently swallowed** — `Get-ContainerDiscoveryError` now
  emits the container's error on the `file` event; the controller surfaces it on
  the file item for every outcome.

### Fix 1 — BeforeContainer never applied at discovery (commit `9b053cc`)
- **Symptom:** `InPesterModuleScope` tests showed via AST but discovery/run
  through the runner failed with "term not recognized".
- **Root cause:** discovery-only mode (`Run.SkipRun`, which the Test Explorer
  uses) **early-returns in `Invoke-Test` BEFORE Pester's native BeforeContainer
  dot-source**, so `Pester.BeforeContainer.ps1` was never applied at discovery.
  The RUN path applied it fine.
- **Fix:** `Resolve-DiscoveryBeforeContainerFile` + a dot-source of the repo-root
  `Pester.BeforeContainer.ps1` inside `Invoke-RunnerDiscover` (covers `-Discover`
  and `-Serve`). The BC file must be **idempotent** because `-Serve` re-runs it.
- **Verified:** `Be.Tests.ps1` discovers 6 blocks / 61 nodes AND runs 55/55.

### Fix 2 — stale .NET current directory (commit `d395797`)  ← subtle, read this
- **Symptom:** the REAL "Run all" in the extension still failed with
  `InPesterModuleScope not recognized`, even though standalone probes passed.
- **Root cause:** `Set-Location` updates `$PWD` **but NOT**
  `[Environment]::CurrentDirectory` (the .NET process cwd). Pester resolves
  `Run.RepoRoot` from the **.NET cwd**. The extension launches the runner in a
  PSES temporary console that starts at e.g. `C:\`, then the runner does
  `Set-Location $WorkingDirectory`. So `$PWD` = the repo but
  `Run.RepoRoot.Value` = `C:\` → native BeforeContainer looked for
  `C:\Pester.BeforeContainer.ps1` (absent) → helper never defined. The discovery
  bridge (which reads `Run.RepoRoot.Value`) hit the same wrong root.
- **Fix:** `Set-RunnerLocation` (line 155) sets **both** `$PWD` (via
  `Set-Location`) **and** `[System.IO.Directory]::SetCurrentDirectory(...)`.
  Called at both `Set-Location` sites (one-shot ~950 and per-serve-command
  ~1013). RepoRoot now resolves correctly on run + discover + serve.
- **Verified under stale cwd `C:\`:** one-shot run Be 55/55; one-shot discover Be
  61 nodes / no error; serve run Be 55 / no error; Mock 235/235;
  New-MockObject 12/12 — zero `InPesterModuleScope` errors.
- **Note:** even after the upstream Pester fix (Section 10), this .NET-cwd sync is
  still required for the RUN path in the PSES console.

### Fix 3 — "Run all" crash: `nodes.map is not a function` (commit `daa5efa`)
- **Symptom:** single-file runs were fine, but global "Run all" crashed with
  `PesterTestController run failed: nodes.map is not a function`, preceded by
  `WARNING: Resulting JSON is truncated as serialization has exceeded the set
  depth of 8`.
- **Root cause:** `Write-JsonLine` used `ConvertTo-Json -Depth 8`. A discovery
  tree nests `file > tests[] > block > children[] > … > It` (~2 JSON levels per
  block), so depth 8 only reached ~3 block levels. In deeper self-test files the
  too-deep `children` array collapsed into a **String**, and the controller's
  `buildItemTree` did `nodes.map(...)` on a string → threw → aborted the whole
  run. `Be` alone is shallow, so single-file passed; "Run all" hit a deep file.
- **Fix:**
  1. `PesterRunner.ps1` `Write-JsonLine` → `-Depth 64 -WarningAction
     SilentlyContinue -WarningVariable depthWarning`, and any depth warning is
     routed to **stderr** (logged, not parsed) so it can never corrupt the JSON
     stream on stdout.
  2. `PesterTestController.ts` `buildItemTree` coerces a non-array `nodes` to `[]`
     (`Array.isArray` guard) as belt-and-suspenders.
- **Verified:** discovered all 96 `*.Tests.ps1` via the serve worker with stale
  cwd `C:\` → 2821 nodes, 0 string children, no truncation warning (real files do
  exceed depth 8). `Should.Tests.ps1` (deep) runs green. `tsc` + `eslint` clean,
  `dist` rebuilt, guard confirmed in the bundle.

---

## 9. Faithful stale-cwd reproduction technique (reuse this!)

The trap that cost the most time: if you spawn a probe with the **repo as the
process cwd**, the bug **hides** (because `[Environment]::CurrentDirectory` is
already the repo). To reproduce extension/PSES cwd bugs faithfully:

```powershell
# Start the probe process somewhere that is NOT the repo, then pass the repo
# only via -WorkingDirectory, so the runner does Set-Location just like the
# extension does inside the PSES temporary console.
Start-Process pwsh -WorkingDirectory 'C:\' -ArgumentList @(
  '-NoProfile','-File','scripts\PesterRunner.ps1',
  '-WorkingDirectory','Q:\p\pester', '<discover|run args>'
)
```

Remember: **`$PWD` ≠ `[Environment]::CurrentDirectory`.** Whenever something in
the runner resolves paths from the .NET cwd (Pester's `Run.RepoRoot` does), the
gap between those two is the first thing to check.

---

## 10. Upstream Pester follow-up (Jakub owns)

The real cure for Fix 1 lives in Pester itself:
- In `src/Pester.Runtime.ps1`, dot-source `$BeforeContainerInit` in the
  **`Run.SkipRun`** branch of `Invoke-Test`, **before** `Discover-Test`, so
  discovery-only mode applies BeforeContainer like the run path does.
- Ship `Pester.BeforeContainer.ps1` (Axiom + TestHelpers) at the
  `pester/Pester` repo root so all contributors + CI get the helpers.
- **Even with that upstream fix, Fix 2 (the .NET-cwd sync in the runner) is still
  needed** for the RUN path's native BeforeContainer to resolve `RepoRoot` inside
  the PSES console.

This is a separate PR against `pester/Pester`, not part of this branch.

---

## 11. Constraints (please respect)

- **Do NOT open a PR** unless the user explicitly says so. The previous agent was
  told to drive the work, not to open a PR. This is a handoff, so confirm intent
  before creating one against `PowerShell/vscode-powershell`.
- **Never force-push.** Add commits on top. We squash-merge, so intermediate
  commit history collapses on merge anyway; plain pushes avoid the conflicts a
  rewritten branch causes.
- **Never commit to `main`; never work directly in the main checkout** — use a
  git worktree (`../vscode-powershell-trees/<name>`).
- **Attribution:** the runner protocol is adapted from `pester/vscode-adapter`
  (Justin Grote), with his permission; credited in commit `f8da090`. Keep that
  credit.
- **Commit trailer used on this branch** (keep it consistent):
  `Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>`
- Robot emoji `🤖` only on **published** content (PR descriptions, issue
  comments, release notes), never on CLI replies. Write any PR/commit text in
  Jakub's plain, literal voice (no marketing adjectives, no "This PR does X"
  boilerplate for small changes).

---

## 12. Commit log (this branch, newest first, above `upstream/main`)

```
212f059 Add dev launch config and handoff asset bundle
daa5efa Stop "Run all" crashing on deeply-nested test files      (Fix 3)
d395797 Sync .NET current directory when the runner switches working directory (Fix 2)
9b053cc Load repo-root Pester.BeforeContainer.ps1 before discovery (Fix 1)
4fa4f8f Fix Test Explorer discovery: dedup AST-path ids, treat .Tests.ps1 as a hint
308e68e Fix Test Explorer discovery: dedup ids, surface errors, keep AST on failure
95d9ad0 Satisfy stricter upstream eslint rules after rebase
f8da090 Credit pester/vscode-adapter for the adapted runner protocol
e308a76 Wire loadDetailedCoverage so inline coverage decorations work
c7524b9 Surface Pester -Tag values in AST discovery and dump effective config
4474b9a Run the Debug profile through our runner protocol
184fc42 Ship the Pester runner scripts in the packaged VSIX
30836b9 Close the last three pester/vscode-adapter setting gaps
eb7dbe7 Declare the four new powershell.pester settings in package.json
b10a81d Match pester/vscode-adapter feature parity in the Pester TestController
e78d009 Stop yielding to pester/vscode-adapter for Test Explorer registration
bce8672 Test collectFilterLines and the findDescendant* helpers
0cf3e6b Add eager AST discovery, persistent worker, and line-filtered runs
9129553 Tests and fixtures for runner, parser, and controller
5f34d6b Wire up the Pester TestController feature
a9207e2 Add Pester runner script and JaCoCo coverage parser
```
Merge-base with `upstream/main`: `25a49c6`. ~7516 insertions across 23 files.

---

## 13. Known remaining issues (pre-existing, not blockers)

- **Version drift** between the `q:\p\pester` source (`f7b374b`) and the installed
  Pester 6.1.0 causes ~6–14 assertion failures in a full-suite self-test run
  (exception type/message drift, the excluded `VersionChecks` tag, a cross-file
  `GlobalMock` dependency). **None** are "term not recognized" and none are caused
  by our bridge or a missing helper — they're expected when source ≠ installed.
- A couple of self-test files hit 6.1.0's stricter duplicate `BeforeAll`/
  `BeforeEach` validation (again version drift).
- **prettier** flags `pesterAstDiscovery.ts` / `pesterAstDiscovery.test.ts`
  (pre-existing formatting, not ours).
- **2 pre-existing `LanguageModelTools` unit-test failures** — unrelated to this
  feature.
- **Optional deferred feature:** honor the repo's excluded tags
  (`VersionChecks` / `StyleRules`) so CI-only checks don't render red in the Test
  Explorer.

---

## 14. Verification checklist for you

1. `npm install && npm run compile` → `dist/extension.js` builds.
2. `node_modules\.bin\tsc.cmd --noEmit -p tsconfig.json` → exit 0.
3. `node_modules\.bin\eslint.cmd src test --ext .ts` → exit 0.
4. Recreate `Pester.BeforeContainer.ps1` at your Pester repo root (Section 3).
5. Confirm `Get-Module Pester -ListAvailable` resolves **≥ 6.1.0**.
6. **F5** → Extension Development Host on your Pester repo.
7. In the EDH, open `Be.Tests.ps1`, run it → expect ~55 passing, no
   `InPesterModuleScope` error.
8. **Run all** on the whole `tst` suite → the tree populates (thousands of
   nodes), no `nodes.map` crash, no depth-8 truncation warning. Assertion
   failures from version drift (Section 13) are expected and fine.

---

## 15. What's in `handover-assets/`

- `Pester.BeforeContainer.ps1` — the external file to place at your Pester repo
  root (Section 3).
- `session-plan.md` — the previous agent's structured plan for this session.
- `session-notes.md` — the full working notes (long, detailed history of every
  probe and decision). Dig in here if a summary above isn't enough.

Good luck. The hard, subtle bugs (Fix 2's `$PWD` vs `.NET` cwd, Fix 3's depth
truncation) are done and verified — you're mostly at "confirm live + decide on
the PR".

---

## 16. Test suites and the dev loop (added 2026-08-15)

### Two suites

| Command | What it is |
|---|---|
| `npm test` | Unit suite. Pure helpers with canned payloads, plus the extension-host tests that were already there. Fast. Unchanged CI behaviour. |
| `npm run test:e2e` | End to end suite. Real `pwsh`, real installed Pester, real `PesterRunner.ps1`, real `TestController`. Nothing stubbed. |
| `npm run test:all` | Both. |

`.vscode-test.mjs` now exports two configs (`unit` and `e2e`) because the E2E
tests need their own workspace folder. E2E files are named `*.e2e.ts` so the
unit glob cannot pick them up, and `npm test` still runs only the unit suite so
CI behaves exactly as before.

### What the E2E suite covers

`test/e2e/pesterTestController.e2e.ts`, 17 tests: file enumeration, block/test
tree, source ranges, deep nesting, `-ForEach` id disambiguation, the
BeforeContainer bridge, discovery-error surfacing, broken-file isolation,
pass/fail/skip outcomes, assertion messages, durations, line filtered runs
(single test and single block), run all, the Debug profile via the `-EventLog`
sidecar, and coverage including `loadDetailedCoverage`.

`test/e2e/harness.ts` uses the `controllerFactory` seam to keep the
`TestController` the feature creates, and proxies `createRunProfile` and
`createTestRun` so a test can read the tree and every outcome call. The fixture
workspace sets `powershell.pester.useTestController: false` so the extension's
own controller does not race the test's, and
`test/features/PesterTestController.test.ts` covers the activation wiring the
seam therefore bypasses.

### The fixtures are the regressions

`test/fixtures/pester-e2e/` is deliberately awkward. `Deep.Tests.ps1` has seven
nested blocks (the depth-8 truncation), `ForEach.Tests.ps1` has `1`, `'1'` and
`1.0` colliding on one id, `Helper.Tests.ps1` needs a helper that only exists in
`Pester.BeforeContainer.ps1` at discovery time (standing in for
`InPesterModuleScope` without needing the Pester source tree), and
`Broken.Tests.ps1` fails discovery on purpose.

Because the fixtures are in the repo, F5 works on any machine now.
`.vscode/launch.json` opens that folder instead of the old hardcoded
`q:/p/pester`.

### Confirming the tests are real

A green suite that never ran anything looks identical to a green suite that
did. To check, put `-Depth 8` back in `Write-JsonLine` and delete
`test/fixtures/pester-e2e/Pester.BeforeContainer.ps1`, then run
`npm run test:e2e`. Exactly four tests should fail (the two depth ones and the
two BeforeContainer ones) and the other ten should stay green. Put both back and
it returns to 17 green. Worth redoing if you ever suspect the suite has gone
hollow.

### Faster loop than VS Code

For runner-side work you do not need VS Code at all. Drive
`scripts/PesterRunner.ps1` directly, spawning from a directory that is **not**
the repo and passing the repo only via `workingDirectory`, which is what the
extension does (the serve worker is spawned with no `cwd`). That reproduces the
stale .NET cwd conditions faithfully and a discover/run cycle costs seconds. See
Section 9 for the technique.

### Getting PSES so the unit suite is green

The 10 failures the previous session recorded were only a missing PSES
checkout. Clone it as a sibling of this worktree and build:

```powershell
git clone https://github.com/PowerShell/PowerShellEditorServices.git ../PowerShellEditorServices
Invoke-Build Build -Configuration Debug   # creates the modules/ symlink and builds PSES
```

After that `npm test` is 216 passing, 6 pending, 0 failing, and
`Invoke-Build Test` (Lint + format + Build + Test, which is what CI runs) is
green.

### macOS

The branch needed one real fix to run there. `@vscode/test-electron` 2.5.2
assumes the macOS binary is `Contents/MacOS/Electron`; VS Code renamed it to the
product name and Insiders dropped the compatibility symlink, so every test run
died with `ENOENT` before a single test executed. Bumped to 3.1.0.

Note the Azure Artifacts mirror returns 401 for tarballs it has not mirrored
yet, and because these are `optionalDependencies` npm swallows that and leaves
the package out of `node_modules` without failing the install. If a dependency
seems installed per the lockfile but is missing on disk, that is why.

Everything else in the branch was already portable. Discovery, run, run all,
coverage and debug all work on macOS with no other change.
