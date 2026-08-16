// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// What a person sees in the first few seconds after opening a PowerShell
// workspace: does the window come up, does the extension load without
// complaining, does the Testing icon appear at all.

import { expect, test } from "./vscode";

test.describe("Startup experience", () => {
    test("the workbench renders", async ({ win }) => {
        await expect(win.locator(".monaco-workbench")).toBeVisible();
    });

    test("the window is the Extension Development Host on our workspace", async ({
        win,
    }) => {
        const title = await win.title();
        expect(title).toContain("Extension Development Host");
        expect(title).toContain("pester-e2e");
    });

    test("no error notification is raised on startup", async ({ win }) => {
        // Info toasts are expected (extensions disabled, the git prompt).
        // An error one means the extension failed to come up.
        await win.waitForTimeout(5000);
        const errors = await win.evaluate(
            `[...document.querySelectorAll('.notification-list-item')]
                .filter(n => n.querySelector('.codicon-error'))
                .map(n => n.textContent?.trim() ?? '')`,
        );
        expect(errors).toEqual([]);
    });

    test("the status bar is present and reports no problems", async ({
        win,
    }) => {
        const status = win.locator(".statusbar");
        await expect(status).toBeVisible();
        // "0 0" is the errors/warnings counter.
        await expect(
            win.locator('.statusbar-item[id*="problems"], .statusbar-item'),
        ).not.toHaveCount(0);
    });

    test("the Testing icon appears in the activity bar", async ({ win }) => {
        await expect(
            win.locator(
                '.activitybar .action-item .action-label[aria-label^="Test"]',
            ),
        ).toBeVisible({ timeout: 120_000 });
    });

    test("startup notifications are readable, which is how any extension toast would be", async ({
        win,
    }) => {
        // They arrive a few seconds in, and not all at once, so poll for the
        // one we care about rather than reading whatever is up first.
        await expect
            .poll(
                async () =>
                    await win.evaluate(
                        `[...document.querySelectorAll('.notification-list-item-message')]
                            .map(n => n.textContent?.trim() ?? '').join(' | ')`,
                    ),
                {
                    timeout: 60_000,
                    message: "no startup notification appeared",
                },
            )
            // A fresh Extension Development Host always says this one.
            .toContain("extensions are temporarily disabled");
    });

    test("the renderer logs no uncaught errors while starting", async ({
        app,
        win,
    }) => {
        const errors: string[] = [];
        win.on("pageerror", (e) => errors.push(e.message));
        await win.waitForTimeout(5000);
        expect(app).toBeTruthy();
        expect(errors).toEqual([]);
    });
});
