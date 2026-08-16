// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// The Test Explorer tree as rendered. Every assertion here is about what is on
// screen, which is the half the extension-host tests cannot reach.

import {
    clearNotifications,
    expandRow,
    expect,
    openTestExplorer,
    rowLabels,
    test,
    treeRow,
} from "./vscode";

test.describe("Test Explorer", () => {
    test.beforeEach(async ({ win }) => {
        await clearNotifications(win);
        await openTestExplorer(win);
    });

    test("lists every test file in the workspace", async ({ win }) => {
        for (const name of [
            "Simple.Tests.ps1",
            "Deep.Tests.ps1",
            "ForEach.Tests.ps1",
            "Helper.Tests.ps1",
            "Broken.Tests.ps1",
            "Calculator.Tests.ps1",
        ]) {
            await expect(treeRow(win, name)).toBeVisible();
        }
    });

    test("shows every file as not yet run before anything is clicked", async ({
        win,
    }) => {
        const labels = await rowLabels(win);
        const files = labels.filter((l) => l.includes("Tests.ps1"));
        expect(files.length).toBeGreaterThanOrEqual(6);
        for (const f of files) {
            expect(f).toContain("Not yet run");
        }
    });

    test("expands a file to reveal its Describe block", async ({ win }) => {
        await expandRow(win, "Simple.Tests.ps1");
        await expect(treeRow(win, "Simple (")).toBeVisible();
    });

    test("expands down to the individual tests", async ({ win }) => {
        await expandRow(win, "Simple.Tests.ps1");
        await expandRow(win, "Simple (");
        await expandRow(win, "Arithmetic");
        await expect(treeRow(win, "adds two numbers")).toBeVisible();
        await expect(treeRow(win, "fails on purpose")).toBeVisible();
        await expect(treeRow(win, "is skipped")).toBeVisible();
    });

    test("renders seven levels of nesting without losing the deepest test", async ({
        win,
    }) => {
        // The depth-8 JSON truncation used to drop this whole subtree.
        await expandRow(win, "Deep.Tests.ps1");
        for (const level of ["Depth L1", "L2", "L3", "L4", "L5", "L6", "L7"]) {
            await expandRow(win, level);
        }
        await expect(
            treeRow(win, "survives serialization at depth 7"),
        ).toBeVisible();
    });

    test("expands the -ForEach template into its three cases", async ({
        win,
    }) => {
        await expandRow(win, "ForEach.Tests.ps1");
        await expandRow(win, "ForEach id collisions");
        // The cheap AST pass shows the template "case <_>" straight away, and
        // real Pester discovery replaces it with the expanded cases. 1, '1'
        // and 1.0 all render as "case 1"; only the ids underneath differ,
        // which is what used to collapse them into one row.
        await expect
            .poll(
                async () =>
                    (await rowLabels(win)).filter((l) => l.startsWith("case 1"))
                        .length,
                { timeout: 120_000, message: "the three cases never appeared" },
            )
            .toBe(3);
    });

    test("shows the cases that come from Pester.BeforeContainer.ps1", async ({
        win,
    }) => {
        await expandRow(win, "Helper.Tests.ps1");
        await expandRow(win, "Helper from BeforeContainer");
        await expect(treeRow(win, "discovers case alpha")).toBeVisible();
        await expect(treeRow(win, "discovers case beta")).toBeVisible();
    });

    test("keeps the file that fails discovery in the tree rather than dropping it", async ({
        win,
    }) => {
        // Pester cannot discover this one. It still has to be listed, so the
        // user can see it exists and find out why, instead of it silently not
        // being there. The reason itself rides on TestItem.error, which VS
        // Code surfaces once the item is interacted with.
        await expect(treeRow(win, "Broken.Tests.ps1")).toBeVisible();
        const labels = await rowLabels(win);
        expect(labels.some((l) => l.startsWith("Broken.Tests.ps1"))).toBe(true);
    });

    test("offers the run, debug and coverage actions in its toolbar", async ({
        win,
    }) => {
        for (const action of [
            "Run Tests",
            "Debug Tests",
            "Run Tests with Coverage",
            "Refresh Tests",
        ]) {
            await expect(
                win
                    .locator(
                        `.action-label[aria-label*=${JSON.stringify(action)}]`,
                    )
                    .first(),
            ).toBeVisible();
        }
    });

    test("offers per-test run actions on hover", async ({ win }) => {
        const row = treeRow(win, "Simple.Tests.ps1");
        await row.hover();
        for (const action of ["Run Test", "Debug Test"]) {
            await expect(
                row
                    .locator(
                        `.action-label[aria-label*=${JSON.stringify(action)}]`,
                    )
                    .first(),
            ).toBeVisible();
        }
    });

    test("collapses a file again once expanded", async ({ win }) => {
        await expandRow(win, "Simple.Tests.ps1");
        await expect(treeRow(win, "Simple (")).toBeVisible();
        await treeRow(win, "Simple.Tests.ps1")
            .locator(".monaco-tl-twistie")
            .click();
        await expect(treeRow(win, "Simple (")).toBeHidden();
    });
});
