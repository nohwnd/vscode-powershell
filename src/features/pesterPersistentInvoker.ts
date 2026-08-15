// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { ChildProcess, spawn } from "child_process";
import type { ILogger } from "../logging";
import vscode = require("vscode");

import type {
    DiscoverOptions,
    IPesterRunnerInvoker,
    RunnerEvent,
    RunOptions,
} from "./pesterRunnerInvoker";

interface PendingRequest {
    onEvent: (event: RunnerEvent) => void;
    resolve: (code: number) => void;
    reject: (err: Error) => void;
    token: vscode.CancellationToken;
    cancelSub: vscode.Disposable;
}

interface ServeCommand {
    op: "discover" | "run" | "shutdown";
    requestId: string;
    path?: string[];
    lineNumber?: number[];
    coverage?: boolean;
    coveragePath?: string;
    coverageSourcePath?: string[];
    outputVerbosity?: RunOptions["outputVerbosity"];
    pesterModulePath?: string;
    workingDirectory?: string;
    configurationPath?: string;
}

/**
 * Long-lived `pwsh` worker that hosts `PesterRunner.ps1 -Serve`. Reuses one
 * PowerShell process (and one loaded `Pester` module) across every
 * discover/run invocation, which eliminates the ~1–2 s startup tax that
 * `ChildProcessPesterRunnerInvoker` pays per call.
 *
 * Wire protocol — one JSON document per line in both directions:
 *   IN  -> `{op, requestId, path?, lineNumber?, coverage?, ...}`
 *   OUT <- `{type, requestId?, ...}` for every event we already define.
 *
 * Each outbound `requestId` matches an inbound command; a `{type:"end"}`
 * with that id terminates the request. Output without `requestId` (the
 * initial `start`/`ready` handshake) is logged but not routed.
 */
