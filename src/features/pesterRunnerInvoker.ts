// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { spawn } from "child_process";
import type { ILogger } from "../logging";
import vscode = require("vscode");

/** A node in the discovery tree produced by `PesterRunner.ps1 -Discover`. */
export interface PesterTestNode {
    id: string;
    label: string;
    kind: "block" | "test";
    file: string;
    line: number;
    children: PesterTestNode[];
    /**
     * Pester `-Tag` values declared on the block or test. Surfaced as
     * `vscode.TestTag` so the Test Explorer can filter on them.
     */
    tags?: string[];
}

export interface StartEvent {
    type: "start";
    pester: string;
    op: "Discover" | "Run";
}
export interface FileEvent {
    type: "file";
    file: string;
    tests: PesterTestNode[];
    /**
     * Set when Pester failed to *discover* this container (e.g. the file
     * calls a helper that is only defined by a repo's own bootstrap and so is
     * undefined when the file is discovered standalone — the Pester repo's
     * `InPesterModuleScope` is the canonical example). When present, `tests`
     * is typically empty; the controller keeps the eager-AST tree visible and
     * surfaces this message on the file item so the user can see *why* the
     * runner found nothing.
     */
    error?: string;
}
export interface ResultError {
    message: string;
    stack: string;
    /**
     * For assertion failures, the expected / actual values pulled out of
     * Pester's `Expected X, but got Y` error message. When both are set
     * the controller emits a `TestMessage.diff()` so VS Code can render
     * a proper side-by-side diff.
     */
    expected?: string;
    actual?: string;
}
export interface ResultEvent {
    type: "result";
    id: string;
    status: "passed" | "failed" | "skipped" | "errored";
    durationMs: number;
    errors?: ResultError[];
    /**
     * Pester's `Set-ItResult -Skipped -Because '<reason>'` text (or any
     * other skip reason it surfaces). The controller may surface this in
     * the Test Output panel unless the user has hidden it.
     */
    skipMessage?: string;
}
export interface EndEvent {
    type: "end";
}
export interface ErrorEvent {
    type: "error";
    message: string;
}
export interface OutputEvent {
    type: "output";
    text: string;
    testId?: string;
}
export interface ReadyEvent {
    type: "ready";
}
export type RunnerEvent =
    | StartEvent
    | FileEvent
    | ResultEvent
    | EndEvent
    | ErrorEvent
    | OutputEvent
    | ReadyEvent;

export interface DiscoverOptions {
    paths: string[];
    /**
     * Extra settings forwarded to PesterRunner.ps1 so the user can pin a
     * specific Pester module, run from a custom working directory, or load
     * a base `.psd1` configuration.
     */
    pesterModulePath?: string;
    workingDirectory?: string;
    configurationPath?: string;
}

export interface CoverageOptions {
    xmlOutputPath: string;
    sourcePaths: string[];
}

export interface RunOptions {
    paths: string[];
    lineNumbers?: number[];
    coverage?: CoverageOptions;
    outputVerbosity?:
        | "None"
        | "Minimal"
        | "Normal"
        | "Detailed"
        | "Diagnostic"
        | "FromPreference";
    pesterModulePath?: string;
    workingDirectory?: string;
    configurationPath?: string;
}

/**
 * Append the cross-cutting `-PesterModulePath` / `-ConfigurationPath` switches
 * (when set) to a runner script argument list. Both the child-process and
 * persistent invokers use this so the flag names stay in lockstep with
 * `PesterRunner.ps1`.
 */
export function appendCommonOptionArgs(
    args: string[],
    opts: { pesterModulePath?: string; configurationPath?: string },
): void {
    if (opts.pesterModulePath !== undefined && opts.pesterModulePath !== "") {
        args.push("-PesterModulePath", opts.pesterModulePath);
    }
    if (opts.configurationPath !== undefined && opts.configurationPath !== "") {
        args.push("-ConfigurationPath", opts.configurationPath);
    }
}

/**
 * Spawns and consumes the bundled `PesterRunner.ps1` script. Tests substitute
 * this with a fake implementation that emits canned events.
 */
export interface IPesterRunnerInvoker {
    readonly scriptPath: string;

    discover(
        opts: DiscoverOptions,
        onEvent: (event: RunnerEvent) => void,
        token: vscode.CancellationToken,
    ): Promise<number>;

