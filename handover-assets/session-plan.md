# Pester Test Explorer — discovery bug fixes (dogfooding)

Worktree: Q:\p\vscode-powershell-trees\testcontroller
Branch: feature/pester-test-controller (fork nohwnd/vscode-powershell)
Topic notes: C:\Users\jajares\OneDrive - Microsoft\Documents\Copilot\vscode-powershell-testing-api\

NOTE: Rebase onto upstream/main + Justin-Grote attribution were done in EARLIER
sessions (commits f8da090, 95d9ad0). This session = 3 discovery bug fixes found
while dogfooding on q:\p\pester.

## Bugs reported by user (all reproduced + fixed)
1. InPesterModuleScope { } tests dont show in Test Explorer + dont run.
   Root cause: empty runner discovery wiped the eager-AST tree AND permanently
   suppressed AST refill (runnerDiscovered). InPesterModuleScope is a Pester
   repo-private helper (defined in Pesters test.ps1), undefined standalone,
   so discovery legitimately fails for those files.
2. "Attempted to insert a duplicate test item ID" for -ForEach/-TestCases.
   Root cause: Get-TestId stringifies ForEach data; @(1) and 1 both -> "1".
3. (found while fixing) Emit-Discovery ignored container Result/ErrorRecord and
   silently emitted 0 tests with no error signal.

## Fixes (all COMPLETE + VERIFIED green)
- [x] Fix B (runner id uniqueness): global per-file dedup pre-pass.
      Set-UniqueIds (deterministic DFS) + Get-UniqueId + Resolve-DuplicateIds
      (+Get-WalkItems). Discovery ids == run ids (separate pwsh procs), zero dups.
- [x] Fix D (surface discovery errors): Get-ContainerDiscoveryError -> emits
      error on the file event; FileEvent.error?: string added.
- [x] Fix A (controller): decideDiscoveryOutcome(tests, error) pure fn +
      rewritten discoverFile — empty+error => keep AST (astFallback), dont mark
      discovered; empty+no-error => trust runner; tests => authoritative. Error now
      surfaced on file item for EVERY outcome (partial failures too) via
      formatDiscoveryError.
- [x] 5 regression tests for decideDiscoveryOutcome.
- [x] compile OK, tsc OK, lint OK, test => 210 passing (+5), 6 pending,
      2 failing = pre-existing LanguageModelTools (unrelated).
- [x] Verified users exact repros: Should-All (dup ids gone), Should-Throw
      (39 tests, dup ids gone, partial error surfaced), Be (InPesterModuleScope
      error surfaced, AST tests stay visible).

## InPesterModuleScope RUN+DISCOVER — RESOLVED via BeforeContainer bridge
The show-but-not-run limitation is GONE. Root cause was a Pester bug: discovery
-only mode (Run.SkipRun, used by the Test Explorer) early-returns in Invoke-Test
BEFORE the BeforeContainer dot-source, so `Pester.BeforeContainer.ps1` was never
applied at discovery. The RUN path applied it fine.
- [x] Runner bridge (commit 9b053cc, scripts/PesterRunner.ps1 +39):
      Resolve-DiscoveryBeforeContainerFile + dot-source repo-root
      Pester.BeforeContainer.ps1 in Invoke-RunnerDiscover (covers -Discover and
      -Serve). Idempotent BC file required (Serve re-runs).
- [x] Placed q:\p\pester\Pester.BeforeContainer.ps1 (untracked) mirroring
      test.ps1: imports Axiom (Verify-* helpers) AND defines TestHelpers
      (InPesterModuleScope). Only affects extension runner (6.1.0); old local
      build ignores it. (First draft had only TestHelpers -> discovery worked but
      RUN failed on Verify-Equal; adding Axiom fixed the run.)
- [x] Verified on REAL q:\p\pester: Be.Tests.ps1 discovers 6 blocks / 61 nodes
      AND runs 55/55 passed. Also BeGreaterThan 20/20, BeIn 6/6, BeLessThan
      20/20. TS suite 219 passing / 6 pending / 2 pre-existing (PS-only change).
- [x] Confirmed bug live upstream pester/Pester main (bea8b87).
- [x] Corrected BeforeContainer framing in notes.md + appended full segment.

## Full-suite validation (autopilot, 2026-07-15) — WORKS
Drove all 95 *.Tests.ps1 under q:\p\pester\tst through the -Serve worker.
- [x] Discover: 2813 nodes, 0 InPesterModuleScope errors (2 files hit 6.1.0's
      stricter duplicate-BeforeAll/BeforeEach validation = version drift).
- [x] Run: 2238 passed / 14 failed (9 files). ALL 14 are assertion failures,
      none "term not recognized". Categorized: 6 version drift (exception type/
      message/scoping), 6 excluded VersionChecks tag (Pester.Tests.ps1, CI-only),
      1 excluded testProjects fixture, 1 cross-file dep (GlobalMock-B needs -A).
      Zero caused by the bridge or a missing helper.
