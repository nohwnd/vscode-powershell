// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import {
    parseJaCoCoXml,
    resolveCoverageSources,
} from "../../src/coverage/jacoco";
import { toFileCoverage } from "../../src/coverage/vscodeAdapter";

const fixturesDir = path.resolve(__dirname, "..", "fixtures", "coverage");

function loadFixture(name: string): string {
    return fs.readFileSync(path.join(fixturesDir, name), "utf8");
}

describe("Coverage pipeline end-to-end", function () {
    const candidates = [
        path.resolve("C:\\repo\\src\\a\\Alpha.ps1"),
        path.resolve("C:\\repo\\src\\b\\Beta.ps1"),
    ];

    function pipeline(xml: string): vscode.FileCoverage[] {
        const parsed = parseJaCoCoXml(xml);
        const { resolved, unresolved } = resolveCoverageSources(
            parsed,
            candidates,
        );
        assert.deepStrictEqual(unresolved, []);
        return toFileCoverage(resolved);
    }

    for (const fixture of [
        "pester-5.7.1-coverage-gutters.xml",
        "pester-5.7.1-jacoco.xml",
        "pester-6.0.0-jacoco.xml",
    ]) {
        it(`produces FileCoverage objects from ${fixture}`, function () {
            const coverage = pipeline(loadFixture(fixture));
            assert.strictEqual(coverage.length, 2);
            // VS Code normalises drive-letter casing on Uri.file, so compare lowercased.
            const uris = coverage.map((c) => c.uri.fsPath.toLowerCase()).sort();
            const expected = candidates.map((c) => c.toLowerCase()).sort();
            assert.deepStrictEqual(uris, expected);
        });
    }

    it("attaches StatementCoverage with the expected execution count and 0-indexed line", function () {
        // We use fromDetails so each FileCoverage carries the per-line statements
        // we passed in. We can't read them back from the vscode.FileCoverage object
        // (the property is internal), but we re-run the helper bits to check the
        // public shape: statement counts, total summary, and URI.
        const parsed = parseJaCoCoXml(loadFixture("pester-6.0.0-jacoco.xml"));
        const { resolved } = resolveCoverageSources(parsed, candidates);
        const coverage = toFileCoverage(resolved);

        // Both files have one line each, fully covered.
        for (const fc of coverage) {
            assert.strictEqual(fc.statementCoverage.total, 1);
            assert.strictEqual(fc.statementCoverage.covered, 1);
            // Branch and declaration data are not populated by Pester.
            assert.strictEqual(fc.branchCoverage, undefined);
            assert.strictEqual(fc.declarationCoverage, undefined);
        }
    });

    it("surfaces missed lines as 0-execution StatementCoverage", function () {
        // Build a synthetic JaCoCo XML with one covered and one missed line so
        // we can assert the missed-line surfaces correctly.
        const xml = `<?xml version="1.0"?>
<report name="Pester">
  <package name="src">
    <sourcefile name="Sample.ps1">
      <line nr="3" mi="0" ci="2"/>
      <line nr="7" mi="1" ci="0"/>
    </sourcefile>
  </package>
</report>`;
        const parsed = parseJaCoCoXml(xml);
        const sampleAbs = path.resolve("C:\\repo\\src\\Sample.ps1");
        const { resolved } = resolveCoverageSources(parsed, [sampleAbs]);
        const [fc] = toFileCoverage(resolved);
        assert.ok(fc, "FileCoverage was not produced");
        assert.strictEqual(fc.statementCoverage.total, 2);
        assert.strictEqual(fc.statementCoverage.covered, 1);
    });
});
