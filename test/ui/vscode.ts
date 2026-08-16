// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// Playwright fixture that launches VS Code as an Electron app with this
// checkout loaded as a development extension.
//
// Why Playwright and not the extension-host runner: these tests assert on the
// workbench itself, the activity bar icon, the tree rows, the notification
// toasts, the terminal. None of that is reachable from the `vscode` API, which
// deliberately exposes no workbench UI.
//
// Playwright talks to Electron's main process as well as the renderer, which
// is what lets us hide the window. Electron has no real headless mode: on
// Linux CI it runs under Xvfb (the workflow already starts one), and elsewhere
// we hide the BrowserWindow so it does not steal the desktop while still
// rendering, so screenshots and hit-testing keep working. Set UI_VISIBLE=1 to
// watch it happen.

import {
    test as base,
    _electron as electron,
    type ElectronApplication,
    type Locator,
    type Page,
} from "@playwright/test";
import { downloadAndUnzipVSCode } from "@vscode/test-electron";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import * as path from "path";

export const REPO_ROOT = path.resolve(__dirname, "..", "..");
export const FIXTURE_WORKSPACE = path.join(
    REPO_ROOT,
    "test",
    "fixtures",
    "pester-e2e",
);

export interface VSCodeFixtures {
    /** The Electron application, for main-process work. */
    app: ElectronApplication;
    /** The workbench window. */
    win: Page;
}

/**
 * VS Code writes a lot into its user data dir. Give every worker a fresh one
 * so runs cannot interfere with each other or with the developer's real VS
 * Code, and so "first start" state is genuinely first start.
 */
function freshUserDataDir(): string {
    return mkdtempSync(path.join(tmpdir(), "pester-ui-"));
}

export const test = base.extend<VSCodeFixtures>({
    // Playwright fixtures take the other fixtures as the first argument; this
    // one needs none, and an empty pattern is how that is spelled.
    // eslint-disable-next-line no-empty-pattern
    app: async ({}, use) => {
        const executablePath = await downloadAndUnzipVSCode("insiders");
        const app = await electron.launch({
            executablePath,
            args: [
                `--extensionDevelopmentPath=${REPO_ROOT}`,
                // Keep the marketplace PowerShell extension out of the way.
                "--disable-extensions",
                `--user-data-dir=${freshUserDataDir()}`,
                "--skip-release-notes",
                "--skip-welcome",
                "--disable-workspace-trust",
                "--disable-updates",
                "--no-cached-data",
                FIXTURE_WORKSPACE,
            ],
        });
        await use(app);
        await app.close();
    },

    win: async ({ app }, use) => {
        const win = await app.firstWindow();
        // The workbench renders in stages; the shell is the first thing that
        // means "we have a UI to talk to".
        await win.waitForSelector(".monaco-workbench", { timeout: 120_000 });

        if (process.env.UI_VISIBLE !== "1") {
            await app.evaluate(({ BrowserWindow }) => {
                for (const w of BrowserWindow.getAllWindows()) {
                    w.hide();
                }
            });
        }

        await use(win);
    },
});

export { expect } from "@playwright/test";

/** Dismiss the toasts a fresh Extension Development Host always shows. */
export async function clearNotifications(win: Page): Promise<void> {
    const clear = win.locator(
        ".notification-list-item .codicon-notifications-clear",
    );
    for (let i = await clear.count(); i > 0; i--) {
        await clear
            .first()
            .click()
            .catch(() => {
                /* it may have gone on its own */
            });
    }
}

/**
 * Open the Test Explorer by clicking its activity bar icon, like a user, and
 * wait until the tree has actually populated. Waiting on the view's title is
 * not enough: the panel is there long before discovery has put anything in it.
 */
export async function openTestExplorer(win: Page): Promise<void> {
    await win
        .locator('.activitybar .action-item .action-label[aria-label^="Test"]')
        .click();
    await win
        .locator('.monaco-list-row[aria-label*="Tests.ps1"]')
        .first()
        .waitFor({ state: "visible", timeout: 120_000 });
}

/**
 * A row in the Test Explorer tree, found by its label. Rows carry their state
 * in the aria-label, e.g. "Simple.Tests.ps1 (Not yet run)", and the state icon
 * carries it as a codicon class, e.g. codicon-testing-passed-icon.
 */
export function treeRow(win: Page, label: string): Locator {
    return win
        .locator(`.monaco-list-row[aria-label*=${JSON.stringify(label)}]`)
        .first();
}

/** Expand a tree row and wait for its children to appear. */
export async function expandRow(win: Page, label: string): Promise<void> {
    const row = treeRow(win, label);
    await row.waitFor({ state: "visible", timeout: 120_000 });
    if ((await row.getAttribute("aria-expanded")) === "false") {
        await row.locator(".monaco-tl-twistie").click();
    }
    await win.waitForTimeout(500);
}

/** Every row's aria-label, which includes the run state in brackets. */
export async function rowLabels(win: Page): Promise<string[]> {
    return win.evaluate<string[]>(
        `[...document.querySelectorAll('.monaco-list-row[aria-level]')]
            .map(r => r.getAttribute('aria-label') || '')`,
    );
}

/**
 * Click one of the actions that appear on a row on hover: "Run Test",
 * "Debug Test", "Run Test with Coverage".
 */
export async function runRowAction(
    win: Page,
    label: string,
    action: string,
): Promise<void> {
    const row = treeRow(win, label);
    await row.hover();
    await row
        .locator(`.action-label[aria-label*=${JSON.stringify(action)}]`)
        .first()
        .click();
}

/** Open a file in the editor through quick open, the way a user would. */
export async function openFile(win: Page, name: string): Promise<void> {
    await win.keyboard.press("ControlOrMeta+P");
    await win.locator(".quick-input-widget").waitFor({ state: "visible" });
    await win.keyboard.type(name);
    await win.waitForTimeout(1500);
    await win.keyboard.press("Enter");
    await win
        .locator(`.tab .label-name:has-text(${JSON.stringify(name)})`)
        .first()
        .waitFor({ state: "visible", timeout: 60_000 });
}

/** Click a button in the Test Explorer's own toolbar. */
export async function toolbarAction(win: Page, action: string): Promise<void> {
    await win
        .locator(`.action-label[aria-label*=${JSON.stringify(action)}]`)
        .first()
        .click();
}

/**
 * Wait for a row to reach a run state. `state` is the codicon suffix VS Code
 * uses: passed, failed, skipped, errored, queued, running.
 */
export async function waitForRowState(
    win: Page,
    label: string,
    state: string,
    timeout = 150_000,
): Promise<void> {
    await win
        .locator(
            `.monaco-list-row[aria-label*=${JSON.stringify(label)}] .codicon-testing-${state}-icon`,
        )
        .first()
        .waitFor({ state: "visible", timeout });
}
