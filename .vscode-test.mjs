import { defineConfig } from "@vscode/test-cli";
import { existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const launchArgs = [
    // Other extensions are unnecessary while testing
    "--disable-extensions",
    // Undocumented but valid option to use a temporary profile for testing
    "--profile-temp",
    // Keep the user-data-dir short. The default lives under .vscode-test/
    // which, combined with the nested checkout paths CI uses, can push the
    // main IPC socket path over the macOS 103-char AF_UNIX limit and fail
    // with EINVAL. See microsoft/vscode#196543.
    `--user-data-dir=${join(tmpdir(), "vscp")}`,
];

export default defineConfig([
    {
        label: "unit",
        files: "test/**/*.test.ts",
        // It may break CI but we'll know sooner rather than later
        version: "insiders",
        launchArgs,
        workspaceFolder: `test/${existsSync("C:\\powershell-7\\pwsh.exe") ? "OneBranch" : "TestEnvironment"}.code-workspace`,
        mocha: {
            ui: "bdd", // describe, it, etc.
            require: ["esbuild-register"], // transpile TypeScript on-the-fly
            slow: 2 * 1000, // 2 seconds for slow test
            timeout: 2 * 60 * 1000, // 2 minutes to allow for debugging
        },
    },
    {
        // End-to-end Pester Test Explorer tests. These drive a real `pwsh` and
        // the installed Pester against the fixture workspace, so they need
        // their own workspace folder and a longer timeout than the unit suite.
        // Files are named *.e2e.ts so the unit glob above never picks them up.
        label: "e2e",
        files: "test/e2e/**/*.e2e.ts",
        version: "insiders",
        launchArgs,
        workspaceFolder: "test/fixtures/pester-e2e",
        mocha: {
            ui: "bdd",
            require: ["esbuild-register"],
            slow: 30 * 1000,
            timeout: 5 * 60 * 1000,
        },
    },
]);
