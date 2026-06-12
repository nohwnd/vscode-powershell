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
}
export interface ResultEvent {
    type: "result";
    id: string;
    status: "passed" | "failed" | "skipped" | "errored";
    durationMs: number;
    errors?: { message: string; stack: string }[];
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
}

/**
 * Spawns and consumes the bundled `PesterRunner.ps1` script. Tests substitute
 * this with a fake implementation that emits canned events.
 */
export interface IPesterRunnerInvoker {
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
        private readonly scriptPath: string,
        private readonly powerShellExecutable: string,
        private readonly logger: ILogger,
    ) {}

    public async discover(
        opts: DiscoverOptions,
        onEvent: (event: RunnerEvent) => void,
        token: vscode.CancellationToken,
    ): Promise<number> {
        const args = ["-Discover", "-Path", ...opts.paths];
        return this.execute(args, onEvent, token);
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
        return this.execute(args, onEvent, token);
    }

    private execute(
        scriptArgs: string[],
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
