// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import vscode = require("vscode");
import type { ResolvedFileCoverage } from "./jacoco";

/**
 * Convert resolved JaCoCo coverage records into VS Code's `FileCoverage` shape so
 * they can be attached to a `vscode.TestRun` via `addCoverage()`. The caller is
 * responsible for resolving each parsed entry to an absolute path first via
 * `resolveCoverageSources()`.
 *
 * Pester emits a per-line `mi`/`ci` count of instructions missed/covered. Each
 * line becomes a `StatementCoverage`:
 *   - `executed` is the instruction-covered count (truthy when > 0).
 *   - the position is `(line - 1, 0)` because VS Code uses 0-indexed lines.
 *
 * Branch counts are intentionally not surfaced because Pester always emits 0.
 */
export function toFileCoverage(
    resolved: readonly ResolvedFileCoverage[],
): vscode.FileCoverage[] {
    const result: vscode.FileCoverage[] = [];
    for (const entry of resolved) {
        const uri = vscode.Uri.file(entry.absolutePath);
        const statements = entry.parsed.lines.map((line) => {
            const position = new vscode.Position(Math.max(0, line.line - 1), 0);
            return new vscode.StatementCoverage(line.covered, position);
        });
        result.push(vscode.FileCoverage.fromDetails(uri, statements));
    }
    return result;
}
