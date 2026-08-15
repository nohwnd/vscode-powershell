// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { parseJaCoCoXml, resolveCoverageSources } from "../coverage/jacoco";
import { toFileCoverage } from "../coverage/vscodeAdapter";
import type { ILogger } from "../logging";
import {
    discoverViaDocumentSymbols,
    extractPesterBlocksFromText,
    ID_SEP,
    isPesterTestDocument,
} from "./pesterAstDiscovery";
import { PersistentPesterRunnerInvoker } from "./pesterPersistentInvoker";
import {
    ChildProcessPesterRunnerInvoker,
    type IPesterRunnerInvoker,
    type PesterTestNode,
    type ResultEvent,
    type RunnerEvent,
} from "./pesterRunnerInvoker";
import vscode = require("vscode");

/**
 * Native VS Code Test Explorer integration for Pester.
 *
 * Registers a `TestController` that:
 *   - Discovers `*.Tests.ps1` files in the workspace and lazily expands each
 *     into its Describe/Context/It tree on demand (or on first run).
 *   - Exposes three `TestRunProfile`s: Run, Debug, Coverage. Run and Coverage
 *     execute via `PesterRunner.ps1`; Debug delegates to the existing
 *     `PowerShell.RunPesterTests` command (PSES launches the debugger).
 *   - Subscribes to `*.Tests.ps1` create/change/delete events so the tree
 *     stays in sync without a full re-discovery.
 *
 * Discovery is **lazy**. The controller only adds top-level file `TestItem`s
 * up front; it does not invoke Pester until VS Code calls `resolveHandler`
 * for a specific file, or until a run is requested. This avoids running Pester
 * across the whole workspace at activation time.
 */
export class PesterTestController implements vscode.Disposable {
    /** Makes each debug session's `__pesterRunId` marker unique. */
    private static debugRunCounter = 0;

    private readonly controller: vscode.TestController;
    private readonly disposables: vscode.Disposable[] = [];
    private readonly fileItems = new Map<string, vscode.TestItem>();
    /**
     * Files whose children were filled in by the real `PesterRunner.ps1`
     * discovery (rather than our cheaper AST symbol parse). We avoid stomping
     * on those with the AST best-guess afterwards.
     */
    private readonly runnerDiscovered = new Set<string>();
    /** Pending debounce timers per file for `onDidChangeTextDocument`. */
    private readonly astDebounce = new Map<string, NodeJS.Timeout>();
    /** Per-run coverage details keyed by `FileCoverage` reference for `loadDetailedCoverage`. */
    private readonly coverageDetails = new Map<
        vscode.FileCoverage,
        vscode.FileCoverageDetail[]
    >();

    constructor(
        private readonly invoker: IPesterRunnerInvoker,
        private readonly logger: ILogger,
        controllerFactory: (
            id: string,
            label: string,
        ) => vscode.TestController = vscode.tests.createTestController,
    ) {
        this.controller = controllerFactory("powershell-pester", "Pester");
        this.disposables.push(this.controller);

        this.controller.resolveHandler = (item): Promise<void> =>
            this.resolveHandler(item);
        this.controller.refreshHandler = (): Promise<void> => this.refreshAll();

        this.controller.createRunProfile(
            "Run",
            vscode.TestRunProfileKind.Run,
            (request, token): Promise<void> =>
                this.runOrCoverage(request, token, false),
            true,
            undefined,
            true,
        );

        this.controller.createRunProfile(
            "Debug",
            vscode.TestRunProfileKind.Debug,
            (request, token): Promise<void> => this.debug(request, token),
            true,
            undefined,
            true,
        );

        const coverageProfile = this.controller.createRunProfile(
            "Run with Coverage",
            vscode.TestRunProfileKind.Coverage,
            (request, token): Promise<void> =>
                this.runOrCoverage(request, token, true),
            true,
            undefined,
            true,
        );
        coverageProfile.loadDetailedCoverage = (
            _testRun: vscode.TestRun,
            fileCoverage: vscode.FileCoverage,
            _token: vscode.CancellationToken,
        ): Promise<vscode.FileCoverageDetail[]> => {
            const details = this.coverageDetails.get(fileCoverage);
            return Promise.resolve(details ?? []);
        };

        // Diagnostic command: dump what `executeDocumentSymbolProvider`
        // currently returns for the active editor so we can confirm whether
        // PSES's symbol provider is actually responding.
        this.disposables.push(
            vscode.commands.registerCommand(
                "PowerShell.Pester.DebugDocumentSymbols",
                async (): Promise<void> => {
                    const editor = vscode.window.activeTextEditor;
                    if (editor === undefined) {
                        await vscode.window.showInformationMessage(
                            "No active editor.",
                        );
                        return;
                    }
                    const uri = editor.document.uri;
                    const raw = await vscode.commands.executeCommand<
                        | vscode.DocumentSymbol[]
                        | vscode.SymbolInformation[]
                        | undefined
                    >("vscode.executeDocumentSymbolProvider", uri);
                    const summary =
                        raw === undefined
                            ? "undefined"
                            : `${raw.length} symbols: ${raw.map((s) => s.name).join(" | ")}`;
                    this.logger.write(
                        `Document symbols for ${uri.fsPath}: ${summary}`,
                    );
                    await vscode.window.showInformationMessage(
                        `Pester debug: ${summary.substring(0, 200)} (full result in PowerShell output panel)`,
                    );
                    // Also try the eager discovery directly so we see whether
                    // the parser succeeds when symbols are present.
                    const refreshed = await this.refreshFromAst(uri);
                    this.logger.write(
                        `Manual refreshFromAst result: ${refreshed}`,
                    );
                },
            ),
        );

        const watcher = vscode.workspace.createFileSystemWatcher(
            this.getTestFileGlob(),
        );
        watcher.onDidCreate((uri) => {
            this.ensureFileItem(uri);
        });
        watcher.onDidChange((uri) => {
            const item = this.fileItems.get(uri.fsPath);
            if (item !== undefined) {
                // Invalidate cached children so they re-discover next time.
                item.children.replace([]);
                this.runnerDiscovered.delete(uri.fsPath);
            }
        });
        watcher.onDidDelete((uri) => {
            this.removeFileItem(uri);
        });
        this.disposables.push(watcher);

        // Eager AST-based discovery so editor gutters appear immediately when
        // the user opens a Pester test file, without having to expand the
        // file in the Test Explorer first.
        this.disposables.push(
            vscode.workspace.onDidOpenTextDocument((doc) => {
                if (isPesterTestDocument(doc.uri)) {
                    void this.refreshFromAst(doc.uri);
                }
            }),
            vscode.workspace.onDidChangeTextDocument((event) => {
                if (!isPesterTestDocument(event.document.uri)) {
                    return;
                }
                const key = event.document.uri.fsPath;
                const existing = this.astDebounce.get(key);
                if (existing !== undefined) {
                    clearTimeout(existing);
                }
                this.astDebounce.set(
                    key,
                    setTimeout(() => {
                        this.astDebounce.delete(key);
                        void this.refreshFromAst(event.document.uri);
                    }, 300),
                );
            }),
            // When the user navigates between tabs the active editor changes
            // — that's also when PSES finally has document symbols ready for
            // files that were already open at extension activation.
            vscode.window.onDidChangeActiveTextEditor((editor) => {
                if (editor && isPesterTestDocument(editor.document.uri)) {
                    void this.refreshFromAst(editor.document.uri);
                }
            }),
        );
        // PSES is usually still starting up while our constructor runs, so
        // an immediate `executeDocumentSymbolProvider` call returns nothing
        // for files that were already open. Retry a few times with backoff
        // until we either get symbols or give up.
        const initialEditors = vscode.window.visibleTextEditors.filter((e) =>
            isPesterTestDocument(e.document.uri),
        );
        this.logger.write(
            `PesterTestController initialised. Visible Pester test files at startup: ${initialEditors.length}`,
        );
        for (const editor of initialEditors) {
            this.logger.write(
                `Scheduling eager AST discovery for ${editor.document.uri.fsPath}`,
            );
            void this.refreshFromAstWithRetry(editor.document.uri);
        }
    }

