// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import * as assert from "assert";
import * as vscode from "vscode";
import {
    buildItemTree,
    reportRunnerEvent,
} from "../../src/features/PesterTestController";
import type {
    PesterTestNode,
    ResultEvent,
} from "../../src/features/pesterRunnerInvoker";

function makeNode(
    partial: Partial<PesterTestNode> & { id: string; label: string },
): PesterTestNode {
    return {
        kind: "test",
        file: "C:/repo/Sample.Tests.ps1",
        line: 1,
        children: [],
        ...partial,
    };
}

interface RecordedCall {
    method: "passed" | "failed" | "errored" | "skipped";
    id: string;
    duration?: number;
    message?: string;
}

function makeRecordingRun(): {
    run: vscode.TestRun;
    calls: RecordedCall[];
} {
    const calls: RecordedCall[] = [];
    const run = {
        passed(item: vscode.TestItem, duration?: number): void {
            calls.push({ method: "passed", id: item.id, duration });
        },
        failed(
            item: vscode.TestItem,
            message: vscode.TestMessage | vscode.TestMessage[],
            duration?: number,
        ): void {
            const msg = Array.isArray(message) ? message[0] : message;
            calls.push({
                method: "failed",
                id: item.id,
                duration,
                message: msg.message as string,
            });
        },
        errored(
            item: vscode.TestItem,
            message: vscode.TestMessage | vscode.TestMessage[],
            duration?: number,
        ): void {
            const msg = Array.isArray(message) ? message[0] : message;
            calls.push({
                method: "errored",
                id: item.id,
                duration,
                message: msg.message as string,
            });
        },
        skipped(item: vscode.TestItem): void {
            calls.push({ method: "skipped", id: item.id });
        },
        enqueued(): void {
            /* unused */
        },
        started(): void {
            /* unused */
        },
        end(): void {
            /* unused */
        },
        addCoverage(): void {
            /* unused */
        },
        appendOutput(): void {
            /* unused */
        },
        name: undefined,
        token: { isCancellationRequested: false } as vscode.CancellationToken,
        isPersisted: false,
    } as unknown as vscode.TestRun;
    return { run, calls };
}