- [x] Notes updated with the full categorization.

## Real Test Explorer STILL failed — root cause: stale .NET cwd (FIXED, commit d395797)
The full-suite validation above passed because my probes spawned pwsh with the
repo as the process cwd. The REAL extension does NOT: it launches the runner in
a PSES temporary console that starts elsewhere (e.g. C:\), then passes
-WorkingDirectory and the runner does Set-Location. User's real "Run all" on
Be.Tests.ps1 kept failing: "The term 'InPesterModuleScope' is not recognized".
- Root cause: Set-Location updates $PWD only, NOT [Environment]::CurrentDirectory.
  Pester resolves Run.RepoRoot from the .NET cwd. Proven: start pwsh at C:\,
  Set-Location Q:\p\pester -> $PWD=repo but RepoRoot.Value='C:\'. So native
  BeforeContainer looked for C:\Pester.BeforeContainer.ps1 (absent) -> helper
  never defined -> run's discovery phase failed. The discovery bridge was hit
  by the same bug (it reads Run.RepoRoot.Value).
- Reproduced faithfully through the runner (Start-Process -WorkingDirectory C:\,
  pass -WorkingDirectory Q:\p\pester): 0 results + InPesterModuleScope error.
- Fix (scripts/PesterRunner.ps1, +22/-2): Set-RunnerLocation helper sets $PWD
  AND [System.IO.Directory]::SetCurrentDirectory together; used at both
  Set-Location sites (one-shot 950, per-serve-command 1010). RepoRoot now
  resolves correctly on run + discover + serve, so native BeforeContainer (run)
  and the discovery bridge both find the file.
- [x] Verified with the fix under stale cwd (C:\) on all 3 paths: one-shot run
      Be 55/55, one-shot discover Be 61 nodes / no error, serve run Be 55 / no
      error. Spot-check: Mock 235/235, New-MockObject 12/12 (all stale cwd, zero
      InPesterModuleScope errors).
- [x] Parse OK; PSScriptAnalyzer only adds the same ShouldProcess style warning
      already accepted on Set-UniqueIds. No TS files touched (no src refs to
      Set-Location/RepoRoot). Committed d395797, NO PR (per user).
- [x] USER CONFIRMED cwd fix: Be.Tests.ps1 opened fine; the InPesterModuleScope
      error is gone. But the global "Run all" then hit a DIFFERENT crash (below).

## "Run all" crashed: nodes.map is not a function — depth-8 truncation (FIXED, commit daa5efa)
Separate pre-existing bug, exposed only by Run all (needs a deep file).
- Symptoms: "WARNING: Resulting JSON is truncated ... depth of 8" leaked to
  stdout, then "PesterTestController run failed: nodes.map is not a function".
- Root cause: Write-JsonLine used ConvertTo-Json -Depth 8. A discovery tree is
  file > tests[] > block > children[] > ... > It (~2 JSON levels per block), so
  depth 8 only covered ~3 block levels. Deeper self-tests truncated: the too-deep
  `children` array became a STRING, and buildItemTree's nodes.map threw on it,
  aborting the whole run. Be alone is shallow, so single-file passed.
- Fix daa5efa: (1) PesterRunner.ps1 Write-JsonLine -> -Depth 64 +
  -WarningAction SilentlyContinue + -WarningVariable; any warning goes to stderr
  (logged, not parsed) so it can't corrupt the JSON stream. (2)
  PesterTestController.ts buildItemTree coerces a non-array nodes to [] (guard).
- [x] Verified: discover all 96 files via serve worker with stale cwd C:\: 2821
      nodes, 0 string children, no truncation warning (max tree depth 5 ~ JSON 10,
      so real files did exceed 8). Run Should.Tests.ps1 (deep): passes, no
      truncation, no InPesterModuleScope error. tsc + eslint clean; dist rebuilt;
      guard in bundle; dist/ gitignored so commit is source-only. main =
      ./dist/extension.js v2026.1.2 = running EDH, so Reload Window loads both.
- [ ] USER TO CONFIRM: Developer: Reload Window, then Run all (whole suite).

## Remaining
- [x] Housekeeping: temp probe files removed; only unrelated pester-open-prs.json
      left in Q:\tmp (not mine).
- [ ] (Follow-up, Jakub owns) Upstream Pester PR: dot-source $BeforeContainerInit
      in the Run.SkipRun branch of Invoke-Test (src/Pester.Runtime.ps1) before
      Discover-Test; ship Pester.BeforeContainer.ps1 (Axiom + TestHelpers) at
      pester/Pester root for all contributors + CI.
      NOTE: even with that upstream fix, the .NET-cwd sync is still needed for the
      RUN path's native BeforeContainer to resolve RepoRoot in the PSES console.
- [ ] (Optional extension feature, deferred) Honor repo excluded tags
      (VersionChecks/StyleRules) so CI-only checks don't render red.
- [ ] (Pre-existing, not mine) prettier flags pesterAstDiscovery.ts/.test.ts.