    public dispose(): void {
        for (const timer of this.astDebounce.values()) {
            clearTimeout(timer);
        }
        this.astDebounce.clear();
        for (const d of this.disposables) {
            d.dispose();
        }
        this.fileItems.clear();
        this.runnerDiscovered.clear();
        const disposableInvoker = this.invoker as Partial<vscode.Disposable>;
        if (typeof disposableInvoker.dispose === "function") {
            disposableInvoker.dispose();
        }
    }

    /**
     * Reserved for future use; today this is always `true`. The legacy
     * `pspester.pester-test` extension used to compete for the same test
     * tree and we briefly stood down for it, but we now own the experience
     * and intend to deprecate the third-party adapter rather than coexist
     * with it.
     */
    public static shouldRegister(): boolean {
        return true;
    }

    // VS Code calls this with `undefined` once on startup, then again per
    // individual `TestItem` when its children are needed (e.g. user expands).
    private async resolveHandler(
        item: vscode.TestItem | undefined,
    ): Promise<void> {
        if (item === undefined) {
            await this.discoverTopLevelFiles();
            return;
        }
        if (this.fileItems.get(item.id) === item) {
            await this.discoverFile(item);
        }
    }

    private async refreshAll(): Promise<void> {
        for (const item of this.fileItems.values()) {
            item.children.replace([]);
        }
        await this.discoverTopLevelFiles();
    }

    private async discoverTopLevelFiles(): Promise<void> {
        const uris = await vscode.workspace.findFiles(
            this.getTestFileGlob(),
            "**/node_modules/**",
        );
        const seen = new Set<string>();
        for (const uri of uris) {
            this.ensureFileItem(uri);
            seen.add(uri.fsPath);
        }
        for (const key of Array.from(this.fileItems.keys())) {
            if (!seen.has(key)) {
                this.removeFileItem(vscode.Uri.file(key));
            }
        }
    }

    private ensureFileItem(uri: vscode.Uri): vscode.TestItem {
        const existing = this.fileItems.get(uri.fsPath);
        if (existing !== undefined) {
            return existing;
        }
        const label = path.basename(uri.fsPath);
        const item = this.controller.createTestItem(uri.fsPath, label, uri);
        item.canResolveChildren = true;
        this.fileItems.set(uri.fsPath, item);
        this.controller.items.add(item);
        // Best-effort eager AST fill so editor gutters can render immediately.
        // Use the retrying variant since PSES may still be starting up.
        void this.refreshFromAstWithRetry(uri);
        return item;
    }

    private removeFileItem(uri: vscode.Uri): void {
        if (this.fileItems.delete(uri.fsPath)) {
            this.controller.items.delete(uri.fsPath);
        }
        this.runnerDiscovered.delete(uri.fsPath);
    }

    private async discoverFile(fileItem: vscode.TestItem): Promise<void> {
        const tokenSource = new vscode.CancellationTokenSource();
        // Show the Test Explorer spinner on the file item while Pester is
        // doing its discovery phase. Matches the behaviour of the
        // pester/vscode-adapter extension.
        fileItem.busy = true;
        // Collected inside the discovery callback. We inspect them after the
        // stream completes rather than mutating tree state mid-stream, so an
        // empty/failed result can't wipe the eager-AST tree before we've
        // decided what to do with it. (An array — rather than a captured
        // `let` — keeps the post-loop inspection statically analysable.)
        const fileResults: {
            tests: readonly PesterTestNode[];
            error?: string;
        }[] = [];
        try {
            const settings = this.getRunnerSettings(fileItem.id);
            await this.invoker.discover(
                { paths: [fileItem.id], ...settings },
                (event) => {
                    if (
                        event.type === "file" &&
                        path.normalize(event.file).toLowerCase() ===
                            path.normalize(fileItem.id).toLowerCase()
                    ) {
                        fileResults.push({
                            tests: event.tests,
                            error: event.error,
                        });
                    } else if (event.type === "error") {
                        this.logger.writeWarning(
                            `Pester discovery error: ${event.message}`,
                        );
                    }
                },
                tokenSource.token,
            );
        } finally {
            fileItem.busy = false;
            tokenSource.dispose();
        }

        const latest = fileResults.at(-1);
        if (latest === undefined) {
            // The runner never reported this file (cancelled, or it crashed
            // before emitting). Leave whatever tree we already have in place.
            return;
        }

        const discoveryError =
            latest.error !== undefined && latest.error !== ""
                ? latest.error
                : undefined;

        const looksLikeTestFile =
            fileItem.uri !== undefined && isPesterTestDocument(fileItem.uri);

        // If the runner came back empty, re-run the AST best-guess *before* we
        // decide, so we act on fresh information. The AST pre-fill
        // (refreshFromAstWithRetry) usually wins the race against the runner,
        // but not always — and without this a runner that finished first could
        // make a real `*.Tests.ps1` file look empty. refreshFromAst is a
        // guarded no-op once the file is marked runner-discovered, which has
        // not happened yet.
        if (latest.tests.length === 0 && fileItem.uri !== undefined) {
            await this.refreshFromAst(fileItem.uri);
        }
        const hasStaticTests = fileItem.children.size > 0;

        const outcome = decideDiscoveryOutcome(latest.tests, discoveryError, {
            looksLikeTestFile,
            hasStaticTests,
        });
        switch (outcome.kind) {
            case "runner":
                // Runner produced a tree; treat it as authoritative — it sees
                // the dynamic `-ForEach` cases the AST best-guess can't.
                this.materialiseChildren(fileItem, outcome.tests);
                this.runnerDiscovered.add(fileItem.id);
                break;
            case "empty":
                // Runner succeeded but the file genuinely has no tests. Trust
                // it and clear any AST best-guess children so we don't show
                // ghosts.
                this.materialiseChildren(fileItem, []);
                this.runnerDiscovered.add(fileItem.id);
                break;
            case "astFallback":
                // Discovery failed: either Pester errored (for example it
                // relies on a repo bootstrap that defines a helper such as the
                // Pester repo's own `InPesterModuleScope`, undefined when the
                // file is discovered standalone), or it returned nothing for a
                // file whose `*.Tests.ps1` name says it should hold tests. The
                // AST tree was just (re)built above; leave it in place and do
                // NOT mark the file runner-discovered — so the AST stays
                // authoritative and a later fix to the user's bootstrap can
                // still re-discover it.
                break;
        }

        // Surface (or clear) a discovery note on the file item.
        //   - A real Pester error (even a *partial* one that still produced
        //     tests — only some blocks use a missing helper) is shown verbatim,
        //     so the user sees why a block may be missing or fail to run.
        //   - An astFallback with no error is the `*.Tests.ps1`-looks-empty
        //     heuristic; show a softer note that the tests are a static guess.
        //   - Otherwise clear any stale note.
        // VS Code renders this as the file node's load error without hiding its
        // children.
        if (discoveryError !== undefined) {
            fileItem.error = this.formatDiscoveryError(discoveryError);
        } else if (outcome.kind === "astFallback") {
            fileItem.error = this.formatEmptyTestFileNote();
        } else {
            fileItem.error = undefined;
        }
    }

