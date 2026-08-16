// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// The other half of the experience: the test affordances inside the editor,
// not in the Test Explorer. Opening a .Tests.ps1 file should put a play button
// in the gutter next to every test, and clicking it should run that test.

import * as path from "path";
import {
    clearNotifications,
    expect,
    openFile,
    REPO_ROOT,
    test,
} from "./vscode";

const SHOTS = path.join(REPO_ROOT, "out", "ui-screens");

test.describe("In the editor", () => {
    test.beforeEach(async ({ win }) => {
        await clearNotifications(win);
    });

    test("opens a test file", async ({ win }) => {
        await openFile(win, "Simple.Tests.ps1");
        await expect(win.locator(".monaco-editor").first()).toBeVisible();
    });

    test("puts a run glyph in the gutter for each test", async ({ win }) => {
        await openFile(win, "Simple.Tests.ps1");
        await expect
            .poll(
                async () =>
                    await win.evaluate(
                        `document.querySelectorAll('.testing-run-glyph.codicon-testing-run-icon').length`,
                    ),
                {
                    timeout: 120_000,
                    message: "no per-test run glyphs appeared in the gutter",
                },
            )
            .toBeGreaterThanOrEqual(3);
        await win.screenshot({ path: path.join(SHOTS, "editor-gutter.png") });
    });

    test("puts a run-all glyph on the Describe and Context blocks", async ({
        win,
    }) => {
        await openFile(win, "Simple.Tests.ps1");
        await expect
            .poll(
                async () =>
                    await win.evaluate(
                        `document.querySelectorAll('.testing-run-glyph.codicon-testing-run-all-icon').length`,
                    ),
                { timeout: 120_000, message: "no block-level run glyphs" },
            )
            .toBeGreaterThanOrEqual(2);
    });

    test("clicking the gutter play button runs that test", async ({ win }) => {
        await openFile(win, "Simple.Tests.ps1");
        const glyph = win
            .locator(".testing-run-glyph.codicon-testing-run-icon")
            .first();
        await glyph.waitFor({ state: "visible", timeout: 120_000 });
        await glyph.click();

        // The glyph turns into a result state once the run comes back.
        await expect
            .poll(
                async () =>
                    await win.evaluate(
                        `document.querySelectorAll('.testing-run-glyph.codicon-testing-passed-icon, .testing-run-glyph.codicon-testing-failed-icon').length`,
                    ),
                {
                    timeout: 150_000,
                    message: "the gutter glyph never showed a result",
                },
            )
            .toBeGreaterThan(0);
        await win.screenshot({
            path: path.join(SHOTS, "editor-gutter-run.png"),
        });
    });

    test("a file with no tests gets no run glyphs", async ({ win }) => {
        // The BeforeContainer helper is a .ps1 but not a test file.
        await openFile(win, "Pester.BeforeContainer.ps1");
        await win.waitForTimeout(5000);
        const glyphs = await win.evaluate(
            `document.querySelectorAll('.testing-run-glyph').length`,
        );
        expect(glyphs).toBe(0);
    });
});
