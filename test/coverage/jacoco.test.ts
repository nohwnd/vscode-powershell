// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import {
    parseJaCoCoXml,
    resolveCoverageSources,
} from "../../src/coverage/jacoco";

const fixturesDir = path.resolve(__dirname, "..", "fixtures", "coverage");

function loadFixture(name: string): string {
    return fs.readFileSync(path.join(fixturesDir, name), "utf8");
}

describe("JaCoCo XML parser", function () {
    describe("with the Pester 5.7.1 CoverageGutters fixture", function () {
        const xml = loadFixture("pester-5.7.1-coverage-gutters.xml");
        const files = parseJaCoCoXml(xml);

        it("emits one entry per <sourcefile>", function () {
            assert.strictEqual(files.length, 2);
        });

        it("records package + sourcefile exactly as Pester emitted them", function () {
            // CoverageGutters: <sourcefile name="Alpha.ps1"> (leaf only).
            assert.strictEqual(files[0].packagePath, "src/a");
            assert.strictEqual(files[0].sourcefile, "Alpha.ps1");
            assert.strictEqual(files[1].packagePath, "src/b");
            assert.strictEqual(files[1].sourcefile, "Beta.ps1");
        });

        it("captures every <line> element with hit/miss counts", function () {
            assert.deepStrictEqual(
                files[0].lines.map((l) => l.line),
                [1],
            );
            assert.strictEqual(files[0].lines[0].covered, 1);
            assert.strictEqual(files[0].lines[0].missed, 0);
        });

        it("defaults branch counts to zero for the Pester output", function () {
            for (const f of files) {
                assert.ok(
                    f.lines.every(
                        (l) =>
                            l.branchesMissed === 0 && l.branchesCovered === 0,
                    ),
                );
            }
        });
    });

    describe("with the Pester 5.7.1 JaCoCo fixture", function () {
        const xml = loadFixture("pester-5.7.1-jacoco.xml");
        const files = parseJaCoCoXml(xml);

        it("preserves the JaCoCo-flavour subpath in <sourcefile>", function () {
            // JaCoCo: <sourcefile name="a/Alpha.ps1"> (re-includes package leaf).
            assert.strictEqual(files[0].packagePath, "src/a");
            assert.strictEqual(files[0].sourcefile, "a/Alpha.ps1");
            assert.strictEqual(files[1].packagePath, "src/b");
            assert.strictEqual(files[1].sourcefile, "b/Beta.ps1");
        });

        it("captures the same line data as the CoverageGutters flavour", function () {
            const other = parseJaCoCoXml(
                loadFixture("pester-5.7.1-coverage-gutters.xml"),
            );
            assert.deepStrictEqual(
                files.map((f) => f.lines),
                other.map((f) => f.lines),
            );
        });
    });

    describe("with the Pester 6.0.0 JaCoCo fixture", function () {
        const xml = loadFixture("pester-6.0.0-jacoco.xml");
        const files = parseJaCoCoXml(xml);

        it("emits the same shape as the Pester 5.7.1 JaCoCo flavour", function () {
            assert.strictEqual(files.length, 2);
            assert.strictEqual(files[0].packagePath, "src/a");
            assert.strictEqual(files[0].sourcefile, "a/Alpha.ps1");
            assert.strictEqual(files[1].packagePath, "src/b");
            assert.strictEqual(files[1].sourcefile, "b/Beta.ps1");
        });
    });

    describe("edge cases", function () {
        it("preserves package name '.' for a single-file root layout", function () {
            const xml = `<?xml version="1.0"?>
<report name="Pester">
  <package name=".">
    <sourcefile name="MyScript.ps1">
      <line nr="1" mi="0" ci="1" mb="0" cb="0"/>
    </sourcefile>
  </package>
</report>`;
            const files = parseJaCoCoXml(xml);
            assert.strictEqual(files[0].packagePath, ".");
            assert.strictEqual(files[0].sourcefile, "MyScript.ps1");
        });

        it("normalises backslashes in package and sourcefile names", function () {
            const xml = `<?xml version="1.0"?>
<report name="Pester">
  <package name="src\\nested">
    <sourcefile name="MyScript.ps1">
      <line nr="1" mi="0" ci="1" mb="0" cb="0"/>
    </sourcefile>
  </package>
</report>`;
            const files = parseJaCoCoXml(xml);
            assert.strictEqual(files[0].packagePath, "src/nested");
        });

        it("supports multiple <sourcefile> entries inside one package", function () {
            const xml = `<?xml version="1.0"?>
<report name="Pester">
  <package name="src">
    <sourcefile name="A.ps1"><line nr="1" mi="0" ci="2"/></sourcefile>
    <sourcefile name="B.ps1"><line nr="5" mi="3" ci="0"/></sourcefile>
  </package>
</report>`;
            const files = parseJaCoCoXml(xml);
            assert.strictEqual(files.length, 2);
            assert.strictEqual(files[0].sourcefile, "A.ps1");
            assert.strictEqual(files[0].lines[0].covered, 2);
            assert.strictEqual(files[1].sourcefile, "B.ps1");
            assert.strictEqual(files[1].lines[0].missed, 3);
        });

        it("throws a clear error when given non-JaCoCo input", function () {
            assert.throws(
                () => parseJaCoCoXml("<notajacocoreport/>"),
                /does not contain a <report> element/,
            );
        });

        it("returns an empty array for an empty <report>", function () {
            const files = parseJaCoCoXml(
                '<?xml version="1.0"?><report name="Pester"></report>',
            );
            assert.deepStrictEqual(files, []);
        });
    });
});