    /**
     * Wrap a raw Pester discovery-error message for display as a
     * `TestItem.error` in the Test Explorer. VS Code shows this as the file
     * node's "loading error" and — importantly — keeps the node's children
     * visible, so it pairs naturally with the AST/partial tree we keep around.
     */
    private formatDiscoveryError(message: string): vscode.MarkdownString {
        return new vscode.MarkdownString(
            "Pester reported an error while discovering this file, so the " +
                "test list may be incomplete and some tests may fail to run " +
                "on their own.\n\n```\n" +
                message +
                "\n```",
        );
    }

    /**
     * Note shown when Pester discovered no tests in a file whose `*.Tests.ps1`
     * name says it should contain some. We keep the statically-found tests
     * visible (see the `astFallback` heuristic in {@link decideDiscoveryOutcome})
     * and explain that they are a best-guess.
     */
    private formatEmptyTestFileNote(): vscode.MarkdownString {
        return new vscode.MarkdownString(
            "Pester discovered no tests here, but this file's name " +
                "(`*.Tests.ps1`) suggests it should contain some. The tests " +
                "shown were found by static analysis and may be incomplete, " +
                "and some may fail to run on their own.",
        );
    }

    /**
     * Populate the children of a file `TestItem` from PSES's document symbols.
     *
     * This is best-effort: it gives us editor-side gutter decorations without
     * having to spawn `pwsh` and run Pester's discovery phase. We never
     * overwrite a tree that the real runner has already filled, since the
     * runner picks up dynamic `-ForEach` cases and `BeforeDiscovery`-generated
     * blocks that the AST can't see.
     */
    private async refreshFromAst(uri: vscode.Uri): Promise<boolean> {
        try {
            if (this.runnerDiscovered.has(uri.fsPath)) {
                return true;
            }
            let nodes = await discoverViaDocumentSymbols(uri);
            let source = "PSES";
            if (nodes.length === 0) {
                // PSES isn't talking yet (or doesn't have a Pester symbol
                // provider). Fall back to a text-based scan of the open
                // document — good enough for editor gutters.
                let doc = vscode.workspace.textDocuments.find(
                    (d) => d.uri.fsPath === uri.fsPath,
                );
                if (doc === undefined) {
                    try {
                        doc = await vscode.workspace.openTextDocument(uri);
                    } catch {
                        doc = undefined;
                    }
                }
                if (doc !== undefined) {
                    nodes = extractPesterBlocksFromText(
                        doc.getText(),
                        uri.fsPath,
                    );
                    source = "text-fallback";
                }
            }
            if (nodes.length === 0) {
                this.logger.write(
                    `Pester AST discovery: 0 symbols for ${uri.fsPath}`,
                );
                return false;
            }
            const fileItem = this.ensureFileItemNoAst(uri);
            // Re-check after the await: the runner may have raced us.
            if (this.runnerDiscovered.has(uri.fsPath)) {
                return true;
            }
            this.materialiseChildren(fileItem, nodes);
            this.logger.write(
                `Pester AST discovery (${source}): materialised ${nodes.length} top-level node(s) for ${uri.fsPath}`,
            );
            return true;
        } catch (err) {
            this.logger.writeWarning(
                `Pester AST discovery for ${uri.fsPath} failed: ${
                    (err as Error).message
                }`,
            );
            return false;
        }
    }

    /**
     * `refreshFromAst` with a few retries on increasing backoff. PSES is
     * usually still starting up when we run at activation time, so the very
     * first `executeDocumentSymbolProvider` call typically returns an empty
     * list. We retry until we either get symbols or hit the longest delay.
     */
    private async refreshFromAstWithRetry(uri: vscode.Uri): Promise<void> {
        const delaysMs = [0, 500, 1500, 4000, 10000, 20000];
        for (let i = 0; i < delaysMs.length; i++) {
            const delay = delaysMs[i];
            if (delay > 0) {
                await new Promise<void>((resolve) =>
                    setTimeout(resolve, delay),
                );
            }
            if (this.runnerDiscovered.has(uri.fsPath)) {
                return;
            }
            this.logger.write(
                `Pester AST discovery: attempt ${i + 1}/${delaysMs.length} for ${uri.fsPath}`,
            );
            if (await this.refreshFromAst(uri)) {
                return;
            }
        }
        this.logger.writeWarning(
            `Pester AST discovery: gave up after ${delaysMs.length} attempts for ${uri.fsPath} (PSES never returned symbols)`,
        );
    }

    /**
     * Register the file `TestItem` without triggering a recursive AST refresh.
     * Used from `refreshFromAst` so the await chain doesn't fan out.
     */
    private ensureFileItemNoAst(uri: vscode.Uri): vscode.TestItem {
        const existing = this.fileItems.get(uri.fsPath);
        if (existing !== undefined) {
            return existing;
        }
        const label = path.basename(uri.fsPath);
        const item = this.controller.createTestItem(uri.fsPath, label, uri);
        item.canResolveChildren = true;
        this.fileItems.set(uri.fsPath, item);
        this.controller.items.add(item);
        return item;
    }

    private materialiseChildren(
        parent: vscode.TestItem,
        nodes: readonly PesterTestNode[],
    ): void {
        buildItemTree(this.controller, parent, nodes);
    }

    private async runOrCoverage(
        request: vscode.TestRunRequest,
        token: vscode.CancellationToken,
        coverage: boolean,
    ): Promise<void> {
        if (request.continuous === true) {
            await this.runContinuous(request, token, coverage);
            return;
        }
        await this.runOnce(request, token, coverage);
    }

