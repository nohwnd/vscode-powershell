// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// End-to-end driver for the Pester TestController.
//
// These tests run inside a real VS Code extension host, against a real `pwsh`
// process, a real installed Pester, and real `.Tests.ps1` files in the fixture
// workspace. Nothing about the runner protocol is stubbed — the only thing the
// harness substitutes is the `controllerFactory` seam, which it uses to keep a
// reference to the `vscode.TestController` the feature creates so assertions
// can read the resulting test tree and run outcomes.
//
// The controller normally reaches VS Code through callbacks (`resolveHandler`,
// run-profile handlers, `TestRun.passed(...)`). To observe those we proxy the
// controller: `createRunProfile` records each profile and its handler, and
// `createTestRun` wraps the returned run so every outcome call is recorded
// before being forwarded to the real object.

import * as vscode from "vscode";
import { PesterTestController } from "../../src/features/PesterTestController";
import { PersistentPesterRunnerInvoker } from "../../src/features/pesterPersistentInvoker";
import {
    ChildProcessPesterRunnerInvoker,
    type IPesterRunnerInvoker,
} from "../../src/features/pesterRunnerInvoker";
import { testLogger } from "../utils";

export type RunnerKind = "persistent" | "childProcess";

export interface RecordedOutcome {
    id: string;
    outcome: "passed" | "failed" | "skipped" | "errored";
    duration?: number;
    messages: string[];
}

export interface RecordedRun {
    outcomes: RecordedOutcome[];
    output: string[];
    coverage: vscode.FileCoverage[];
    ended: boolean;
}

function messageText(
    message: vscode.TestMessage | readonly vscode.TestMessage[],
): string[] {
    const list = Array.isArray(message) ? message : [message];
    return (list as vscode.TestMessage[]).map((m) =>
        typeof m.message === "string" ? m.message : m.message.value,
    );
}

/** Wrap a `TestRun` so every outcome call is recorded, then forwarded. */
function recordRun(run: vscode.TestRun, rec: RecordedRun): vscode.TestRun {
    return new Proxy(run, {
        get(target, prop, receiver): unknown {
            switch (prop) {
                case "passed":
                    return (test: vscode.TestItem, duration?: number): void => {
                        rec.outcomes.push({
                            id: test.id,
                            outcome: "passed",
                            duration,
                            messages: [],
                        });
                        target.passed(test, duration);
                    };
                case "failed":
                    return (
                        test: vscode.TestItem,
                        message: vscode.TestMessage | vscode.TestMessage[],
                        duration?: number,
                    ): void => {
                        rec.outcomes.push({
                            id: test.id,
                            outcome: "failed",
                            duration,
                            messages: messageText(message),
                        });
                        target.failed(test, message, duration);
                    };
                case "errored":
                    return (
                        test: vscode.TestItem,
                        message: vscode.TestMessage | vscode.TestMessage[],
                        duration?: number,
                    ): void => {
                        rec.outcomes.push({
                            id: test.id,
                            outcome: "errored",
                            duration,
                            messages: messageText(message),
                        });
                        target.errored(test, message, duration);
                    };
                case "skipped":
                    return (test: vscode.TestItem): void => {
                        rec.outcomes.push({
                            id: test.id,
                            outcome: "skipped",
                            messages: [],
                        });
                        target.skipped(test);
                    };
                case "appendOutput":
                    return (
                        output: string,
                        location?: vscode.Location,
                        test?: vscode.TestItem,
                    ): void => {
                        rec.output.push(output);
                        target.appendOutput(output, location, test);
                    };
                case "addCoverage":
                    return (fileCoverage: vscode.FileCoverage): void => {
                        rec.coverage.push(fileCoverage);
                        target.addCoverage(fileCoverage);
                    };
                case "end":
                    return (): void => {
                        rec.ended = true;
                        target.end();
                    };
                default: {
                    const value = Reflect.get(
                        target,
                        prop,
                        receiver,
                    ) as unknown;
                    return typeof value === "function"
                        ? (value as (...a: unknown[]) => unknown).bind(target)
                        : value;
                }
            }
        },
    });
}

export class E2EDriver implements vscode.Disposable {
    public controller!: vscode.TestController;
    public readonly profiles = new Map<
        vscode.TestRunProfileKind,
        vscode.TestRunProfile
    >();
    public readonly handlers = new Map<
        vscode.TestRunProfileKind,
        (
            request: vscode.TestRunRequest,
            token: vscode.CancellationToken,
        ) => Thenable<void>
    >();
    /** Every run the controller started, newest last. */
    public readonly runs: RecordedRun[] = [];

    private readonly feature: PesterTestController;
    private readonly invoker: IPesterRunnerInvoker;

    constructor(scriptPath: string, runner: RunnerKind = "persistent") {
        this.invoker =
            runner === "persistent"
                ? new PersistentPesterRunnerInvoker(
                      scriptPath,
                      "pwsh",
                      testLogger,
                  )
                : new ChildProcessPesterRunnerInvoker(
                      scriptPath,
                      "pwsh",
                      testLogger,
                  );

        this.feature = new PesterTestController(
            this.invoker,
            testLogger,
            (id, label) => this.makeController(id, label),
        );
    }

