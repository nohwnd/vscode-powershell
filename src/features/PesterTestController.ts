// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { parseJaCoCoXml, resolveCoverageSources } from "../coverage/jacoco";
import { toFileCoverage } from "../coverage/vscodeAdapter";
import type { ILogger } from "../logging";
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
            }
        });
        watcher.onDidDelete((uri) => {
            this.removeFileItem(uri);
        });
        this.disposables.push(watcher);
    }

    public dispose(): void {
        for (const d of this.disposables) {
            d.dispose();
        }
        this.fileItems.clear();
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
        return item;
    }

    private removeFileItem(uri: vscode.Uri): void {
        if (this.fileItems.delete(uri.fsPath)) {
            this.controller.items.delete(uri.fsPath);
        }
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

            const byFile = groupByFile(tests);
            for (const [file, items] of byFile) {
                if (token.isCancellationRequested) {
                    break;
                }
                for (const t of items) {
                    run.started(t);
                }
                await this.runOneFile(file, items, run, token, coverage);
            }
        } catch (err) {
            this.logger.writeError(
                `PesterTestController run failed: ${(err as Error).message}`,
            );
        } finally {
            run.end();
        }
    }

    private async runOneFile(
        file: string,
        items: vscode.TestItem[],
        run: vscode.TestRun,
        token: vscode.CancellationToken,
        coverage: boolean,
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
        const queue: vscode.TestItem[] =
            request.include !== undefined
                ? [...request.include]
                : Array.from(this.fileItems.values());

        const flat: vscode.TestItem[] = [];
        const excluded = new Set<string>(
            (request.exclude ?? []).map((i) => i.id),
        );

        while (queue.length > 0) {
            const item = queue.shift()!;
            if (excluded.has(item.id)) {
                continue;
            }
            // Expand file items that haven't been discovered yet.
            if (
                this.fileItems.get(item.id) === item &&
                item.children.size === 0
            ) {
                await this.discoverFile(item);
            }
            if (item.children.size === 0) {
                flat.push(item);
            } else {
                item.children.forEach((c) => queue.push(c));
            }
        }
        return flat;
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
 * Build the standard `ChildProcessPesterRunnerInvoker` configured to run the
 * bundled `scripts/PesterRunner.ps1` with the same PowerShell executable that
 * the rest of the extension uses.
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
    return new ChildProcessPesterRunnerInvoker(
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

function extractFileFromId(id: string): string | undefined {
    const sep = id.indexOf("::");
    return sep === -1 ? id : id.substring(0, sep);
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