    private async runOnce(
        request: vscode.TestRunRequest,
        token: vscode.CancellationToken,
        coverage: boolean,
    ): Promise<void> {
        // Clear stale coverage details from any previous run so the map
        // doesn't grow unboundedly and `loadDetailedCoverage` always serves
        // results from the latest run.
        if (coverage) {
            this.coverageDetails.clear();
        }
        const run = this.controller.createTestRun(request);
        try {
            // Log the shape of the request so we can answer "why did this
            // run scope X instead of Y" without instrumenting the user's VS
            // Code session. `request.include === undefined` is VS Code's
            // signal that the visual tag filter, if any, has been ignored
            // (its top-level Run All button intentionally bypasses filters).
            const includeSummary =
                request.include === undefined
                    ? "(undefined — VS Code is asking us to run everything)"
                    : request.include.length === 0
                      ? "[]"
                      : `[${request.include.map((i) => i.id).join(", ")}]`;
            const excludeSummary =
                request.exclude === undefined
                    ? "(undefined)"
                    : `[${request.exclude.map((i) => i.id).join(", ")}]`;
            this.logger.write(
                `PesterTestController runOnce: include=${includeSummary} exclude=${excludeSummary} coverage=${coverage}`,
            );

            const tests = await this.collectRequestedTests(request);
            for (const t of tests) {
                run.enqueued(t);
            }

            // Decide per file whether to pass `Filter.Line` to Pester. If
            // the user clicked Run on the whole file (or "Run All Tests"),
            // we want every test to execute; otherwise we narrow Pester
            // down to the source lines of the selected items. This matches
            // what the user clicked instead of "run the whole file every
            // time".
            const filesRunInFull = this.computeFilesRunInFull(request);

            const byFile = groupByFile(tests);
            // Read through a call rather than touching the property directly:
            // the flag flips while we are awaiting, but control flow analysis
            // narrows it to false after the first check and then treats every
            // later read as dead code.
            const cancelled = (): boolean => token.isCancellationRequested;
            for (const [file, items] of byFile) {
                if (cancelled()) {
                    break;
                }
                for (const t of items) {
                    run.started(t);
                }
                const lineFilter = filesRunInFull.has(file)
                    ? undefined
                    : collectFilterLines(items);
                try {
                    await this.runOneFile(
                        file,
                        items,
                        run,
                        token,
                        coverage,
                        lineFilter,
                    );
                } catch (err) {
                    // One file failing (a dead worker, a PowerShell that will
                    // not start) must not abandon the rest of the run, and the
                    // user needs to see it on the tests rather than only in the
                    // log. Matches what the Debug profile already does.
                    // A cancelled run is not a failure, so say nothing.
                    if (cancelled()) {
                        break;
                    }
                    const message = (err as Error).message;
                    this.logger.writeError(
                        `Pester run for ${file} failed: ${message}`,
                    );
                    for (const item of items) {
                        run.errored(
                            item,
                            new vscode.TestMessage(
                                `Pester could not run this file: ${message}`,
                            ),
                        );
                    }
                }
            }
        } catch (err) {
            // Reaching here means the run fell over before, or outside of, the
            // per-file loop, typically because discovery itself failed. Ending
            // the run without saying anything leaves every test sitting in the
            // Test Explorer with no result and the reason buried in the log,
            // so put the message on the items the user asked to run.
            const message = (err as Error).message;
            this.logger.writeError(
                `PesterTestController run failed: ${message}`,
            );
            if (!token.isCancellationRequested) {
                const affected = request.include ?? [
                    ...this.fileItems.values(),
                ];
                for (const item of affected) {
                    run.errored(
                        item,
                        new vscode.TestMessage(
                            `Pester could not run these tests: ${message}`,
                        ),
                    );
                }
            }
        } finally {
            run.end();
        }
    }

    /**
     * Continuous run: re-execute the same request whenever any test file in
     * the workspace changes. Matches the behaviour of the
     * pester/vscode-adapter extension. The watcher is torn down when the
     * caller cancels the run via the `CancellationToken`.
     */
    private async runContinuous(
        request: vscode.TestRunRequest,
        token: vscode.CancellationToken,
        coverage: boolean,
    ): Promise<void> {
        const watcher = vscode.workspace.createFileSystemWatcher(
            this.getTestFileGlob(),
        );
        const config = vscode.workspace.getConfiguration("powershell.pester");
        const debounceMs = Math.max(
            0,
            config.get<number>("testChangeTimeout", 250),
        );
        // `autoDebugOnSave` only applies to the Run profile — Debug already
        // debugs, Coverage already produces coverage; switching either is
        // surprising. Coverage runs reach this method with `coverage=true`,
        // and the Debug profile has its own dispatcher that doesn't reach
        // here at all.
        const autoDebug =
            !coverage && config.get<boolean>("autoDebugOnSave", false);

        let pending: NodeJS.Timeout | undefined;
        let inFlight: Promise<void> | undefined;
        const rerun = (): Promise<void> => {
            if (autoDebug) {
                return this.debug(request, token);
            }
            return this.runOnce(request, token, coverage);
        };
        const trigger = (): void => {
            if (token.isCancellationRequested) {
                return;
            }
            if (pending !== undefined) {
                clearTimeout(pending);
            }
            // Debounce: a single Save can fire several events.
            pending = setTimeout(() => {
                pending = undefined;
                const previous = inFlight ?? Promise.resolve();
                inFlight = previous
                    .then(() => {
                        if (token.isCancellationRequested) {
                            return;
                        }
                        return rerun();
                    })
                    .catch((err: unknown) => {
                        this.logger.writeError(
                            `Pester continuous run failed: ${(err as Error).message}`,
                        );
                    });
            }, debounceMs);
        };
        const disposables: vscode.Disposable[] = [
            watcher,
            watcher.onDidChange(trigger),
            watcher.onDidCreate(trigger),
            watcher.onDidDelete(trigger),
        ];
        // First run immediately so the user sees results without having to
        // touch a file. The initial pass is always a plain run even with
        // autoDebugOnSave — otherwise activating continuous would launch
        // the debugger before the user has changed anything.
        await this.runOnce(request, token, coverage);
        await new Promise<void>((resolve) => {
            const cancelSub = token.onCancellationRequested(() => {
                if (pending !== undefined) {
                    clearTimeout(pending);
                }
                for (const d of disposables) {
                    d.dispose();
                }
                cancelSub.dispose();
                resolve();
            });
        });
    }

    /**
     * Identify which files the user wants to run in full. A file is "full"
     * when there is no `request.include` (run all) or when one of the
     * include entries IS the file item itself (so any line filter would be
     * lossy vs. the user's intent).
     */
    private computeFilesRunInFull(request: vscode.TestRunRequest): Set<string> {
        const out = new Set<string>();
        if (request.include === undefined) {
            for (const f of this.fileItems.keys()) {
                out.add(f);
            }
            return out;
        }
        for (const item of request.include) {
            if (this.fileItems.get(item.id) === item) {
                out.add(item.id);
            }
        }
        return out;
    }

    /**
     * Read the user-overridable Pester runner settings (module path, working
     * directory, configuration `.psd1`) for the workspace folder that owns
     * `testFile`. Workspace-folder scoped so each workspace in a
     * multi-root setup can pin its own values.
     */
    private getRunnerSettings(testFile: string): {
        pesterModulePath?: string;
        workingDirectory?: string;
        configurationPath?: string;
    } {
        const folder = vscode.workspace.getWorkspaceFolder(
            vscode.Uri.file(testFile),
        );
        const config = vscode.workspace.getConfiguration(
            "powershell.pester",
            folder,
        );
        const resolveRelative = (value: string): string => {
            if (folder === undefined || path.isAbsolute(value)) {
                return value;
            }
            return path.join(folder.uri.fsPath, value);
        };
        const out: {
            pesterModulePath?: string;
            workingDirectory?: string;
            configurationPath?: string;
        } = {};
        const modulePath = config.get<string>("pesterModulePath", "");
        if (modulePath !== "") {
            out.pesterModulePath = resolveRelative(modulePath);
        }
        const workingDirectory = config.get<string>("workingDirectory", "");
        if (workingDirectory !== "") {
            out.workingDirectory = resolveRelative(workingDirectory);
        } else if (folder !== undefined) {
            out.workingDirectory = folder.uri.fsPath;
        }
        const configurationPath = config.get<string>("configurationPath", "");
        if (configurationPath !== "") {
            out.configurationPath = resolveRelative(configurationPath);
        }
        return out;
    }

    /**
     * Globs the user has configured for test-file discovery. Returns a single
     * `{a,b,c}`-joined glob so the result can be fed straight to
     * `findFiles` / `createFileSystemWatcher`.
     */
    private getTestFileGlob(): string {
        const config = vscode.workspace.getConfiguration("powershell.pester");
        const patterns = config.get<string[]>("testFilePath", [
            "**/*.[tT]ests.[pP][sS]1",
        ]);
        const cleaned = patterns
            .map((p) => p.trim())
            .filter((p) => p.length > 0);
        if (cleaned.length === 0) {
            return "**/*.[tT]ests.[pP][sS]1";
        }
        if (cleaned.length === 1) {
            return cleaned[0];
        }
        return `{${cleaned.join(",")}}`;
    }

