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

const TEST_FILE_GLOB = "**/*.[tT]ests.ps1";

const COEXISTING_EXTENSION_ID = "pspester.pester-test";

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
 *
 * If the community extension `pspester.pester-test` is installed and active,
 * we skip registration to avoid two competing test trees.
 */
export class PesterTestController implements vscode.Disposable {
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
        );

        this.controller.createRunProfile(
            "Debug",
            vscode.TestRunProfileKind.Debug,
            (request, token): Promise<void> => this.debug(request, token),
            true,
        );

        const coverageProfile = this.controller.createRunProfile(
            "Run with Coverage",
            vscode.TestRunProfileKind.Coverage,
            (request, token): Promise<void> =>
                this.runOrCoverage(request, token, true),
            true,
        );
        coverageProfile.loadDetailedCoverage = (): Promise<
            vscode.FileCoverageDetail[]
        > => Promise.resolve([]);

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

        const watcher =
            vscode.workspace.createFileSystemWatcher(TEST_FILE_GLOB);
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
     * Detect whether another Pester Test Explorer integration is already
     * loaded so we can stand down rather than competing with it.
     */
    public static shouldRegister(): boolean {
        const existing = vscode.extensions.getExtension(
            COEXISTING_EXTENSION_ID,
        );
        return existing === undefined;
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
            TEST_FILE_GLOB,
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
        try {
            await this.invoker.discover(
                { paths: [fileItem.id] },
                (event) => {
                    if (
                        event.type === "file" &&
                        path.normalize(event.file).toLowerCase() ===
                            path.normalize(fileItem.id).toLowerCase()
                    ) {
                        this.materialiseChildren(fileItem, event.tests);
                        this.runnerDiscovered.add(fileItem.id);
                    } else if (event.type === "error") {
                        this.logger.writeWarning(
                            `Pester discovery error: ${event.message}`,
                        );
                    }
                },
                tokenSource.token,
            );
        } finally {
            tokenSource.dispose();
        }
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
        const run = this.controller.createTestRun(request);
        try {
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
                await this.runOneFile(
                    file,
                    items,
                    run,
                    token,
                    coverage,
                    lineFilter,
                );
            }
        } catch (err) {
            this.logger.writeError(
                `PesterTestController run failed: ${(err as Error).message}`,
            );
        } finally {
            run.end();
        }
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

        await this.invoker.run(
            {
                paths: [file],
                lineNumbers,
                coverage:
                    coverage && xmlPath !== undefined
                        ? { xmlOutputPath: xmlPath, sourcePaths }
                        : undefined,
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
        reportRunnerEvent(event, run, itemsById, results);
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
        for (const coverage of toFileCoverage(resolved)) {
            run.addCoverage(coverage);
        }
        try {
            await fs.unlink(xmlPath);
        } catch {
            // best-effort cleanup
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
     * just replaced its parent's children. We try exact ID lookup first
     * (covers all static tests), then fall back to descendants of the file
     * whose source line matches the original item's range — which captures
     * `It -ForEach` expansions (each generated case keeps the original `It`
     * declaration line).
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

        // Pester executes an `It -ForEach` block as a single unit — there's
        // no per-iteration filter in `Filter.Line`. So even when the user
        // clicks one specific case ("greets Alice"), we have to include all
        // siblings declared on the same source line so their results bind
        // to the right `TestItem`s. Same-line resolution does that
        // automatically; we use it whether or not the exact id matched.
        const exact = findDescendantById(fileItem, original.id);
        const line = exact?.range?.start.line ?? original.range?.start.line;
        if (line !== undefined) {
            const sameLine = findDescendantsByLine(fileItem, line);
            if (sameLine.length > 0) {
                return sameLine;
            }
        }
        if (exact !== undefined) {
            return [exact];
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
            const byFile = groupByFile(tests);
            for (const [file] of byFile) {
                if (token.isCancellationRequested) {
                    break;
                }
                await vscode.commands.executeCommand(
                    "PowerShell.RunPesterTests",
                    vscode.Uri.file(file).toString(),
                    true,
                );
            }
        } finally {
            run.end();
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
 * click.
 */
function collectFilterLines(items: vscode.TestItem[]): number[] | undefined {
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
    const sep = id.indexOf("::");
    return sep === -1 ? id : id.substring(0, sep);
}

/**
 * Walk every descendant of `root` looking for an item with the given id.
 * Returns the first match (IDs are unique in our scheme).
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
 * Walk every descendant of `root` and collect items whose `range.start.line`
 * equals the given line number. Used to resolve a stale AST item to the
 * runtime-expanded children of a Pester `-ForEach` declaration.
 */
export function findDescendantsByLine(
    root: vscode.TestItem,
    line: number,
): vscode.TestItem[] {
    const matches: vscode.TestItem[] = [];
    const walk = (item: vscode.TestItem): void => {
        if (item.range?.start.line === line) {
            matches.push(item);
        }
        item.children.forEach(walk);
    };
    root.children.forEach(walk);
    return matches;
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
    const children: vscode.TestItem[] = [];
    const uri = parent.uri ?? vscode.Uri.file(parent.id);
    for (const node of nodes) {
        const child = controller.createTestItem(node.id, node.label, uri);
        child.range = new vscode.Range(
            Math.max(0, node.line - 1),
            0,
            Math.max(0, node.line - 1),
            0,
        );
        child.canResolveChildren = node.kind === "block";
        buildItemTree(controller, child, node.children);
        children.push(child);
    }
    parent.children.replace(children);
}

/**
 * Translate a single `RunnerEvent` from `PesterRunner.ps1` into the matching
 * `TestRun` call. Non-`result` events are ignored (they're handled elsewhere).
 *
 * `results` records every result we've seen so the caller can detect tests
 * that finished without any event (and mark them `skipped` afterwards).
 */
export function reportRunnerEvent(
    event: RunnerEvent,
    run: vscode.TestRun,
    itemsById: ReadonlyMap<string, vscode.TestItem>,
    results: Map<string, ResultEvent>,
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
            const message =
                event.errors
                    ?.map((e) => `${e.message}\n${e.stack}`)
                    .join("\n\n") ?? "Test failed.";
            const failure = new vscode.TestMessage(message);
            if (event.status === "failed") {
                run.failed(target, failure, duration);
            } else {
                run.errored(target, failure, duration);
            }
            break;
        }
        case "skipped":
            run.skipped(target);
            break;
    }
}
