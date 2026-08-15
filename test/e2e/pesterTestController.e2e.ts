// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// End-to-end tests for the Pester Test Explorer integration.
//
// Unlike test/features/PesterTestController.test.ts — which unit-tests the pure
// helpers with canned event payloads — everything here runs for real: a live
// `pwsh`, the installed Pester module, `scripts/PesterRunner.ps1`, and the
// `.Tests.ps1` files in test/fixtures/pester-e2e (the workspace folder for this
// vscode-test config).
//
// Each fixture pins a specific regression; see the comment header in each
// .Tests.ps1 file for what it stands for.

import * as assert from "assert";
import * as path from "path";
import * as vscode from "vscode";
import { E2EDriver, flatten, treeDepth } from "./harness";

const RUNNER = path.resolve(
    __dirname,
    "..",
    "..",
    "scripts",
    "PesterRunner.ps1",
);

/** Discovery of six fixture files against real Pester is not instant. */
const DISCOVER_TIMEOUT = 3 * 60 * 1000;
const RUN_TIMEOUT = 5 * 60 * 1000;

/** `TestItem.error` is a string or a MarkdownString; normalise for asserts. */
function errorText(error: vscode.TestItem["error"]): string {
    if (error === undefined) {
        return "";
    }
    return typeof error === "string" ? error : error.value;
}