    private async runOneFile(
        file: string,
        items: vscode.TestItem[],
        run: vscode.TestRun,
        token: vscode.CancellationToken,
        coverage: boolean,
        lineNumbers: number[] | undefined,
    ): Promise<void> {
        let xmlPath: string | undefined;
        let sourcePaths: string[] = [];
        if (coverage) {
            xmlPath = path.join(
                os.tmpdir(),
                `pester-cov-${Date.now()}-${Math.random()
                    .toString(36)
                    .slice(2)}.xml`,
            );
            sourcePaths = await this.resolveCoveragePaths(file);
        }

        const itemsById = new Map(items.map((i) => [i.id, i]));
        const results = new Map<string, ResultEvent>();

        const settings = this.getRunnerSettings(file);
        await this.invoker.run(
            {
                paths: [file],
                lineNumbers,
                coverage:
                    coverage && xmlPath !== undefined
                        ? { xmlOutputPath: xmlPath, sourcePaths }
                        : undefined,
                ...settings,
            },
            (event) => {
                this.applyEvent(event, run, itemsById, results);
            },
            token,
        );

        for (const item of items) {
            if (!results.has(item.id)) {
                run.skipped(item);
            }
        }

        if (coverage && xmlPath !== undefined) {
            await this.attachCoverage(xmlPath, sourcePaths, run);
        }
    }

    private applyEvent(
        event: RunnerEvent,
        run: vscode.TestRun,
        itemsById: ReadonlyMap<string, vscode.TestItem>,
        results: Map<string, ResultEvent>,
    ): void {
        if (event.type === "error") {
            this.logger.writeError(`Pester runner error: ${event.message}`);
        }
        const hide = vscode.workspace
            .getConfiguration("powershell.pester")
            .get<boolean>("hideSkippedBecauseMessages", false);
        reportRunnerEvent(event, run, itemsById, results, {
            hideSkippedBecauseMessages: hide,
        });
    }

    private async attachCoverage(
        xmlPath: string,
        candidateAbsolutePaths: readonly string[],
        run: vscode.TestRun,
    ): Promise<void> {
        let xml: string;
        try {
            xml = await fs.readFile(xmlPath, "utf8");
        } catch (err) {
            this.logger.writeWarning(
                `Coverage XML not produced at ${xmlPath}: ${(err as Error).message}`,
            );
            return;
        }
        // The report is ours from here on, so remove it even if parsing throws.
        // Otherwise a malformed report leaves a file behind in the temp
        // directory on every coverage run.
        try {
            const parsed = parseJaCoCoXml(xml);
            const { resolved, unresolved } = resolveCoverageSources(
                parsed,
                candidateAbsolutePaths,
            );
            for (const u of unresolved) {
                this.logger.writeWarning(
                    `Could not resolve coverage entry ${u.packagePath}/${u.sourcefile} to any known source file.`,
                );
            }
            for (const { coverage, details } of toFileCoverage(resolved)) {
                this.coverageDetails.set(coverage, details);
                run.addCoverage(coverage);
            }
        } finally {
            try {
                await fs.unlink(xmlPath);
            } catch {
                // best-effort cleanup
            }
        }
    }

    private async resolveCoveragePaths(testFile: string): Promise<string[]> {
        const folder = vscode.workspace.getWorkspaceFolder(
            vscode.Uri.file(testFile),
        );
        const patterns = vscode.workspace
            .getConfiguration("powershell.pester")
            .get<string[]>("coveragePath", []);

        if (folder === undefined) {
            return [];
        }

        if (patterns.length === 0) {
            const all = await vscode.workspace.findFiles(
                new vscode.RelativePattern(folder, "**/*.{ps1,psm1}"),
                "**/node_modules/**",
            );
            return all
                .map((u) => u.fsPath)
                .filter((p) => !/\.tests\.ps1$/i.test(p));
        }

        const found = new Set<string>();
        for (const pattern of patterns) {
            const uris = await vscode.workspace.findFiles(
                new vscode.RelativePattern(folder, pattern),
            );
            for (const u of uris) {
                found.add(u.fsPath);
            }
        }
        return Array.from(found);
    }

    private async collectRequestedTests(
        request: vscode.TestRunRequest,
    ): Promise<vscode.TestItem[]> {
        const excluded = new Set<string>(
            (request.exclude ?? []).map((i) => i.id),
        );

        // Phase 1: identify every file involved in this run and trigger
        // runner discovery for the ones the AST has only shown a best-guess
        // tree for. This is the reconciliation step that turns AST
        // placeholders (one item per `It -ForEach`) into the real expanded
        // cases that Pester will actually execute.
        const includedItems =
            request.include !== undefined
                ? [...request.include]
                : Array.from(this.fileItems.values());
        const filesToDiscover = new Set<vscode.TestItem>();
        for (const item of includedItems) {
            const filePath = item.uri?.fsPath ?? extractFileFromId(item.id);
            if (filePath === undefined) {
                continue;
            }
            const fileItem = this.fileItems.get(filePath);
            if (fileItem !== undefined) {
                filesToDiscover.add(fileItem);
            }
        }
        for (const fileItem of filesToDiscover) {
            if (!this.runnerDiscovered.has(fileItem.id)) {
                await this.discoverFile(fileItem);
            }
        }

        // Phase 2: resolve each originally-included item to its
        // current-tree counterpart. The original AST `TestItem` may no
        // longer be in the tree because runner discovery just replaced its
        // parent's children. We try exact ID first, then fall back to
        // any descendant that shares the same source line — which is the
        // signature of a Pester ForEach expansion.
        const seenIds = new Set<string>();
        const queue: vscode.TestItem[] = [];
        const enqueueUnique = (candidate: vscode.TestItem): void => {
            if (!seenIds.has(candidate.id)) {
                seenIds.add(candidate.id);
                queue.push(candidate);
            }
        };

        if (request.include === undefined) {
            for (const f of this.fileItems.values()) {
                enqueueUnique(f);
            }
        } else {
            for (const original of request.include) {
                for (const current of this.resolveItemAfterDiscovery(
                    original,
                )) {
                    enqueueUnique(current);
                }
            }
        }

        const flat: vscode.TestItem[] = [];
        while (queue.length > 0) {
            const item = queue.shift()!;
            if (excluded.has(item.id)) {
                continue;
            }
            // Late discovery for files that weren't in the include set but
            // were reached transitively.
            if (
                this.fileItems.get(item.id) === item &&
                item.children.size === 0
            ) {
                await this.discoverFile(item);
            }
            if (item.children.size === 0) {
                flat.push(item);
            } else {
                item.children.forEach((c) => {
                    enqueueUnique(c);
                });
            }
        }
        return flat;
    }

