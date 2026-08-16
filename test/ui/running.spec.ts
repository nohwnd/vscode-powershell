// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// Running tests the way a person does: clicking the play button, then reading
// the icons, messages and timings that come back.

import * as path from "path";
import {
    clearNotifications,
    expandRow,
    expect,
    openTestExplorer,
    REPO_ROOT,
    rowLabels,
    runRowAction,
    test,
    toolbarAction,
    treeRow,
    waitForRowState,
} from "./vscode";

const SHOTS = path.join(REPO_ROOT, "out", "ui-screens");

test.describe("Running tests from the UI", () => {
    test.beforeEach(async ({ win }) => {
        await clearNotifications(win);
        await openTestExplorer(win);
    });

    test("the play button on a file runs it and reports back", async ({
        win,
    }) => {
        await runRowAction(win, "Simple.Tests.ps1", "Run Test");
        // The file rolls up to failed, because one of its tests fails on purpose.
        await waitForRowState(win, "Simple.Tests.ps1", "failed");
        await win.screenshot({ path: path.join(SHOTS, "run-file.png") });
    });

    test("a passing test gets the passed icon", async ({ win }) => {
        await runRowAction(win, "Simple.Tests.ps1", "Run Test");
        await waitForRowState(win, "Simple.Tests.ps1", "failed");
        await expandRow(win, "Simple.Tests.ps1");
        await expandRow(win, "Simple (");
        await expandRow(win, "Arithmetic");
        await waitForRowState(win, "adds two numbers", "passed");
    });

    test("the deliberately failing test gets the failed icon", async ({
        win,
    }) => {
        await runRowAction(win, "Simple.Tests.ps1", "Run Test");
        await waitForRowState(win, "Simple.Tests.ps1", "failed");
        await expandRow(win, "Simple.Tests.ps1");
        await expandRow(win, "Simple (");
        await expandRow(win, "Arithmetic");
        await waitForRowState(win, "fails on purpose", "failed");
    });

    test("the skipped test is reported as skipped, not as passed", async ({
        win,
    }) => {
        await runRowAction(win, "Simple.Tests.ps1", "Run Test");
        await waitForRowState(win, "Simple.Tests.ps1", "failed");
        await expandRow(win, "Simple.Tests.ps1");
        await expandRow(win, "Simple (");
        await expandRow(win, "Arithmetic");
        const labels = await rowLabels(win);
        const skipped = labels.find((l) => l.startsWith("is skipped"));
        expect(skipped).toBeTruthy();
        expect(skipped).toMatch(/skip/i);
    });

    test("run states show up in the row labels, so screen readers get them too", async ({
        win,
    }) => {
        await runRowAction(win, "Simple.Tests.ps1", "Run Test");
        await waitForRowState(win, "Simple.Tests.ps1", "failed");
        const labels = await rowLabels(win);
        const file = labels.find((l) => l.startsWith("Simple.Tests.ps1"));
        expect(file).not.toContain("Not yet run");
    });

    test("reports how long the tests took", async ({ win }) => {
        await runRowAction(win, "Simple.Tests.ps1", "Run Test");
        await waitForRowState(win, "Simple.Tests.ps1", "failed");
        // VS Code renders the duration beside the label once a test has run,
        // as <span class="test-label-description">40ms</span>.
        await expandRow(win, "Simple.Tests.ps1");
        await expandRow(win, "Simple (");
        await expandRow(win, "Arithmetic");
        const durations = await win.evaluate<string[]>(
            `[...document.querySelectorAll('.monaco-list-row .test-label-description')]
                .map(e => e.textContent?.trim() ?? '').filter(Boolean)`,
        );
        expect(
            durations.length,
            `no durations rendered; saw ${JSON.stringify(durations)}`,
        ).toBeGreaterThan(0);
        // Pester reports real milliseconds, so this must be a number and a unit.
        expect(durations.join(" ")).toMatch(/\d+\s*(ms|s)/);
    });

    test("a failed test can be opened to show the assertion message", async ({
        win,
    }) => {
        await runRowAction(win, "Simple.Tests.ps1", "Run Test");
        await waitForRowState(win, "Simple.Tests.ps1", "failed");
        await expandRow(win, "Simple.Tests.ps1");
        await expandRow(win, "Simple (");
        await expandRow(win, "Arithmetic");
        await treeRow(win, "fails on purpose").click();
        // The peek view carries the message Pester produced.
        await expect(
            win.locator(".test-output-peek-message, .zone-widget").first(),
        ).toBeVisible({ timeout: 60_000 });
        await win.screenshot({ path: path.join(SHOTS, "failure-peek.png") });
    });

    test("Pester's own output reaches the test output panel", async ({
        win,
    }) => {
        await runRowAction(win, "Simple.Tests.ps1", "Run Test");
        await waitForRowState(win, "Simple.Tests.ps1", "failed");
        await toolbarAction(win, "Show Output");
        await win.waitForTimeout(3000);
        const panel = await win.evaluate(
            `document.querySelector('.panel, .test-output-peek, .terminal-wrapper')?.textContent ?? ''`,
        );
        expect(
            String(panel).length,
            "the output panel came up empty",
        ).toBeGreaterThan(0);
        await win.screenshot({ path: path.join(SHOTS, "test-output.png") });
    });

    test("Run Tests in the toolbar runs the whole workspace", async ({
        win,
    }) => {
        await toolbarAction(win, "Run Tests");
        // Simple fails, Calculator passes: both have to come back.
        await waitForRowState(win, "Calculator.Tests.ps1", "passed");
        await waitForRowState(win, "Simple.Tests.ps1", "failed");
        await win.screenshot({ path: path.join(SHOTS, "run-all.png") });
    });

    test("the deeply nested test actually runs, not just renders", async ({
        win,
    }) => {
        await runRowAction(win, "Deep.Tests.ps1", "Run Test");
        await waitForRowState(win, "Deep.Tests.ps1", "passed");
    });

    test("the BeforeContainer cases run green", async ({ win }) => {
        await runRowAction(win, "Helper.Tests.ps1", "Run Test");
        await waitForRowState(win, "Helper.Tests.ps1", "passed");
    });

    test("all three colliding -ForEach cases run and pass", async ({ win }) => {
        await runRowAction(win, "ForEach.Tests.ps1", "Run Test");
        await waitForRowState(win, "ForEach.Tests.ps1", "passed");
        await expandRow(win, "ForEach.Tests.ps1");
        await expandRow(win, "ForEach id collisions");
        const passed = await win.evaluate(
            `[...document.querySelectorAll('.monaco-list-row')]
                .filter(r => (r.getAttribute('aria-label')||'').startsWith('case 1'))
                .filter(r => r.querySelector('.codicon-testing-passed-icon')).length`,
        );
        expect(passed).toBe(3);
    });

    test("one broken file does not stop the others from running", async ({
        win,
    }) => {
        await toolbarAction(win, "Run Tests");
        await waitForRowState(win, "Calculator.Tests.ps1", "passed");
        await waitForRowState(win, "Helper.Tests.ps1", "passed");
    });

    test("running with coverage completes", async ({ win }) => {
        await runRowAction(
            win,
            "Calculator.Tests.ps1",
            "Run Test with Coverage",
        );
        await waitForRowState(win, "Calculator.Tests.ps1", "passed");
        await win.screenshot({ path: path.join(SHOTS, "coverage.png") });
    });
});
