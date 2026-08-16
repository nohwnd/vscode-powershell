// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// Config for the workbench UI tests in test/ui. These launch VS Code as an
// Electron app and assert on what a user actually sees. See docs/pester.md.
//
// The extension-host suites (npm test, npm run test:e2e) stay on vscode-test;
// this only covers the parts of the experience the `vscode` API cannot see.

import { defineConfig } from "@playwright/test";

export default defineConfig({
    testDir: "./test/ui",
    // Every test boots its own VS Code, which is slow but keeps the tests
    // independent, and "first start" genuinely first start.
    timeout: 3 * 60 * 1000,
    expect: { timeout: 30 * 1000 },
    // One VS Code at a time. They are heavy, and several racing for the
    // PowerShell process is a good way to make the suite flaky.
    workers: 1,
    fullyParallel: false,
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 1 : 0,
    reporter: process.env.CI
        ? [["list"], ["html", { outputFolder: "out/ui-report", open: "never" }]]
        : [["list"]],
    use: {
        screenshot: "only-on-failure",
        trace: process.env.CI ? "retain-on-failure" : "off",
    },
    outputDir: "out/ui-results",
});