    /**
     * Map an item from the originally-issued `TestRunRequest.include` to its
     * current-tree counterpart(s).
     *
     * The item's `TestItem` instance may be stale because runner discovery
     * just replaced its parent's children with the real, ForEach-expanded
     * tree. With the `>>`-based id scheme an AST template for `It 'greets
     * <Name>' -ForEach (...)` has id `file>>Describe>>greets <Name>`, and
     * each runner-discovered iteration extends that id with a sorted
     * `>>Key=Value` suffix (`file>>Describe>>greets <Name>>>Name=Alice`).
     *
     * Resolution rule: any current-tree descendant whose id is the original
     * id (exact match for plain `It`s) OR starts with `<originalId>>>`
     * (matches every ForEach iteration of the same template).
     */
    private resolveItemAfterDiscovery(
        original: vscode.TestItem,
    ): vscode.TestItem[] {
        const filePath = original.uri?.fsPath ?? extractFileFromId(original.id);
        if (filePath === undefined) {
            return [original];
        }
        const fileItem = this.fileItems.get(filePath);
        if (fileItem === undefined) {
            return [original];
        }

        // Whole-file run: nothing to expand, the file item already covers
        // every test.
        if (fileItem.id === original.id) {
            return [fileItem];
        }

        const matches = findDescendantsByIdPrefix(fileItem, original.id);
        if (matches.length > 0) {
            return matches;
        }
        return [original];
    }

    private async debug(
        request: vscode.TestRunRequest,
        token: vscode.CancellationToken,
    ): Promise<void> {
        const run = this.controller.createTestRun(request);
        try {
            const tests = await this.collectRequestedTests(request);
            for (const t of tests) {
                run.enqueued(t);
            }
            const filesRunInFull = this.computeFilesRunInFull(request);
            const byFile = groupByFile(tests);
            for (const [file, items] of byFile) {
                if (token.isCancellationRequested) {
                    break;
                }
                for (const t of items) {
                    run.started(t);
                }
                const lineFilter = filesRunInFull.has(file)
                    ? undefined
                    : collectFilterLines(items);
                try {
                    await this.debugOneFile(
                        file,
                        items,
                        run,
                        token,
                        lineFilter,
                    );
                } catch (err) {
                    this.logger.writeError(
                        `Pester debug session for ${file} failed: ${(err as Error).message}`,
                    );
                    for (const item of items) {
                        run.errored(
                            item,
                            new vscode.TestMessage(
                                `Debug session failed: ${(err as Error).message}`,
                            ),
                        );
                    }
                }
            }
        } catch (err) {
            this.logger.writeError(
                `PesterTestController debug failed: ${(err as Error).message}`,
            );
        } finally {
            run.end();
        }
    }

    /**
     * Run a single file under the PSES debug adapter, capturing structured
     * runner events via the script's `-EventLog` side channel so we can feed
     * pass/fail/diff information back into the {@link vscode.TestRun}. The
     * regular Run profile streams events live via stdout, but stdout under
     * the debug adapter is owned by the PSES debug REPL — hence the sidecar
     * file.
     *
     * Events are parsed and applied after the debug session terminates.
     */
    private async debugOneFile(
        file: string,
        items: vscode.TestItem[],
        run: vscode.TestRun,
        token: vscode.CancellationToken,
        lineNumbers: number[] | undefined,
    ): Promise<void> {
        const fileUri = vscode.Uri.file(file);
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(fileUri);
        const eventLogPath = path.join(
            os.tmpdir(),
            `pester-events-${Date.now()}-${Math.random()
                .toString(36)
                .slice(2)}.jsonl`,
        );

        const scriptPath = this.invoker.scriptPath;
        const settings = this.getRunnerSettings(file);
        const sessionName = `Pester Debug: ${path.basename(file)}`;
        // The session name is only the basename, so it is not unique. Carry a
        // private marker in the launch config and match sessions on that.
        const runId = `${Date.now()}-${++PesterTestController.debugRunCounter}`;
        const args = ["-Run", "-Path", psQuote(file)];
        if (lineNumbers && lineNumbers.length > 0) {
            args.push("-LineNumber");
            args.push(lineNumbers.join(","));
        }
        if (settings.workingDirectory) {
            args.push("-WorkingDirectory", psQuote(settings.workingDirectory));
        }
        if (settings.pesterModulePath) {
            args.push("-PesterModulePath", psQuote(settings.pesterModulePath));
        }
        if (settings.configurationPath) {
            args.push(
                "-ConfigurationPath",
                psQuote(settings.configurationPath),
            );
        }
        args.push("-EventLog", psQuote(eventLogPath));

        const launchConfig: vscode.DebugConfiguration = {
            request: "launch",
            type: "PowerShell",
            name: sessionName,
            script: scriptPath,
            args,
            internalConsoleOptions: "neverOpen",
            createTemporaryIntegratedConsole: true,
            cwd: settings.workingDirectory ?? path.dirname(file),
            __pesterRunId: runId,
        };

        // Track the matching session so we can wait for its termination
        // before tailing the event log.
        // Subscriptions below belong to this one debug run. Pushing them onto
        // `this.disposables` would leave two dead entries there per run, which
        // never get released until the whole controller goes away.
        const runDisposables: vscode.Disposable[] = [];
        try {
            let resolvedSession: vscode.DebugSession | undefined;
            // Match on the marker we put in the launch config rather than on
            // the session name: the name is only the file's basename, so two
            // same-named test files in different folders would match each
            // other's sessions.
            const sessionStarted = new Promise<vscode.DebugSession | undefined>(
                (resolve) => {
                    runDisposables.push(
                        vscode.debug.onDidStartDebugSession((s) => {
                            if (s.configuration.__pesterRunId === runId) {
                                resolvedSession = s;
                                resolve(s);
                            }
                        }),
                    );
                    // Without this, a session that never starts (the adapter
                    // failed to launch, or the user cancelled while it was
                    // coming up) leaves this promise pending forever and the
                    // test run spins with no way out.
                    runDisposables.push(
                        token.onCancellationRequested(() => {
                            resolve(undefined);
                        }),
                    );
                },
            );

            const ok = await vscode.debug.startDebugging(
                workspaceFolder,
                launchConfig,
            );
            if (!ok) {
                throw new Error(
                    "vscode.debug.startDebugging returned false. PSES debug adapter may be unavailable.",
                );
            }

            const session = await sessionStarted;
            if (session === undefined) {
                // Cancelled before the session came up. There is nothing
                // useful to report, but the runner may already have written
                // part of a log, so drop it on the way out.
                await this.discardEventLog(eventLogPath);
                return;
            }

            const sessionEnded = new Promise<void>((resolve) => {
                runDisposables.push(
                    vscode.debug.onDidTerminateDebugSession((s) => {
                        if (s.id === session.id) {
                            resolve();
                        }
                    }),
                );
            });

            runDisposables.push(
                token.onCancellationRequested(() => {
                    if (resolvedSession) {
                        void vscode.debug.stopDebugging(resolvedSession);
                    }
                }),
            );
            if (token.isCancellationRequested) {
                void vscode.debug.stopDebugging(session);
            }

            await sessionEnded;
        } catch (err) {
            // startDebugging can throw or return false. Either way the sidecar
            // is ours to clean up, since consumeEventLog will never run.
            await this.discardEventLog(eventLogPath);
            throw err;
        } finally {
            for (const d of runDisposables) {
                d.dispose();
            }
        }

        await this.consumeEventLog(eventLogPath, items, run);
    }