describe("PesterTestController helpers", function () {
    describe("buildItemTree", function () {
        let controller: vscode.TestController;

        beforeEach(function () {
            controller = vscode.tests.createTestController(
                `pester-test-${Math.random()}`,
                "Pester (test)",
            );
        });

        afterEach(function () {
            controller.dispose();
        });

        it("materialises a Describe > Context > It tree", function () {
            const file = vscode.Uri.file("C:/repo/Sample.Tests.ps1").fsPath;
            const parent = controller.createTestItem(
                file,
                "Sample.Tests.ps1",
                vscode.Uri.file(file),
            );
            controller.items.add(parent);

            const tree: PesterTestNode[] = [
                makeNode({
                    id: `${file}::Greeter`,
                    label: "Greeter",
                    kind: "block",
                    line: 2,
                    children: [
                        makeNode({
                            id: `${file}::Greeter > when given a name`,
                            label: "when given a name",
                            kind: "block",
                            line: 3,
                            children: [
                                makeNode({
                                    id: `${file}::Greeter > when given a name > returns a greeting`,
                                    label: "returns a greeting",
                                    line: 4,
                                }),
                                makeNode({
                                    id: `${file}::Greeter > when given a name > fails on purpose`,
                                    label: "fails on purpose",
                                    line: 5,
                                }),
                            ],
                        }),
                    ],
                }),
            ];

            buildItemTree(controller, parent, tree);

            assert.strictEqual(parent.children.size, 1);
            const describe = parent.children.get(`${file}::Greeter`);
            assert.ok(describe, "Describe child not added");
            assert.strictEqual(describe.canResolveChildren, true);
            assert.strictEqual(describe.range?.start.line, 1);

            const context = describe.children.get(
                `${file}::Greeter > when given a name`,
            );
            assert.ok(context, "Context child not added");
            assert.strictEqual(context.children.size, 2);

            const it = context.children.get(
                `${file}::Greeter > when given a name > returns a greeting`,
            );
            assert.ok(it, "It child not added");
            assert.strictEqual(it.canResolveChildren, false);
            assert.strictEqual(it.uri?.fsPath, file);
        });

        it("replaces the previous children on rebuild", function () {
            const file = vscode.Uri.file("C:/repo/Sample.Tests.ps1").fsPath;
            const parent = controller.createTestItem(file, "x");
            controller.items.add(parent);

            buildItemTree(controller, parent, [
                makeNode({ id: "old1", label: "old1" }),
                makeNode({ id: "old2", label: "old2" }),
            ]);
            assert.strictEqual(parent.children.size, 2);

            buildItemTree(controller, parent, [
                makeNode({ id: "new1", label: "new1" }),
            ]);
            assert.strictEqual(parent.children.size, 1);
            assert.ok(parent.children.get("new1"));
            assert.strictEqual(parent.children.get("old1"), undefined);
        });

        it("clamps a 0-or-negative line to range 0", function () {
            const parent = controller.createTestItem("p", "p");
            controller.items.add(parent);
            buildItemTree(controller, parent, [
                makeNode({ id: "zero", label: "zero", line: 0 }),
                makeNode({ id: "neg", label: "neg", line: -42 }),
            ]);
            assert.strictEqual(
                parent.children.get("zero")?.range?.start.line,
                0,
            );
            assert.strictEqual(
                parent.children.get("neg")?.range?.start.line,
                0,
            );
        });
    });

    describe("reportRunnerEvent", function () {
        function buildContext(): {
            run: vscode.TestRun;
            calls: RecordedCall[];
            itemsById: Map<string, vscode.TestItem>;
            results: Map<string, ResultEvent>;
            controller: vscode.TestController;
        } {
            const controller = vscode.tests.createTestController(
                `pester-test-${Math.random()}`,
                "Pester (test)",
            );
            const item = controller.createTestItem("t1", "t1");
            controller.items.add(item);
            const itemsById = new Map([["t1", item]]);
            const results = new Map<string, ResultEvent>();
            const { run, calls } = makeRecordingRun();
            return { run, calls, itemsById, results, controller };
        }

        it("records a passed test with duration", function () {
            const ctx = buildContext();
            try {
                reportRunnerEvent(
                    {
                        type: "result",
                        id: "t1",
                        status: "passed",
                        durationMs: 42,
                    },
                    ctx.run,
                    ctx.itemsById,
                    ctx.results,
                );
                assert.deepStrictEqual(ctx.calls, [
                    { method: "passed", id: "t1", duration: 42 },
                ]);
                assert.ok(ctx.results.has("t1"));
            } finally {
                ctx.controller.dispose();
            }
        });

        it("records a failed test with a combined message", function () {
            const ctx = buildContext();
            try {
                reportRunnerEvent(
                    {
                        type: "result",
                        id: "t1",
                        status: "failed",
                        durationMs: 10,
                        errors: [
                            {
                                message: "Expected 1 but got 2",
                                stack: "at line 5",
                            },
                            { message: "And another", stack: "at line 7" },
                        ],
                    },
                    ctx.run,
                    ctx.itemsById,
                    ctx.results,
                );
                assert.strictEqual(ctx.calls.length, 1);
                assert.strictEqual(ctx.calls[0].method, "failed");
                assert.match(
                    ctx.calls[0].message ?? "",
                    /Expected 1 but got 2/,
                );
                assert.match(ctx.calls[0].message ?? "", /And another/);
                assert.match(ctx.calls[0].message ?? "", /at line 5/);
            } finally {
                ctx.controller.dispose();
            }
        });

        it("records an errored test when status is errored", function () {
            const ctx = buildContext();
            try {
                reportRunnerEvent(
                    {
                        type: "result",
                        id: "t1",
                        status: "errored",
                        durationMs: 0,
                    },
                    ctx.run,
                    ctx.itemsById,
                    ctx.results,
                );
                assert.strictEqual(ctx.calls[0].method, "errored");
            } finally {
                ctx.controller.dispose();
            }
        });

        it("records a skipped test without duration", function () {
            const ctx = buildContext();
            try {
                reportRunnerEvent(
                    {
                        type: "result",
                        id: "t1",
                        status: "skipped",
                        durationMs: 0,
                    },
                    ctx.run,
                    ctx.itemsById,
                    ctx.results,
                );
                assert.strictEqual(ctx.calls[0].method, "skipped");
            } finally {
                ctx.controller.dispose();
            }
        });

        it("ignores non-result events", function () {
            const ctx = buildContext();
            try {
                reportRunnerEvent(
                    { type: "start", pester: "6.0.0", op: "Run" },
                    ctx.run,
                    ctx.itemsById,
                    ctx.results,
                );
                reportRunnerEvent(
                    { type: "end" },
                    ctx.run,
                    ctx.itemsById,
                    ctx.results,
                );
                reportRunnerEvent(
                    { type: "error", message: "boom" },
                    ctx.run,
                    ctx.itemsById,
                    ctx.results,
                );
                assert.deepStrictEqual(ctx.calls, []);
                assert.strictEqual(ctx.results.size, 0);
            } finally {
                ctx.controller.dispose();
            }
        });

        it("still records a result for an unknown item id", function () {
            const ctx = buildContext();
            try {
                reportRunnerEvent(
                    {
                        type: "result",
                        id: "unknown",
                        status: "passed",
                        durationMs: 1,
                    },
                    ctx.run,
                    ctx.itemsById,
                    ctx.results,
                );
                // No call made on the run, but the result is tracked so the
                // caller's "fill missing as skipped" logic doesn't mark it.
                assert.deepStrictEqual(ctx.calls, []);
                assert.ok(ctx.results.has("unknown"));
            } finally {
                ctx.controller.dispose();
            }
        });
    });
});
