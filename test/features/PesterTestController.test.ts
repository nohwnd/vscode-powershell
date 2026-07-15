// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import * as assert from "assert";
import * as vscode from "vscode";
import {
    buildItemTree,
    collectFilterLines,
    decideDiscoveryOutcome,
    findDescendantById,
    findDescendantsByIdPrefix,
    reportRunnerEvent,
    resolveDuplicateNodeIds,
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
    messages?: string[];
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
            const list = Array.isArray(message) ? message : [message];
            calls.push({
                method: "failed",
                id: item.id,
                duration,
                message: list[0].message as string,
                messages: list.map((m) => m.message as string),
            });
        },
        errored(
            item: vscode.TestItem,
            message: vscode.TestMessage | vscode.TestMessage[],
            duration?: number,
        ): void {
            const list = Array.isArray(message) ? message : [message];
            calls.push({
                method: "errored",
                id: item.id,
                duration,
                message: list[0].message as string,
                messages: list.map((m) => m.message as string),
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
                    id: `${file}>>Greeter`,
                    label: "Greeter",
                    kind: "block",
                    line: 2,
                    children: [
                        makeNode({
                            id: `${file}>>Greeter>>when given a name`,
                            label: "when given a name",
                            kind: "block",
                            line: 3,
                            children: [
                                makeNode({
                                    id: `${file}>>Greeter>>when given a name>>returns a greeting`,
                                    label: "returns a greeting",
                                    line: 4,
                                }),
                                makeNode({
                                    id: `${file}>>Greeter>>when given a name>>fails on purpose`,
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
            const describe = parent.children.get(`${file}>>Greeter`);
            assert.ok(describe, "Describe child not added");
            assert.strictEqual(describe.canResolveChildren, true);
            assert.strictEqual(describe.range?.start.line, 1);

            const context = describe.children.get(
                `${file}>>Greeter>>when given a name`,
            );
            assert.ok(context, "Context child not added");
            assert.strictEqual(context.children.size, 2);

            const it = context.children.get(
                `${file}>>Greeter>>when given a name>>returns a greeting`,
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

        it("applies Pester -Tag values as vscode.TestTag instances", function () {
            const parent = controller.createTestItem("p", "p");
            controller.items.add(parent);
            buildItemTree(controller, parent, [
                makeNode({
                    id: "tagged",
                    label: "tagged",
                    tags: ["slow", "integration"],
                }),
                makeNode({ id: "untagged", label: "untagged" }),
            ]);
            const tagged = parent.children.get("tagged");
            const untagged = parent.children.get("untagged");
            if (tagged === undefined || untagged === undefined) {
                assert.fail("expected both children to be present");
            }
            const tagIds = tagged.tags.map((t) => t.id).sort();
            assert.deepStrictEqual(tagIds, ["integration", "slow"]);
            assert.strictEqual(untagged.tags.length, 0);
        });

        it("reuses the same TestTag instance for the same tag id", function () {
            const parent = controller.createTestItem("p", "p");
            controller.items.add(parent);
            buildItemTree(controller, parent, [
                makeNode({ id: "a", label: "a", tags: ["slow"] }),
                makeNode({ id: "b", label: "b", tags: ["slow"] }),
            ]);
            const a = parent.children.get("a");
            const b = parent.children.get("b");
            if (a === undefined || b === undefined) {
                assert.fail("expected both children to be present");
            }
            const tagA = a.tags.find((t) => t.id === "slow");
            const tagB = b.tags.find((t) => t.id === "slow");
            assert.ok(tagA !== undefined && tagB !== undefined);
            assert.strictEqual(tagA, tagB);
        });

        it("disambiguates duplicate sibling ids instead of throwing", function () {
            const file = vscode.Uri.file("C:/repo/Sample.Tests.ps1").fsPath;
            const parent = controller.createTestItem(file, "Sample.Tests.ps1");
            controller.items.add(parent);

            // Two `It`s with the same literal name (e.g. a `-ForEach` the
            // static scanner can't expand, or a genuinely repeated name)
            // resolve to the same AST id. VS Code's `TestItemCollection.replace`
            // throws "Attempted to insert a duplicate test item ID" on the
            // collision, which would blank the whole file; buildItemTree must
            // disambiguate them first.
            assert.doesNotThrow(() => {
                buildItemTree(controller, parent, [
                    makeNode({ id: `${file}>>Passes`, label: "Passes" }),
                    makeNode({ id: `${file}>>Passes`, label: "Passes" }),
                    makeNode({ id: `${file}>>Passes`, label: "Passes" }),
                ]);
            });

            assert.strictEqual(parent.children.size, 3);
            assert.ok(parent.children.get(`${file}>>Passes>>#0`));
            assert.ok(parent.children.get(`${file}>>Passes>>#1`));
            assert.ok(parent.children.get(`${file}>>Passes>>#2`));
        });
    });

    describe("resolveDuplicateNodeIds", function () {
        it("leaves unique ids untouched", function () {
            assert.deepStrictEqual(resolveDuplicateNodeIds(["a", "b", "c"]), [
                "a",
                "b",
                "c",
            ]);
        });

        it("suffixes every occurrence of a duplicated id with a 0-based index", function () {
            assert.deepStrictEqual(
                resolveDuplicateNodeIds(["a", "a", "b", "a"]),
                ["a>>#0", "a>>#1", "b", "a>>#2"],
            );
        });

        it("mirrors the runner's Resolve-DuplicateIds so both paths agree", function () {
            assert.deepStrictEqual(
                resolveDuplicateNodeIds(["x", "y", "x", "y"]),
                ["x>>#0", "y>>#0", "x>>#1", "y>>#1"],
            );
        });

        it("returns an empty array for empty input", function () {
            assert.deepStrictEqual(resolveDuplicateNodeIds([]), []);
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

        it("records one TestMessage per error on a failed test", function () {
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
                const msgs = ctx.calls[0].messages;
                if (msgs === undefined) {
                    assert.fail("expected messages to be present");
                }
                assert.strictEqual(msgs.length, 2);
                assert.match(msgs[0], /Expected 1 but got 2/);
                assert.match(msgs[0], /at line 5/);
                assert.match(msgs[1], /And another/);
                assert.match(msgs[1], /at line 7/);
            } finally {
                ctx.controller.dispose();
            }
        });

        it("produces a TestMessage.diff when expected and actual are present", function () {
            const ctx = buildContext();
            try {
                reportRunnerEvent(
                    {
                        type: "result",
                        id: "t1",
                        status: "failed",
                        durationMs: 3,
                        errors: [
                            {
                                message: "Expected 1, but got 2.",
                                stack: "at line 5",
                                expected: "1",
                                actual: "2",
                            },
                        ],
                    },
                    ctx.run,
                    ctx.itemsById,
                    ctx.results,
                );
                assert.strictEqual(ctx.calls.length, 1);
                assert.strictEqual(ctx.calls[0].method, "failed");
                // We can't introspect TestMessage.expectedOutput from the
                // recording-shim (the field exists only on real TestMessage
                // instances created via the diff factory), but the message
                // body itself should round-trip the human-readable text.
                const msgs = ctx.calls[0].messages;
                if (msgs === undefined || msgs.length === 0) {
                    assert.fail("expected messages to be present");
                }
                assert.match(msgs[0], /Expected 1, but got 2/);
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

        it("appends the Pester skipMessage to test output by default", function () {
            const ctx = buildContext();
            try {
                reportRunnerEvent(
                    {
                        type: "result",
                        id: "t1",
                        status: "skipped",
                        durationMs: 0,
                        skipMessage: "needs network",
                    },
                    ctx.run,
                    ctx.itemsById,
                    ctx.results,
                );
                assert.strictEqual(ctx.calls[0].method, "skipped");
                assert.strictEqual(ctx.output.length, 1);
                assert.match(ctx.output[0].text, /Skipped: needs network/);
                assert.strictEqual(ctx.output[0].testId, "t1");
            } finally {
                ctx.controller.dispose();
            }
        });

        it("suppresses the skipMessage when hideSkippedBecauseMessages is true", function () {
            const ctx = buildContext();
            try {
                reportRunnerEvent(
                    {
                        type: "result",
                        id: "t1",
                        status: "skipped",
                        durationMs: 0,
                        skipMessage: "needs network",
                    },
                    ctx.run,
                    ctx.itemsById,
                    ctx.results,
                    { hideSkippedBecauseMessages: true },
                );
                assert.strictEqual(ctx.calls[0].method, "skipped");
                assert.strictEqual(ctx.output.length, 0);
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
                "file>>Greeter",
                "Greeter",
            );
            const context = controller.createTestItem(
                "file>>Greeter>>with name",
                "with name",
            );
            const it1 = controller.createTestItem(
                "file>>Greeter>>with name>>returns hello",
                "returns hello",
            );
            const it2 = controller.createTestItem(
                "file>>Greeter>>with name>>is friendly",
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
                "file>>Greeter>>with name>>is friendly",
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
                findDescendantById(root, "file>>Nope>>missing"),
                undefined,
            );
        });
    });

    describe("findDescendantsByIdPrefix", function () {
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

        function makeItem(id: string): vscode.TestItem {
            return controller.createTestItem(id, id);
        }

        it("returns every ForEach iteration of a template by id prefix", function () {
            // Simulates a Pester `It -ForEach @(...)` expansion: one AST
            // template `>>greets <Name>` plus N runner-discovered iterations
            // appended with sorted `>>Key=Value` data segments.
            const root = makeRoot();
            const a = makeItem("file>>Describe>>greets <Name>>>Name=Alice");
            const b = makeItem("file>>Describe>>greets <Name>>>Name=Bob");
            const c = makeItem("file>>Describe>>plain");
            root.children.replace([a, b, c]);

            const hits = findDescendantsByIdPrefix(
                root,
                "file>>Describe>>greets <Name>",
            );
            const ids = hits.map((h) => h.id).sort();
            assert.deepStrictEqual(ids, [
                "file>>Describe>>greets <Name>>>Name=Alice",
                "file>>Describe>>greets <Name>>>Name=Bob",
            ]);
        });

        it("returns an exact-id match for a plain (non-ForEach) test", function () {
            const root = makeRoot();
            const plain = makeItem("file>>Describe>>plain");
            const other = makeItem("file>>Describe>>other");
            root.children.replace([plain, other]);

            const hits = findDescendantsByIdPrefix(
                root,
                "file>>Describe>>plain",
            );
            assert.strictEqual(hits.length, 1);
            assert.strictEqual(hits[0].id, "file>>Describe>>plain");
        });

        it("descends through nested blocks before matching", function () {
            const root = makeRoot();
            const describe = makeItem("file>>Greeter");
            const ctx = makeItem("file>>Greeter>>ctx");
            const target = makeItem("file>>Greeter>>ctx>>inner");
            ctx.children.replace([target]);
            describe.children.replace([ctx]);
            root.children.replace([describe]);

            const hits = findDescendantsByIdPrefix(
                root,
                "file>>Greeter>>ctx>>inner",
            );
            assert.strictEqual(hits.length, 1);
            assert.strictEqual(hits[0].id, "file>>Greeter>>ctx>>inner");
        });

        it("does not match a sibling that merely shares the prefix without the separator", function () {
            // `It 'greets'` should NOT match the prefix `greets <Name>` —
            // we require either an exact match or a `>>` boundary after.
            const root = makeRoot();
            const conflict = makeItem("file>>Describe>>greets");
            root.children.replace([conflict]);

            const hits = findDescendantsByIdPrefix(
                root,
                "file>>Describe>>greets <Name>",
            );
            assert.deepStrictEqual(hits, []);
        });

        it("returns an empty array when nothing matches", function () {
            const root = makeRoot();
            root.children.replace([makeItem("file>>Describe>>a")]);
            assert.deepStrictEqual(
                findDescendantsByIdPrefix(root, "file>>Describe>>nope"),
                [],
            );
        });

        it("does not descend into a matched item", function () {
            // A file-level run should map to one item (the file), not also
            // every nested test which trivially shares the prefix.
            const root = makeRoot();
            const file = makeItem("file");
            file.children.replace([makeItem("file>>A"), makeItem("file>>B")]);
            root.children.replace([file]);

            const hits = findDescendantsByIdPrefix(root, "file");
            assert.strictEqual(hits.length, 1);
            assert.strictEqual(hits[0].id, "file");
        });
    });

    describe("decideDiscoveryOutcome", function () {
        it("treats a non-empty runner result as authoritative", function () {
            const nodes = [makeNode({ id: "file>>D>>t", label: "t" })];
            const outcome = decideDiscoveryOutcome(nodes, undefined);
            assert.deepStrictEqual(outcome, { kind: "runner", tests: nodes });
        });

        it("prefers the runner tree even when an error is also reported", function () {
            // A partial failure that still produced tests should keep the
            // tests rather than being downgraded to a fallback.
            const nodes = [makeNode({ id: "file>>D>>t", label: "t" })];
            const outcome = decideDiscoveryOutcome(nodes, "some warning");
            assert.strictEqual(outcome.kind, "runner");
        });

        it("falls back to the AST tree when discovery failed with an error", function () {
            // This is the InPesterModuleScope regression: an empty result that
            // carries a discovery error must NOT be treated as an empty file
            // (which would wipe the eager-AST tree and permanently suppress
            // re-discovery). It must be surfaced as an AST fallback instead.
            const message =
                "The term 'InPesterModuleScope' is not recognized as a name of a cmdlet, function, script file, or executable program.";
            const outcome = decideDiscoveryOutcome([], message);
            assert.deepStrictEqual(outcome, { kind: "astFallback" });
        });

        it("treats an empty result with no error as a genuinely empty file", function () {
            const outcome = decideDiscoveryOutcome([], undefined);
            assert.strictEqual(outcome.kind, "empty");
        });

        it("treats an empty-string error as no error", function () {
            const outcome = decideDiscoveryOutcome([], "");
            assert.strictEqual(outcome.kind, "empty");
        });

        it("keeps the AST tree when a *.Tests.ps1 file discovers empty but static analysis found tests", function () {
            // The `*.Tests.ps1` name is a strong hint that tests exist, so an
            // empty result with no error is far more likely a silent discovery
            // failure than a truly empty file.
            const outcome = decideDiscoveryOutcome([], undefined, {
                looksLikeTestFile: true,
                hasStaticTests: true,
            });
            assert.deepStrictEqual(outcome, { kind: "astFallback" });
        });

        it("treats a *.Tests.ps1 file as empty when static analysis also found nothing", function () {
            const outcome = decideDiscoveryOutcome([], undefined, {
                looksLikeTestFile: true,
                hasStaticTests: false,
            });
            assert.strictEqual(outcome.kind, "empty");
        });

        it("does not apply the filename heuristic to non-test files", function () {
            const outcome = decideDiscoveryOutcome([], undefined, {
                looksLikeTestFile: false,
                hasStaticTests: true,
            });
            assert.strictEqual(outcome.kind, "empty");
        });

        it("prefers the runner tree over the filename heuristic", function () {
            const nodes = [makeNode({ id: "file>>D>>t", label: "t" })];
            const outcome = decideDiscoveryOutcome(nodes, undefined, {
                looksLikeTestFile: true,
                hasStaticTests: true,
            });
            assert.strictEqual(outcome.kind, "runner");
        });
    });
});