    /**
     * Read the sidecar event log written by `PesterRunner.ps1 -EventLog`,
     * parse each JSON line, and feed every event through {@link applyEvent}
     * exactly as the live runner protocol would. Marks any requested item
     * that did not appear in the log as skipped.
     */
    private async consumeEventLog(
        logPath: string,
        items: vscode.TestItem[],
        run: vscode.TestRun,
    ): Promise<void> {
        let raw: string;
        try {
            raw = await fs.readFile(logPath, "utf8");
        } catch (err) {
            this.logger.writeWarning(
                `Pester debug event log missing at ${logPath}: ${(err as Error).message}`,
            );
            for (const item of items) {
                run.skipped(item);
            }
            return;
        }
        const itemsById = new Map(items.map((i) => [i.id, i]));
        const results = new Map<string, ResultEvent>();
        for (const line of raw.split(/\r?\n/)) {
            const trimmed = line.trim();
            if (trimmed.length === 0) {
                continue;
            }
            let event: RunnerEvent;
            try {
                event = JSON.parse(trimmed) as RunnerEvent;
            } catch (err) {
                this.logger.writeWarning(
                    `Skipping non-JSON line in Pester debug event log: ${trimmed} (${(err as Error).message})`,
                );
                continue;
            }
            this.applyEvent(event, run, itemsById, results);
        }
        for (const item of items) {
            if (!results.has(item.id)) {
                run.skipped(item);
            }
        }
        await this.discardEventLog(logPath);
    }

    /**
     * Remove a debug sidecar log. Best-effort: leaving a stale `.jsonl` in the
     * temp directory is not worth surfacing to the user, but leaving one
     * behind on *every* debug run would be.
     */
    private async discardEventLog(logPath: string): Promise<void> {
        try {
            await fs.unlink(logPath);
        } catch {
            // Never existed, or already gone.
        }
    }
}

/**
 * Build the standard Pester runner invoker configured to run the bundled
 * `scripts/PesterRunner.ps1` with the same PowerShell executable that the
 * rest of the extension uses. Defaults to the long-lived
 * {@link PersistentPesterRunnerInvoker} for speed; set the
 * `powershell.pester.useChildProcessRunner` setting to `true` to fall back
 * to the legacy one-process-per-run invoker.
 */
export function createDefaultRunnerInvoker(
    context: vscode.ExtensionContext,
    powerShellExecutable: string,
    logger: ILogger,
): IPesterRunnerInvoker {
    const scriptPath = vscode.Uri.joinPath(
        context.extensionUri,
        "scripts",
        "PesterRunner.ps1",
    ).fsPath;
    const useChildProcess = vscode.workspace
        .getConfiguration("powershell.pester")
        .get<boolean>("useChildProcessRunner", false);
    if (useChildProcess) {
        return new ChildProcessPesterRunnerInvoker(
            scriptPath,
            powerShellExecutable,
            logger,
        );
    }
    return new PersistentPesterRunnerInvoker(
        scriptPath,
        powerShellExecutable,
        logger,
    );
}

/**
 * Quote a string for use as a single argument in a PSES PowerShell debug
 * launch config's `args` array. Each entry is parsed as PowerShell code, so
 * paths containing spaces, hyphens, or other shell-meaningful characters
 * must be wrapped in single quotes with any internal `'` escaped as `''`.
 */
function psQuote(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
}

function groupByFile(items: vscode.TestItem[]): Map<string, vscode.TestItem[]> {
    const out = new Map<string, vscode.TestItem[]>();
    for (const item of items) {
        const file = item.uri?.fsPath ?? extractFileFromId(item.id);
        if (file === undefined) {
            continue;
        }
        const bucket = out.get(file);
        if (bucket === undefined) {
            out.set(file, [item]);
        } else {
            bucket.push(item);
        }
    }
    return out;
}

/**
 * Compute the de-duplicated 1-based source-line numbers for a set of test
 * items. Used to build Pester's `Filter.Line` when running a subset of a
 * file so we don't execute every test in the file just to satisfy one
 * click. Exported for unit-testing.
 */
export function collectFilterLines(
    items: vscode.TestItem[],
): number[] | undefined {
    const lines = new Set<number>();
    for (const item of items) {
        if (item.range !== undefined) {
            // vscode.Range is 0-based; Pester expects 1-based line numbers.
            lines.add(item.range.start.line + 1);
        }
    }
    return lines.size === 0 ? undefined : [...lines];
}

function extractFileFromId(id: string): string | undefined {
    const sep = id.indexOf(ID_SEP);
    return sep === -1 ? id : id.substring(0, sep);
}

/**
 * Walk every descendant of `root` looking for an item with the given id.
 * Returns the first match (IDs are unique in our scheme). Exported for
 * unit-testing.
 */
export function findDescendantById(
    root: vscode.TestItem,
    id: string,
): vscode.TestItem | undefined {
    let found: vscode.TestItem | undefined;
    const walk = (item: vscode.TestItem): void => {
        if (found !== undefined) {
            return;
        }
        if (item.id === id) {
            found = item;
            return;
        }
        item.children.forEach(walk);
    };
    root.children.forEach(walk);
    return found;
}

/**
 * Walk every descendant of `root` and collect items whose id is exactly
 * `prefix` or starts with `prefix + ID_SEP`. This is how we resolve an
 * AST-discovered ForEach template (`file>>Describe>>greets <Name>`) to all
 * of the runner-expanded iterations underneath it
 * (`file>>Describe>>greets <Name>>>Name=Alice`,
 * `file>>Describe>>greets <Name>>>Name=Bob`, …) once real runner discovery
 * has replaced the placeholder.
 */
export function findDescendantsByIdPrefix(
    root: vscode.TestItem,
    prefix: string,
): vscode.TestItem[] {
    const matches: vscode.TestItem[] = [];
    const prefixWithSep = prefix + ID_SEP;
    const walk = (item: vscode.TestItem): void => {
        if (item.id === prefix || item.id.startsWith(prefixWithSep)) {
            matches.push(item);
            // Don't descend into matches — their children would all share
            // the prefix and produce redundant siblings.
            return;
        }
        item.children.forEach(walk);
    };
    root.children.forEach(walk);
    return matches;
}

/**
 * Cache of `vscode.TestTag` instances keyed by tag id. VS Code matches tags
 * across `TestItem`s by their id string, so giving each tag a single
 * shared instance keeps the controller's tag set compact.
 */
const tagInstances = new Map<string, vscode.TestTag>();

function getTestTag(id: string): vscode.TestTag {
    let tag = tagInstances.get(id);
    if (tag === undefined) {
        tag = new vscode.TestTag(id);
        tagInstances.set(id, tag);
    }
    return tag;
}

/**
 * The three ways the controller can react to a single-file discovery result
 * from `PesterRunner.ps1`:
 *
 *   - `runner`   — the runner returned a real tree; materialise it and treat
 *                  the runner as authoritative for this file.
 *   - `empty`    — the runner succeeded but the file genuinely has no tests;
 *                  clear any AST best-guess children and trust the runner.
 *   - `astFallback` — the runner *failed* to discover the file (it reported an
 *                  error and no tests). This happens when a file relies on a
 *                  repo bootstrap that defines a helper unavailable when the
 *                  file is discovered standalone (the Pester repo's own
 *                  `InPesterModuleScope` is the canonical case). We must NOT
 *                  wipe the eager-AST tree or mark the file as
 *                  runner-discovered; instead keep the statically-found tests
 *                  visible and surface the error.
 */
export type DiscoveryOutcome =
    | { kind: "runner"; tests: readonly PesterTestNode[] }
    | { kind: "empty" }
    | { kind: "astFallback" };

/**
 * Extra signals used to disambiguate an *empty* discovery result that carried
 * no error. See {@link decideDiscoveryOutcome}.
 */