export class PersistentPesterRunnerInvoker
    implements IPesterRunnerInvoker, vscode.Disposable
{
    private child: ChildProcess | undefined;
    private starting: Promise<void> | undefined;
    private pending = new Map<string, PendingRequest>();
    private requestQueue = Promise.resolve();
    private stdoutBuffer = "";
    private nextRequestId = 0;
    private disposed = false;

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
        const cmd: ServeCommand = {
            op: "discover",
            requestId: "",
            path: opts.paths,
        };
        applyCommonOptions(cmd, opts);
        return this.sendCommand(cmd, onEvent, token);
    }

    public async run(
        opts: RunOptions,
        onEvent: (event: RunnerEvent) => void,
        token: vscode.CancellationToken,
    ): Promise<number> {
        const cmd: ServeCommand = {
            op: "run",
            requestId: "",
            path: opts.paths,
        };
        if (opts.lineNumbers !== undefined && opts.lineNumbers.length > 0) {
            cmd.lineNumber = opts.lineNumbers;
        }
        if (opts.outputVerbosity !== undefined) {
            cmd.outputVerbosity = opts.outputVerbosity;
        }
        if (opts.coverage !== undefined) {
            cmd.coverage = true;
            cmd.coveragePath = opts.coverage.xmlOutputPath;
            if (opts.coverage.sourcePaths.length > 0) {
                cmd.coverageSourcePath = opts.coverage.sourcePaths;
            }
        }
        applyCommonOptions(cmd, opts);
        return this.sendCommand(cmd, onEvent, token);
    }

    public dispose(): void {
        this.disposed = true;
        if (this.child?.exitCode === null) {
            // Send a clean shutdown if we can, then forcibly kill if the
            // worker doesn't exit promptly. Check `writable` first: a second
            // dispose, or a worker that has already closed its end, would
            // otherwise raise ERR_STREAM_WRITE_AFTER_END asynchronously.
            try {
                if (this.child.stdin?.writable === true) {
                    this.child.stdin.write(
                        JSON.stringify({
                            op: "shutdown",
                            requestId: "shutdown",
                        }) + "\n",
                    );
                    this.child.stdin.end();
                }
            } catch {
                /* worker may already be dead */
            }
            setTimeout(() => {
                if (this.child?.exitCode === null) {
                    try {
                        this.child.kill();
                    } catch {
                        /* nothing more we can do */
                    }
                }
            }, 1000);
        }
        // Reject any in-flight requests so callers don't hang on dispose.
        for (const [id, req] of this.pending) {
            req.cancelSub.dispose();
            req.reject(new Error("Pester worker was disposed."));
            this.pending.delete(id);
        }
    }

    /**
     * Serialise commands. The serve loop processes one command at a time;
     * concurrent runs would interleave output. Each invocation chains onto
     * `requestQueue` so the controller can fire-and-forget multiple runs
     * without us bothering to multiplex.
     */
    private sendCommand(
        cmd: ServeCommand,
        onEvent: (event: RunnerEvent) => void,
        token: vscode.CancellationToken,
    ): Promise<number> {
        if (this.disposed) {
            return Promise.reject(
                new Error("Pester worker has been disposed."),
            );
        }
        const queued = this.requestQueue.then(() =>
            this.dispatchCommand(cmd, onEvent, token),
        );
        // The queue chain only cares about *ordering*, not the per-request
        // result. Swallow both success and failure so a single rejected
        // command doesn't poison every subsequent dispatch.
        this.requestQueue = queued.then(
            () => undefined,
            () => undefined,
        );
        return queued;
    }

    private async dispatchCommand(
        cmd: ServeCommand,
        onEvent: (event: RunnerEvent) => void,
        token: vscode.CancellationToken,
    ): Promise<number> {
        await this.ensureStarted();
        const child = this.child;
        if (child === undefined) {
            throw new Error("Pester worker is not running.");
        }
        const stdin = child.stdin;
        if (stdin === null) {
            throw new Error("Pester worker stdin is not available.");
        }
        return new Promise<number>((resolve, reject) => {
            const requestId = `r${++this.nextRequestId}`;
            const payload = { ...cmd, requestId };
            const cancelSub = token.onCancellationRequested(() => {
                // The serve loop has no preemptive cancel — restart the
                // worker so the in-flight command is interrupted, then
                // reject the request. The TS controller will queue any
                // subsequent commands on the fresh worker.
                this.logger.writeDebug(
                    `Cancelling Pester worker request ${requestId} by restarting worker`,
                );
                const req = this.pending.get(requestId);
                if (req !== undefined) {
                    this.pending.delete(requestId);
                    req.cancelSub.dispose();
                    req.reject(new Error("Cancelled."));
                }
                this.restart();
            });
            this.pending.set(requestId, {
                onEvent,
                resolve,
                reject,
                token,
                cancelSub,
            });
            try {
                if (!stdin.writable) {
                    throw new Error(
                        "Pester worker stdin is closed; the worker is no longer accepting commands.",
                    );
                }
                stdin.write(JSON.stringify(payload) + "\n");
            } catch (err) {
                this.pending.delete(requestId);
                cancelSub.dispose();
                reject(err instanceof Error ? err : new Error(String(err)));
            }
        });
    }

    private async ensureStarted(): Promise<void> {
        if (this.disposed) {
            throw new Error("Pester worker has been disposed.");
        }
        if (this.child?.exitCode === null) {
            return;
        }
        if (this.starting !== undefined) {
            return this.starting;
        }
        this.starting = this.startProcess().finally(() => {
            this.starting = undefined;
        });
        return this.starting;
    }

    private startProcess(): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            const fullArgs = [
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-File",
                this.scriptPath,
                "-Serve",
            ];
            this.logger.writeDebug(
                `Spawning persistent Pester worker: ${this.powerShellExecutable} ${fullArgs.join(" ")}`,
            );
            const child = spawn(this.powerShellExecutable, fullArgs, {
                stdio: ["pipe", "pipe", "pipe"],
            });
            this.child = child;
            this.stdoutBuffer = "";

            // With explicit `stdio: ["pipe", "pipe", "pipe"]` Node always
            // gives us all three streams as non-null handles; pull them
            // into locals to keep the rest of the function readable.
            const stdout = child.stdout;
            const stderr = child.stderr;

            stdout.setEncoding("utf8");
            stderr.setEncoding("utf8");

            // A write to a pipe whose far end has gone away reports the
            // failure asynchronously as an 'error' event, not by throwing, so
            // the try/catch around our writes cannot see it. Without a
            // listener here Node promotes that to an unhandled exception and
            // takes the extension host down with EPIPE or
            // ERR_STREAM_WRITE_AFTER_END. Log it and let the 'exit' handler
            // fail the pending requests.
            child.stdin.on("error", (err: Error) => {
                this.logger.writeWarning(
                    `[PesterRunner serve stdin] ${err.message}`,
                );
            });

            stdout.on("data", (chunk: string) => {
                this.stdoutBuffer += chunk;
                let idx = this.stdoutBuffer.indexOf("\n");
                while (idx !== -1) {
                    const line = this.stdoutBuffer
                        .substring(0, idx)
                        .replace(/\r$/, "");
                    this.stdoutBuffer = this.stdoutBuffer.substring(idx + 1);
                    this.handleLine(line);
                    idx = this.stdoutBuffer.indexOf("\n");
                }
            });

            stderr.on("data", (chunk: string) => {
                this.logger.writeWarning(
                    `[PesterRunner serve stderr] ${chunk}`,
                );
            });

            child.on("error", (err) => {
                this.failAllPending(err);
                if (this.child === child) {
                    this.child = undefined;
                }
                reject(err);
            });

            child.on("exit", (code, signal) => {
                this.logger.writeDebug(
                    `Persistent Pester worker exited (code=${code}, signal=${signal})`,
                );
                this.failAllPending(
                    new Error(
                        `Pester worker exited unexpectedly (code=${code}, signal=${signal}).`,
                    ),
                );
                if (this.child === child) {
                    this.child = undefined;
                }
            });

            // Resolve once we see the `ready` handshake — the script emits
            // this immediately after loading Pester so we know the worker
            // is alive and the next command will run quickly.
            const armReady = (event: RunnerEvent): void => {
                if (event.type === "ready") {
                    resolve();
                }
            };
            this.readyListener = armReady;
        });
    }

    private readyListener: ((event: RunnerEvent) => void) | undefined;

    private handleLine(line: string): void {
        const trimmed = line.trim();
        if (trimmed.length === 0) {
            return;
        }
        let event: RunnerEvent & { requestId?: string };
        try {
            event = JSON.parse(trimmed) as RunnerEvent & {
                requestId?: string;
            };
        } catch (err) {
            this.logger.writeWarning(
                `Ignoring non-JSON line from PesterRunner serve: ${trimmed} (${(err as Error).message})`,
            );
            return;
        }

        // Initial handshake + per-process announcements are not tied to a
        // request.
        if (this.readyListener !== undefined) {
            this.readyListener(event);
            if (event.type === "ready") {
                this.readyListener = undefined;
            }
        }

        const id = event.requestId;
        if (id === undefined || id.length === 0) {
            return;
        }
        const pending = this.pending.get(id);
        if (pending === undefined) {
            return;
        }
        if (event.type === "end") {
            this.pending.delete(id);
            pending.cancelSub.dispose();
            pending.resolve(0);
            return;
        }
        try {
            pending.onEvent(event);
        } catch (err) {
            this.logger.writeWarning(
                `Pester worker event handler threw: ${(err as Error).message}`,
            );
        }
    }

    private failAllPending(err: Error): void {
        for (const [id, req] of this.pending) {
            req.cancelSub.dispose();
            try {
                req.reject(err);
            } catch {
                /* ignore */
            }
            this.pending.delete(id);
        }
    }

    private restart(): void {
        const child = this.child;
        if (child?.exitCode === null) {
            try {
                child.kill();
            } catch {
                /* the exit handler will clean up */
            }
        }
        this.child = undefined;
    }
}

function applyCommonOptions(
    cmd: ServeCommand,
    opts: {
        pesterModulePath?: string;
        workingDirectory?: string;
        configurationPath?: string;
    },
): void {
    if (opts.pesterModulePath !== undefined && opts.pesterModulePath !== "") {
        cmd.pesterModulePath = opts.pesterModulePath;
    }
    if (opts.workingDirectory !== undefined && opts.workingDirectory !== "") {
        cmd.workingDirectory = opts.workingDirectory;
    }
    if (opts.configurationPath !== undefined && opts.configurationPath !== "") {
        cmd.configurationPath = opts.configurationPath;
    }
}