    private makeController(id: string, label: string): vscode.TestController {
        // Distinct id so we never collide with the controller the activated
        // extension registers. The fixture workspace also sets
        // `powershell.pester.useTestController: false` so the extension's own
        // instance stays out of the way entirely.
        const real = vscode.tests.createTestController(`${id}-e2e`, label);
        this.controller = real;
        return new Proxy(real, {
            // Arrow function so `this` stays the driver instance.
            get: (target, prop, receiver): unknown => {
                if (prop === "createRunProfile") {
                    return (
                        profileLabel: string,
                        kind: vscode.TestRunProfileKind,
                        handler: (
                            request: vscode.TestRunRequest,
                            token: vscode.CancellationToken,
                        ) => Thenable<void>,
                        isDefault?: boolean,
                        tag?: vscode.TestTag,
                        supportsContinuousRun?: boolean,
                    ): vscode.TestRunProfile => {
                        const profile = target.createRunProfile(
                            profileLabel,
                            kind,
                            handler,
                            isDefault,
                            tag,
                            supportsContinuousRun,
                        );
                        this.profiles.set(kind, profile);
                        this.handlers.set(kind, handler);
                        return profile;
                    };
                }
                if (prop === "createTestRun") {
                    return (
                        request: vscode.TestRunRequest,
                        name?: string,
                        persist?: boolean,
                    ): vscode.TestRun => {
                        const rec: RecordedRun = {
                            outcomes: [],
                            output: [],
                            coverage: [],
                            ended: false,
                        };
                        this.runs.push(rec);
                        return recordRun(
                            target.createTestRun(request, name, persist),
                            rec,
                        );
                    };
                }
                const value = Reflect.get(target, prop, receiver) as unknown;
                return typeof value === "function"
                    ? (value as (...a: unknown[]) => unknown).bind(target)
                    : value;
            },
        });
    }

    /** Populate the top-level file items (what VS Code does on tree expand). */
    public async discoverFiles(): Promise<void> {
        await this.controller.resolveHandler?.(undefined);
    }

    /** Run real Pester discovery for one file item. */
    public async discoverFile(item: vscode.TestItem): Promise<void> {
        await this.controller.resolveHandler?.(item);
    }

    public fileItem(basename: string): vscode.TestItem {
        let found: vscode.TestItem | undefined;
        this.controller.items.forEach((item) => {
            if (item.id.endsWith(basename)) {
                found = item;
            }
        });
        if (found === undefined) {
            const have: string[] = [];
            this.controller.items.forEach((i) => have.push(i.id));
            throw new Error(
                `No file item ending in ${basename}. Have: ${have.join(", ")}`,
            );
        }
        return found;
    }

    /** Invoke a run profile handler and return what the run recorded. */
    public async run(
        kind: vscode.TestRunProfileKind,
        include: vscode.TestItem[] | undefined,
    ): Promise<RecordedRun> {
        const handler = this.handlers.get(kind);
        if (handler === undefined) {
            throw new Error(`No handler registered for profile kind ${kind}`);
        }
        const before = this.runs.length;
        const request = new vscode.TestRunRequest(
            include,
            undefined,
            this.profiles.get(kind),
        );
        const tokenSource = new vscode.CancellationTokenSource();
        try {
            await handler(request, tokenSource.token);
        } finally {
            tokenSource.dispose();
        }
        const created = this.runs.slice(before);
        if (created.length === 0) {
            throw new Error("The run profile handler never created a TestRun");
        }
        // Fold every run the handler produced into one view; the controller
        // may start more than one when a request spans multiple files.
        return created.reduce<RecordedRun>(
            (acc, r) => ({
                outcomes: [...acc.outcomes, ...r.outcomes],
                output: [...acc.output, ...r.output],
                coverage: [...acc.coverage, ...r.coverage],
                ended: acc.ended && r.ended,
            }),
            { outcomes: [], output: [], coverage: [], ended: true },
        );
    }

    public dispose(): void {
        this.feature.dispose();
        if ("dispose" in this.invoker) {
            (this.invoker as vscode.Disposable).dispose();
        }
    }
}

/** Flatten a test item subtree into `id -> item`. */
export function flatten(
    item: vscode.TestItem,
    into = new Map<string, vscode.TestItem>(),
): Map<string, vscode.TestItem> {
    item.children.forEach((child) => {
        into.set(child.id, child);
        flatten(child, into);
    });
    return into;
}

/** Depth of the deepest descendant, where a file item alone is depth 0. */
export function treeDepth(item: vscode.TestItem): number {
    let deepest = 0;
    item.children.forEach((child) => {
        deepest = Math.max(deepest, 1 + treeDepth(child));
    });
    return deepest;
}
