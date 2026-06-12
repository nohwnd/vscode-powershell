// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import * as assert from "assert";
import * as vscode from "vscode";
import {
    buildItemTree,
    collectFilterLines,
    findDescendantById,
    findDescendantsByLine,
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
    output: { text: string; testId?: string }[];
} {
    const calls: RecordedCall[] = [];
    const output: { text: string; testId?: string }[] = [];
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
        appendOutput(
            text: string,
            _location?: vscode.Location,
            target?: vscode.TestItem,
        ): void {
            output.push({ text, testId: target?.id });
        },
        name: undefined,
        token: { isCancellationRequested: false } as vscode.CancellationToken,
        isPersisted: false,
    } as unknown as vscode.TestRun;
    return { run, calls, output };
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
            output: { text: string; testId?: string }[];
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
            const { run, calls, output } = makeRecordingRun();
            return { run, calls, output, itemsById, results, controller };
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

        it("routes an unscoped output event to the test run", function () {
            const ctx = buildContext();
            try {
                reportRunnerEvent(
                    { type: "output", text: "hello world\r\n" },
                    ctx.run,
                    ctx.itemsById,
                    ctx.results,
                );
                assert.deepStrictEqual(ctx.output, [
                    { text: "hello world\r\n", testId: undefined },
                ]);
                assert.deepStrictEqual(ctx.calls, []);
            } finally {
                ctx.controller.dispose();
            }
        });

        it("scopes an output event to its test when testId matches", function () {
            const ctx = buildContext();
            try {
                reportRunnerEvent(
                    { type: "output", text: "scoped\r\n", testId: "t1" },
                    ctx.run,
                    ctx.itemsById,
                    ctx.results,
                );
                assert.deepStrictEqual(ctx.output, [
                    { text: "scoped\r\n", testId: "t1" },
                ]);
            } finally {
                ctx.controller.dispose();
            }
        });

        it("falls back to run-level output when the testId is unknown", function () {
            const ctx = buildContext();
            try {
                reportRunnerEvent(
                    { type: "output", text: "drift\r\n", testId: "missing" },
                    ctx.run,
                    ctx.itemsById,
                    ctx.results,
                );
                assert.deepStrictEqual(ctx.output, [
                    { text: "drift\r\n", testId: undefined },
                ]);
            } finally {
                ctx.controller.dispose();
            }
        });
    });

    describe("collectFilterLines", function () {
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

        function makeItemWithLine(
            id: string,
            zeroBasedLine: number | undefined,
        ): vscode.TestItem {
            const item = controller.createTestItem(id, id);
            if (zeroBasedLine !== undefined) {
                item.range = new vscode.Range(
                    zeroBasedLine,
                    0,
                    zeroBasedLine,
                    0,
                );
            }
            return item;
        }

        it("returns undefined when no items have a range", function () {
            const items = [
                makeItemWithLine("a", undefined),
                makeItemWithLine("b", undefined),
            ];
            assert.strictEqual(collectFilterLines(items), undefined);
        });

        it("returns undefined for an empty input", function () {
            assert.strictEqual(collectFilterLines([]), undefined);
        });

        it("converts 0-based line numbers to Pester's 1-based form", function () {
            const items = [
                makeItemWithLine("a", 0),
                makeItemWithLine("b", 9),
                makeItemWithLine("c", 41),
            ];
            assert.deepStrictEqual(
                collectFilterLines(items)?.sort((a, b) => a - b),
                [1, 10, 42],
            );
        });

        it("de-duplicates ForEach iterations declared on the same line", function () {
            const items = [
                // All three TestItems share the same source-line `It` —
                // typical of an `-ForEach @(...)` expansion.
                makeItemWithLine("a", 5),
                makeItemWithLine("b", 5),
                makeItemWithLine("c", 5),
                makeItemWithLine("d", 9),
            ];
            assert.deepStrictEqual(
                collectFilterLines(items)?.sort((a, b) => a - b),
                [6, 10],
            );
        });

        it("ignores items without a range and keeps the rest", function () {
            const items = [
                makeItemWithLine("a", 4),
                makeItemWithLine("missing", undefined),
                makeItemWithLine("b", 11),
            ];
            assert.deepStrictEqual(
                collectFilterLines(items)?.sort((a, b) => a - b),
                [5, 12],
            );
        });
    });

    describe("findDescendantById", function () {
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

        function buildTree(): vscode.TestItem {
            const file = controller.createTestItem("file", "Sample.Tests.ps1");
            const describe = controller.createTestItem(
                "file::Greeter",
                "Greeter",
            );
            const context = controller.createTestItem(
                "file::Greeter > with name",
                "with name",
            );
            const it1 = controller.createTestItem(
                "file::Greeter > with name > returns hello",
                "returns hello",
            );
            const it2 = controller.createTestItem(
                "file::Greeter > with name > is friendly",
                "is friendly",
            );
            context.children.replace([it1, it2]);
            describe.children.replace([context]);
            file.children.replace([describe]);
            controller.items.add(file);
            return file;
        }

        it("finds a deeply nested descendant by exact id", function () {
            const root = buildTree();
            const hit = findDescendantById(
                root,
                "file::Greeter > with name > is friendly",
            );
            assert.ok(hit, "expected to find the It");
            assert.strictEqual(hit.label, "is friendly");
        });

        it("does not return the root even when its id matches", function () {
            const root = buildTree();
            // root has id "file" — we only walk children, so this should miss.
            assert.strictEqual(findDescendantById(root, "file"), undefined);
        });

        it("returns undefined when no descendant matches", function () {
            const root = buildTree();
            assert.strictEqual(
                findDescendantById(root, "file::Nope > missing"),
                undefined,
            );
        });
    });

    describe("findDescendantsByLine", function () {
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

        function makeRoot(): vscode.TestItem {
            const root = controller.createTestItem("root", "root");
            controller.items.add(root);
            return root;
        }

        function makeItem(
            id: string,
            zeroBasedLine: number | undefined,
        ): vscode.TestItem {
            const item = controller.createTestItem(id, id);
            if (zeroBasedLine !== undefined) {
                item.range = new vscode.Range(
                    zeroBasedLine,
                    0,
                    zeroBasedLine,
                    0,
                );
            }
            return item;
        }

        it("returns every descendant on the requested line", function () {
            // Simulates a Pester `It -ForEach @(...)` expansion: one declaration
            // line, multiple runtime cases.
            const root = makeRoot();
            const a = makeItem("greets <Name=Alice>", 4);
            const b = makeItem("greets <Name=Bob>", 4);
            const c = makeItem("plain", 8);
            root.children.replace([a, b, c]);

            const hits = findDescendantsByLine(root, 4);
            const labels = hits.map((h) => h.label).sort();
            assert.deepStrictEqual(labels, [
                "greets <Name=Alice>",
                "greets <Name=Bob>",
            ]);
        });

        it("descends through nested blocks", function () {
            const root = makeRoot();
            const describe = makeItem("Greeter", 0);
            const ctx = makeItem("ctx", 1);
            const target = makeItem("inner", 7);
            ctx.children.replace([target]);
            describe.children.replace([ctx]);
            root.children.replace([describe]);

            const hits = findDescendantsByLine(root, 7);
            assert.strictEqual(hits.length, 1);
            assert.strictEqual(hits[0].label, "inner");
        });

        it("returns an empty array when no descendant has a matching line", function () {
            const root = makeRoot();
            root.children.replace([makeItem("a", 4), makeItem("b", undefined)]);
            assert.deepStrictEqual(findDescendantsByLine(root, 99), []);
        });

        it("ignores descendants without a range", function () {
            const root = makeRoot();
            root.children.replace([
                makeItem("with-range", 4),
                makeItem("no-range", undefined),
            ]);
            const hits = findDescendantsByLine(root, 4);
            assert.strictEqual(hits.length, 1);
            assert.strictEqual(hits[0].label, "with-range");
        });
    });
});