describe("Pester Test Explorer E2E", function () {
    let driver: E2EDriver;

    before(function () {
        driver = new E2EDriver(RUNNER);
    });

    after(function () {
        driver.dispose();
    });

    describe("Discovery", function () {
        before(async function () {
            this.timeout(DISCOVER_TIMEOUT);
            await driver.discoverFiles();
        });

        it("finds every .Tests.ps1 file in the workspace", function () {
            const ids: string[] = [];
            driver.controller.items.forEach((i) =>
                ids.push(path.basename(i.id)),
            );
            for (const expected of [
                "Simple.Tests.ps1",
                "Deep.Tests.ps1",
                "ForEach.Tests.ps1",
                "Helper.Tests.ps1",
                "Broken.Tests.ps1",
                "Calculator.Tests.ps1",
            ]) {
                assert.ok(
                    ids.includes(expected),
                    `${expected} missing from ${ids.join(", ")}`,
                );
            }
        });

        it("builds the block/test tree for a simple file", async function () {
            this.timeout(DISCOVER_TIMEOUT);
            const file = driver.fileItem("Simple.Tests.ps1");
            await driver.discoverFile(file);

            const labels = [...flatten(file).values()].map((i) => i.label);
            assert.ok(labels.includes("Simple"), "missing Describe block");
            assert.ok(labels.includes("Arithmetic"), "missing Context block");
            assert.ok(
                labels.includes("adds two numbers"),
                `missing It; got ${labels.join(" | ")}`,
            );
        });

        it("gives every test item a source range", async function () {
            this.timeout(DISCOVER_TIMEOUT);
            const file = driver.fileItem("Simple.Tests.ps1");
            await driver.discoverFile(file);
            for (const item of flatten(file).values()) {
                assert.ok(
                    item.range !== undefined,
                    `${item.label} has no range, so the editor gutter cannot render it`,
                );
            }
        });

        // Regression: Write-JsonLine used ConvertTo-Json -Depth 8, which
        // collapsed deep `children` arrays into a String and made
        // buildItemTree throw "nodes.map is not a function".
        it("survives deeply nested blocks without truncating the tree", async function () {
            this.timeout(DISCOVER_TIMEOUT);
            const file = driver.fileItem("Deep.Tests.ps1");
            await driver.discoverFile(file);

            assert.strictEqual(
                treeDepth(file),
                8,
                "expected 7 nested blocks plus the It leaf",
            );
            const labels = [...flatten(file).values()].map((i) => i.label);
            assert.ok(
                labels.includes("survives serialization at depth 7"),
                "the deepest test did not survive JSON serialization",
            );
        });

        // Regression: Get-TestId stringifies -ForEach data, so 1, '1' and 1.0
        // all produced the same id and VS Code rejected the duplicates with
        // "Attempted to insert a duplicate test item ID".
        it("disambiguates -ForEach cases that stringify identically", async function () {
            this.timeout(DISCOVER_TIMEOUT);
            const file = driver.fileItem("ForEach.Tests.ps1");
            await driver.discoverFile(file);

            const items = [...flatten(file).values()];
            const collisions = items.filter((i) => i.id.includes("_=1"));
            assert.strictEqual(
                collisions.length,
                3,
                `expected 3 distinct items for 1 / '1' / 1.0, got ${collisions
                    .map((i) => i.id)
                    .join(", ")}`,
            );
            assert.strictEqual(
                new Set(collisions.map((i) => i.id)).size,
                3,
                "the three -ForEach cases share an id",
            );
        });

        // Regression: discovery-only mode (Run.SkipRun) never applied Pester's
        // BeforeContainer, so helpers a file needs at discovery time were
        // undefined. The runner bridges this by dot-sourcing the repo-root
        // Pester.BeforeContainer.ps1 before discovery.
        it("applies Pester.BeforeContainer.ps1 during discovery", async function () {
            this.timeout(DISCOVER_TIMEOUT);
            const file = driver.fileItem("Helper.Tests.ps1");
            await driver.discoverFile(file);

            assert.strictEqual(
                file.error,
                undefined,
                `discovery reported: ${errorText(file.error)}`,
            );
            const labels = [...flatten(file).values()].map((i) => i.label);
            for (const expected of [
                "discovers case alpha",
                "discovers case beta",
            ]) {
                assert.ok(
                    labels.includes(expected),
                    `${expected} missing; the BeforeContainer helper did not resolve at discovery time`,
                );
            }
        });

        // Regression: a container that failed discovery used to report zero
        // tests with no error signal at all.
        it("surfaces a discovery failure on the file item", async function () {
            this.timeout(DISCOVER_TIMEOUT);
            const file = driver.fileItem("Broken.Tests.ps1");
            await driver.discoverFile(file);

            assert.ok(
                file.error !== undefined,
                "a file that fails discovery must show why",
            );
            assert.match(
                errorText(file.error),
                /Get-DefinitelyUndefinedFixtureHelper/,
                "the error should name the missing helper",
            );
        });

        it("does not let one broken file block the others", async function () {
            this.timeout(DISCOVER_TIMEOUT);
            const good = driver.fileItem("Simple.Tests.ps1");
            await driver.discoverFile(good);
            assert.strictEqual(good.error, undefined);
            assert.ok(
                flatten(good).size > 0,
                "a healthy file must still discover when a sibling is broken",
            );
        });
    });

    describe("Running", function () {
        it("reports passed, failed and skipped on the right items", async function () {
            this.timeout(RUN_TIMEOUT);
            const file = driver.fileItem("Simple.Tests.ps1");
            await driver.discoverFile(file);

            const run = await driver.run(vscode.TestRunProfileKind.Run, [file]);

            const byOutcome = (o: string): string[] =>
                run.outcomes.filter((x) => x.outcome === o).map((x) => x.id);

            assert.ok(
                byOutcome("passed").some((id) =>
                    id.includes("adds two numbers"),
                ),
                `'adds two numbers' should pass; got ${JSON.stringify(run.outcomes)}`,
            );
            assert.ok(
                byOutcome("passed").some((id) => id.includes("concatenates")),
                "'concatenates' should pass",
            );
            assert.ok(
                byOutcome("failed").some((id) =>
                    id.includes("fails on purpose"),
                ),
                "'fails on purpose' should fail",
            );
            assert.ok(
                byOutcome("skipped").some((id) => id.includes("is skipped")),
                "'is skipped' should be skipped",
            );
            assert.ok(run.ended, "the TestRun was never ended");
        });

        it("attaches the assertion message to a failure", async function () {
            this.timeout(RUN_TIMEOUT);
            const file = driver.fileItem("Simple.Tests.ps1");
            await driver.discoverFile(file);

            const run = await driver.run(vscode.TestRunProfileKind.Run, [file]);
            const failure = run.outcomes.find((o) => o.outcome === "failed");

            assert.ok(failure, "expected one failure");
            assert.ok(
                failure.messages.length > 0,
                "a failed test must carry a TestMessage",
            );
            assert.match(
                failure.messages.join("\n"),
                /3/,
                "the message should mention the expected value",
            );
        });

        it("records a duration for each test", async function () {
            this.timeout(RUN_TIMEOUT);
            const file = driver.fileItem("Simple.Tests.ps1");
            await driver.discoverFile(file);

            const run = await driver.run(vscode.TestRunProfileKind.Run, [file]);
            const timed = run.outcomes.filter(
                (o) => o.outcome === "passed" && o.duration !== undefined,
            );
            assert.ok(timed.length > 0, "no durations were reported");
        });

        // Regression: the BeforeContainer helper has to be present for the run
        // phase too, not just discovery.
        it("runs tests whose cases come from BeforeContainer", async function () {
            this.timeout(RUN_TIMEOUT);
            const file = driver.fileItem("Helper.Tests.ps1");
            await driver.discoverFile(file);

            const run = await driver.run(vscode.TestRunProfileKind.Run, [file]);
            const passed = run.outcomes.filter((o) => o.outcome === "passed");
            assert.strictEqual(
                passed.length,
                2,
                `expected alpha and beta to pass; got ${JSON.stringify(run.outcomes)}`,
            );
        });

        // Regression: this is the scenario that crashed with
        // "PesterTestController run failed: nodes.map is not a function".
        it("runs every test in the workspace without crashing", async function () {
            this.timeout(RUN_TIMEOUT);
            const run = await driver.run(
                vscode.TestRunProfileKind.Run,
                undefined,
            );

            assert.ok(
                run.outcomes.length >= 10,
                `Run all produced only ${run.outcomes.length} outcomes`,
            );
            const passed = run.outcomes.filter((o) => o.outcome === "passed");
            assert.ok(
                passed.length >= 8,
                `expected most fixtures to pass; got ${JSON.stringify(
                    run.outcomes.map((o) => `${o.outcome} ${o.id}`),
                )}`,
            );
            // The deep file is the one that used to truncate.
            assert.ok(
                run.outcomes.some((o) =>
                    o.id.includes("survives serialization at depth 7"),
                ),
                "the deeply nested test never reported a result",
            );
        });
    });

    describe("Coverage", function () {
        it("produces per-line statement coverage for the file under test", async function () {
            this.timeout(RUN_TIMEOUT);
            const file = driver.fileItem("Calculator.Tests.ps1");
            await driver.discoverFile(file);

            const run = await driver.run(vscode.TestRunProfileKind.Coverage, [
                file,
            ]);

            assert.ok(
                run.coverage.length > 0,
                "the coverage profile added no FileCoverage",
            );
            const calc = run.coverage.find((c) =>
                c.uri.fsPath.endsWith("Calculator.ps1"),
            );
            assert.ok(
                calc,
                `no coverage for Calculator.ps1; got ${run.coverage
                    .map((c) => c.uri.fsPath)
                    .join(", ")}`,
            );
            assert.ok(
                calc.statementCoverage.covered > 0,
                "expected some covered statements",
            );
            assert.ok(
                calc.statementCoverage.total > calc.statementCoverage.covered,
                "Get-UncoveredValue should leave uncovered statements",
            );

            // The inline gutter decorations come from loadDetailedCoverage.
            const profile = driver.profiles.get(
                vscode.TestRunProfileKind.Coverage,
            );
            assert.ok(
                profile?.loadDetailedCoverage,
                "no detailed coverage hook",
            );
            const details = await profile.loadDetailedCoverage(
                undefined as unknown as vscode.TestRun,
                calc,
                new vscode.CancellationTokenSource().token,
            );
            assert.ok(
                details.length > 0,
                "loadDetailedCoverage returned nothing, so no inline decorations",
            );
            const covered = details.filter(
                (d) =>
                    d instanceof vscode.StatementCoverage &&
                    Number(d.executed) > 0,
            );
            const missed = details.filter(
                (d) =>
                    d instanceof vscode.StatementCoverage &&
                    Number(d.executed) === 0,
            );
            assert.ok(covered.length > 0, "no executed lines reported");
            assert.ok(
                missed.length > 0,
                "Get-UncoveredValue's lines should be reported as missed",
            );
        });
    });
});