export interface DiscoveryHints {
    /** The file's name matches Pester's `*.Tests.ps1` convention. */
    looksLikeTestFile: boolean;
    /** Static (AST) analysis already found at least one test in the file. */
    hasStaticTests: boolean;
}

/**
 * Decide how to treat a file discovery result. Extracted as a pure function so
 * the (previously buggy) "empty result wipes and suppresses the AST tree"
 * decision is unit-testable.
 *
 * Rules, in order:
 *   1. Any tests from the runner win — it is authoritative (it expands the
 *      dynamic `-ForEach` cases the AST best-guess cannot).
 *   2. Empty *with* a discovery error is a failure, not an empty file — keep
 *      the AST tree (the `InPesterModuleScope` regression).
 *   3. Empty with no error, but the file is named `*.Tests.ps1` *and* static
 *      analysis already found tests → almost certainly a silent discovery
 *      failure rather than a truly empty file. The naming convention is a
 *      strong hint that tests exist, so keep the AST tree instead of blanking
 *      it.
 *   4. Otherwise the file really is empty — trust the runner.
 */
export function decideDiscoveryOutcome(
    tests: readonly PesterTestNode[],
    error: string | undefined,
    hints?: DiscoveryHints,
): DiscoveryOutcome {
    if (tests.length > 0) {
        return { kind: "runner", tests };
    }
    if (error !== undefined && error !== "") {
        return { kind: "astFallback" };
    }
    if (hints?.looksLikeTestFile === true && hints.hasStaticTests) {
        return { kind: "astFallback" };
    }
    return { kind: "empty" };
}

/**
 * Disambiguate duplicate ids among a set of sibling nodes.
 *
 * The static/AST scanner can't expand `-ForEach`/`-TestCases`, so two
 * parameterised siblings frequently resolve to the same id. VS Code's
 * `TestItemCollection.replace` throws "Attempted to insert a duplicate test
 * item ID" on the first collision, which aborts the whole file's tree — the
 * file then renders blank (fatal for `InPesterModuleScope` files, whose AST
 * tree is the only one they ever get). Mirror the runner's
 * `Resolve-DuplicateIds`: any id that occurs more than once gets a stable
 * positional `>>#<n>` suffix appended to *every* occurrence (n starting at 0),
 * so the AST ids stay aligned with the runner's scheme.
 */
export function resolveDuplicateNodeIds(ids: readonly string[]): string[] {
    const counts = new Map<string, number>();
    for (const id of ids) {
        counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    const running = new Map<string, number>();
    return ids.map((id) => {
        if ((counts.get(id) ?? 0) > 1) {
            const n = running.get(id) ?? 0;
            running.set(id, n + 1);
            return `${id}${ID_SEP}#${n}`;
        }
        return id;
    });
}

/**
 * Recursively materialise discovered Pester nodes as `TestItem`s under `parent`.
 * Exported for unit-testing; the controller delegates to this from
 * `materialiseChildren`.
 */
export function buildItemTree(
    controller: vscode.TestController,
    parent: vscode.TestItem,
    nodes: readonly PesterTestNode[],
): void {
    // Defensive: a malformed/truncated discovery payload can hand us a
    // non-array here (e.g. if a deeply-nested `children` was serialized past
    // the runner's JSON depth and collapsed into a string). Coerce to [] so a
    // single bad file degrades to "no children shown" instead of throwing
    // `nodes.map is not a function` and aborting the entire run. The runner
    // now serializes deep enough that this should never trigger, but we keep
    // the guard so discovery can never hard-crash a run.
    const safeNodes: readonly PesterTestNode[] = Array.isArray(nodes)
        ? nodes
        : [];
    const children: vscode.TestItem[] = [];
    const uri = parent.uri ?? vscode.Uri.file(parent.id);
    const ids = resolveDuplicateNodeIds(safeNodes.map((node) => node.id));
    safeNodes.forEach((node, index) => {
        const child = controller.createTestItem(ids[index], node.label, uri);
        child.range = new vscode.Range(
            Math.max(0, node.line - 1),
            0,
            Math.max(0, node.line - 1),
            0,
        );
        child.canResolveChildren = node.kind === "block";
        if (node.tags && node.tags.length > 0) {
            child.tags = node.tags.map(getTestTag);
        }
        buildItemTree(controller, child, node.children);
        children.push(child);
    });
    parent.children.replace(children);
}

/**
 * Build the `TestMessage`s for a failed/errored result. When Pester
 * produced an assertion failure of the form `Expected X, but got Y.` the
 * runner has already pulled the two halves into `expected`/`actual`, so we
 * surface them as a `TestMessage.diff()` for a proper side-by-side diff in
 * the Test Results panel. Plain failures fall back to a single concatenated
 * message.
 */
function buildFailureMessages(event: ResultEvent): vscode.TestMessage[] {
    if (event.errors === undefined || event.errors.length === 0) {
        return [new vscode.TestMessage("Test failed.")];
    }
    return event.errors.map((err) => {
        const body = err.stack ? `${err.message}\n${err.stack}` : err.message;
        if (
            typeof err.expected === "string" &&
            typeof err.actual === "string"
        ) {
            return vscode.TestMessage.diff(body, err.expected, err.actual);
        }
        return new vscode.TestMessage(body);
    });
}

/**
 * Translate a single `RunnerEvent` from `PesterRunner.ps1` into the matching
 * `TestRun` call. Non-`result` events are ignored (they're handled elsewhere).
 *
 * `results` records every result we've seen so the caller can detect tests
 * that finished without any event (and mark them `skipped` afterwards).
 *
 * `hideSkippedBecauseMessages` lets the caller suppress the per-test skip
 * reason that Pester surfaces (e.g. `because <reason>` from
 * `Set-ItResult -Skipped -Because`).
 */
export function reportRunnerEvent(
    event: RunnerEvent,
    run: vscode.TestRun,
    itemsById: ReadonlyMap<string, vscode.TestItem>,
    results: Map<string, ResultEvent>,
    options: { hideSkippedBecauseMessages?: boolean } = {},
): void {
    if (event.type === "output") {
        // VS Code's test-output panel renders ANSI escape codes when the
        // chunk uses CRLF line endings — we already format that way on the
        // runner side. If we know which test the chunk belongs to, scope
        // it so "show test output" focuses on that test; otherwise show
        // the chunk at the run level.
        const target = event.testId ? itemsById.get(event.testId) : undefined;
        if (target !== undefined) {
            run.appendOutput(event.text, undefined, target);
        } else {
            run.appendOutput(event.text);
        }
        return;
    }
    if (event.type !== "result") {
        return;
    }
    results.set(event.id, event);
    const target = itemsById.get(event.id);
    if (target === undefined) {
        return;
    }
    const duration = event.durationMs;
    switch (event.status) {
        case "passed":
            run.passed(target, duration);
            break;
        case "failed":
        case "errored": {
            const messages = buildFailureMessages(event);
            if (event.status === "failed") {
                run.failed(target, messages, duration);
            } else {
                run.errored(target, messages, duration);
            }
            break;
        }
        case "skipped":
            if (
                event.skipMessage !== undefined &&
                event.skipMessage !== "" &&
                options.hideSkippedBecauseMessages !== true
            ) {
                run.appendOutput(
                    `Skipped: ${event.skipMessage}\r\n`,
                    undefined,
                    target,
                );
            }
            run.skipped(target);
            break;
    }
}