describe("resolveCoverageSources", function () {
    const candidates = [
        "C:\\tmp\\repo\\src\\a\\Alpha.ps1",
        "C:\\tmp\\repo\\src\\b\\Beta.ps1",
    ];

    it("matches CoverageGutters-style (leaf-only) sourcefiles", function () {
        const parsed = parseJaCoCoXml(
            loadFixture("pester-5.7.1-coverage-gutters.xml"),
        );
        const { resolved, unresolved } = resolveCoverageSources(
            parsed,
            candidates,
        );
        assert.deepStrictEqual(unresolved, []);
        assert.deepStrictEqual(
            resolved.map((r) => r.absolutePath),
            candidates,
        );
    });

    it("matches Pester 5 JaCoCo-flavour sourcefiles via the canonical suffix", function () {
        const parsed = parseJaCoCoXml(loadFixture("pester-5.7.1-jacoco.xml"));
        const { resolved, unresolved } = resolveCoverageSources(
            parsed,
            candidates,
        );
        assert.deepStrictEqual(unresolved, []);
        assert.deepStrictEqual(
            resolved.map((r) => r.absolutePath),
            candidates,
        );
    });

    it("matches Pester 6 JaCoCo sourcefiles identically to Pester 5 JaCoCo", function () {
        const parsed = parseJaCoCoXml(loadFixture("pester-6.0.0-jacoco.xml"));
        const { resolved } = resolveCoverageSources(parsed, candidates);
        assert.deepStrictEqual(
            resolved.map((r) => r.absolutePath),
            candidates,
        );
    });

    it("disambiguates same-basename files in different directories", function () {
        // Two files named "Utils.ps1" in different sibling folders. The package
        // path is what disambiguates them — leaf-only matching would be ambiguous.
        const xml = `<?xml version="1.0"?>
<report name="Pester">
  <package name="src/a">
    <sourcefile name="Utils.ps1"><line nr="1" mi="0" ci="1"/></sourcefile>
  </package>
  <package name="src/b">
    <sourcefile name="Utils.ps1"><line nr="1" mi="1" ci="0"/></sourcefile>
  </package>
</report>`;
        const parsed = parseJaCoCoXml(xml);
        const sameNameCandidates = [
            "C:\\tmp\\repo\\src\\a\\Utils.ps1",
            "C:\\tmp\\repo\\src\\b\\Utils.ps1",
        ];
        const { resolved } = resolveCoverageSources(parsed, sameNameCandidates);
        assert.deepStrictEqual(
            resolved.map((r) => r.absolutePath),
            sameNameCandidates,
        );
    });

    it("reports unresolved entries instead of mismatching them", function () {
        const parsed = parseJaCoCoXml(
            loadFixture("pester-5.7.1-coverage-gutters.xml"),
        );
        const { resolved, unresolved } = resolveCoverageSources(parsed, [
            "C:\\tmp\\repo\\src\\a\\Alpha.ps1",
        ]);
        assert.strictEqual(resolved.length, 1);
        assert.strictEqual(unresolved.length, 1);
        assert.strictEqual(unresolved[0].sourcefile, "Beta.ps1");
    });

    it("is case-insensitive on the path suffix (Windows-friendly)", function () {
        const parsed = parseJaCoCoXml(
            loadFixture("pester-5.7.1-coverage-gutters.xml"),
        );
        const { resolved } = resolveCoverageSources(parsed, [
            "C:\\TMP\\REPO\\SRC\\A\\alpha.PS1",
            "C:\\TMP\\REPO\\SRC\\B\\beta.PS1",
        ]);
        assert.strictEqual(resolved.length, 2);
    });
});