    run(
        opts: RunOptions,
        onEvent: (event: RunnerEvent) => void,
        token: vscode.CancellationToken,
    ): Promise<number>;
}

/**
 * Default `IPesterRunnerInvoker` that spawns `pwsh` (or `powershell.exe`) as a
 * child process and parses the JSON-per-line protocol on stdout. Stderr is
 * forwarded to the extension logger as-is and never parsed.
 */
export class ChildProcessPesterRunnerInvoker implements IPesterRunnerInvoker {
    constructor(
        public readonly scriptPath: string,
        private readonly powerShellExecutable: string,
        private readonly logger: ILogger,
    ) {}

    public async discover(
        opts: DiscoverOptions,
        onEvent: (event: RunnerEvent) => void,
        token: vscode.CancellationToken,
    ): Promise<number> {
        const args = ["-Discover", "-Path", ...opts.paths];
        appendCommonOptionArgs(args, opts);
        return this.execute(args, opts.workingDirectory, onEvent, token);
    }

    public async run(
        opts: RunOptions,
        onEvent: (event: RunnerEvent) => void,
        token: vscode.CancellationToken,
    ): Promise<number> {
        const args = ["-Run", "-Path", ...opts.paths];
        if (opts.lineNumbers !== undefined && opts.lineNumbers.length > 0) {
            args.push("-LineNumber", ...opts.lineNumbers.map((n) => String(n)));
        }
        if (opts.outputVerbosity !== undefined) {
            args.push("-OutputVerbosity", opts.outputVerbosity);
        }
        if (opts.coverage) {
            args.push(
                "-Coverage",
                "-CoveragePath",
                opts.coverage.xmlOutputPath,
            );
            if (opts.coverage.sourcePaths.length > 0) {
                args.push("-CoverageSourcePath", ...opts.coverage.sourcePaths);
            }
        }
        appendCommonOptionArgs(args, opts);
        return this.execute(args, opts.workingDirectory, onEvent, token);
    }

    private execute(
        scriptArgs: string[],
        workingDirectory: string | undefined,
        onEvent: (event: RunnerEvent) => void,
        token: vscode.CancellationToken,
    ): Promise<number> {
        return new Promise((resolve, reject) => {
            const fullArgs = [
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-File",
                this.scriptPath,
                ...scriptArgs,
            ];
            this.logger.writeDebug(
                `Spawning ${this.powerShellExecutable} ${fullArgs.join(" ")}`,
            );

            const child = spawn(this.powerShellExecutable, fullArgs, {
                stdio: ["ignore", "pipe", "pipe"],
                cwd:
                    workingDirectory !== undefined && workingDirectory !== ""
                        ? workingDirectory
                        : undefined,
            });

            let stdoutBuffer = "";
            child.stdout.setEncoding("utf8");
            child.stdout.on("data", (chunk: string) => {
                stdoutBuffer += chunk;
                let newlineIndex = stdoutBuffer.indexOf("\n");
                while (newlineIndex !== -1) {
                    const line = stdoutBuffer
                        .substring(0, newlineIndex)
                        .replace(/\r$/, "");
                    stdoutBuffer = stdoutBuffer.substring(newlineIndex + 1);
                    this.dispatchLine(line, onEvent);
                    newlineIndex = stdoutBuffer.indexOf("\n");
                }
            });

            child.stderr.setEncoding("utf8");
            child.stderr.on("data", (chunk: string) => {
                this.logger.writeWarning(`[PesterRunner stderr] ${chunk}`);
            });

            const cancelSub = token.onCancellationRequested(() => {
                child.kill();
            });

            child.on("error", (err) => {
                cancelSub.dispose();
                reject(err);
            });

            child.on("close", (code) => {
                cancelSub.dispose();
                if (stdoutBuffer.length > 0) {
                    this.dispatchLine(stdoutBuffer, onEvent);
                }
                resolve(code ?? -1);
            });
        });
    }

    private dispatchLine(
        line: string,
        onEvent: (event: RunnerEvent) => void,
    ): void {
        const trimmed = line.trim();
        if (trimmed.length === 0) {
            return;
        }
        try {
            const parsed = JSON.parse(trimmed) as RunnerEvent;
            onEvent(parsed);
        } catch (err) {
            this.logger.writeWarning(
                `Ignoring non-JSON line from PesterRunner: ${trimmed} (${err})`,
            );
        }
    }
}
