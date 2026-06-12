// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import * as assert from "assert";
import * as vscode from "vscode";
import {
    extractPesterBlockName,
    extractPesterBlocksFromSymbols,
    extractPesterBlocksFromText,
} from "../../src/features/pesterAstDiscovery";

function symbol(
    name: string,
    startLine: number,
    endLine: number,
    children: vscode.DocumentSymbol[] = [],
): vscode.DocumentSymbol {
    const range = new vscode.Range(startLine, 0, endLine, 0);
    const sym = new vscode.DocumentSymbol(
        name,
        "",
        vscode.SymbolKind.Function,
        range,
        range,
    );
    sym.children = children;
    return sym;
}

function flatSymbol(
    name: string,
    file: string,
    startLine: number,
    endLine: number,
): vscode.SymbolInformation {
    return new vscode.SymbolInformation(
        name,
        vscode.SymbolKind.Function,
        "",
        new vscode.Location(
            vscode.Uri.file(file),
            new vscode.Range(startLine, 0, endLine, 0),
        ),
    );
}

describe("extractPesterBlockName", function () {
    it("parses single-quoted Describe", function () {
        assert.deepStrictEqual(
            extractPesterBlockName("Describe 'Get-Greeting'"),
            { keyword: "Describe", name: "Get-Greeting" },
        );
    });

    it("parses double-quoted It", function () {
        assert.deepStrictEqual(extractPesterBlockName('It "throws on empty"'), {
            keyword: "It",
            name: "throws on empty",
        });
    });

    it("parses a bareword Context name", function () {
        assert.deepStrictEqual(extractPesterBlockName("Context MyContext"), {
            keyword: "Context",
            name: "MyContext",
        });
    });

    it("handles the explicit -Name parameter", function () {
        assert.deepStrictEqual(
            extractPesterBlockName("Context -Name 'with whitespace'"),
            { keyword: "Context", name: "with whitespace" },
        );
    });

    it("ignores a trailing opening brace", function () {
        assert.deepStrictEqual(extractPesterBlockName("Describe 'X' {"), {
            keyword: "Describe",
            name: "X",
        });
    });

    it("handles doubled-quote escape inside a single-quoted name", function () {
        assert.deepStrictEqual(extractPesterBlockName("It 'Bob''s test'"), {
            keyword: "It",
            name: "Bob's test",
        });
    });

    it("returns undefined when the keyword is not Pester's", function () {
        assert.strictEqual(
            extractPesterBlockName("Function MyHelper"),
            undefined,
        );
    });

    it("returns undefined when there's no name argument", function () {
        assert.strictEqual(extractPesterBlockName("Describe"), undefined);
    });
});

describe("extractPesterBlocksFromSymbols", function () {
    const file =
        process.platform === "win32"
            ? "C:\\repo\\Sample.Tests.ps1"
            : "/repo/Sample.Tests.ps1";

    it("builds a Describe > Context > It tree from nested DocumentSymbols", function () {
        const tree = extractPesterBlocksFromSymbols(
            [
                symbol("Describe 'Get-Greeting'", 1, 20, [
                    symbol("Context 'with a name'", 2, 15, [
                        symbol("It 'returns hello'", 3, 5),
                        symbol("It 'is friendly'", 6, 8),
                    ]),
                    symbol("Context 'with no name'", 16, 19, [
                        symbol("It 'throws'", 17, 18),
                    ]),
                ]),
            ],
            file,
        );

        assert.strictEqual(tree.length, 1);
        const describe = tree[0];
        assert.strictEqual(describe.label, "Get-Greeting");
        assert.strictEqual(describe.kind, "block");
        assert.strictEqual(describe.children.length, 2);
        assert.strictEqual(describe.children[0].label, "with a name");
        assert.strictEqual(describe.children[0].children.length, 2);
        const firstIt = describe.children[0].children[0];
        assert.strictEqual(firstIt.label, "returns hello");
        assert.strictEqual(firstIt.kind, "test");
        // ID scheme must match PesterRunner.ps1: `<file>::<Name> > <Name> > ...`.
        const expectedFile = file;
        assert.strictEqual(
            firstIt.id,
            `${expectedFile}::Get-Greeting > with a name > returns hello`,
        );
    });

    it("re-nests a flat SymbolInformation list by range containment", function () {
        const tree = extractPesterBlocksFromSymbols(
            [
                flatSymbol("Describe 'Outer'", file, 1, 20),
                flatSymbol("Context 'Middle'", file, 2, 15),
                flatSymbol("It 'inner test'", file, 3, 5),
                flatSymbol("It 'sibling test'", file, 6, 8),
                flatSymbol("It 'lonely top-level'", file, 25, 27),
            ],
            file,
        );

        assert.strictEqual(tree.length, 2, "two top-level items");
        const describe = tree[0];
        assert.strictEqual(describe.label, "Outer");
        assert.strictEqual(describe.children.length, 1);
        const ctx = describe.children[0];
        assert.strictEqual(ctx.label, "Middle");
        assert.strictEqual(ctx.children.length, 2);
        assert.strictEqual(ctx.children[0].label, "inner test");
        assert.strictEqual(ctx.children[1].label, "sibling test");

        const orphan = tree[1];
        assert.strictEqual(orphan.label, "lonely top-level");
        assert.strictEqual(orphan.kind, "test");
        // A top-level It is still an `It`, not a block.
        assert.strictEqual(orphan.kind, "test");
    });

    it("ignores non-Pester symbols", function () {
        const tree = extractPesterBlocksFromSymbols(
            [
                symbol("Function MyHelper", 1, 5),
                symbol("BeforeAll", 6, 8),
                symbol("Describe 'Real'", 10, 15, [
                    symbol("It 'works'", 11, 12),
                ]),
            ],
            file,
        );

        assert.strictEqual(tree.length, 1);
        assert.strictEqual(tree[0].label, "Real");
        assert.strictEqual(tree[0].children.length, 1);
        assert.strictEqual(tree[0].children[0].label, "works");
    });

    it("records 1-based line numbers", function () {
        const tree = extractPesterBlocksFromSymbols(
            [symbol("Describe 'X'", 7, 12, [symbol("It 'works'", 8, 10)])],
            file,
        );
        // The DocumentSymbol range starts at 0-indexed line 7, so we emit 8.
        assert.strictEqual(tree[0].line, 8);
        assert.strictEqual(tree[0].children[0].line, 9);
    });

    it("returns an empty array when no symbols are returned", function () {
        assert.deepStrictEqual(
            extractPesterBlocksFromSymbols(undefined, file),
            [],
        );
        assert.deepStrictEqual(extractPesterBlocksFromSymbols(null, file), []);
        assert.deepStrictEqual(extractPesterBlocksFromSymbols([], file), []);
    });
});

describe("extractPesterBlocksFromText", function () {
    const file =
        process.platform === "win32"
            ? "C:\\repo\\Sample.Tests.ps1"
            : "/repo/Sample.Tests.ps1";

    it("parses a real Greeter.Tests.ps1-shaped file", function () {
        const text = [
            "Describe 'Get-Greeting' {",
            "    Context 'with a plain name' {",
            "        It 'returns the default Hello greeting' {",
            "            Get-Greeting -Name 'World' | Should -Be 'Hello, World!'",
            "        }",
            "        It 'honours the chosen style' {",
            "            Get-Greeting -Name 'World' -Style 'Hi' | Should -Be 'Hi, World!'",
            "        }",
            "    }",
            "    Context 'with surrounding whitespace' {",
            "        It 'trims the name before greeting' {",
            "            Get-Greeting -Name '  Pester  ' | Should -Be 'Hello, Pester!'",
            "        }",
            "    }",
            "}",
            "",
            "Describe 'Get-Farewell' {",
            '    It "says goodbye to a named person" {',
            "        Get-Farewell -Name 'World' | Should -Be 'Goodbye, World.'",
            "    }",
            "}",
        ].join("\r\n");

        const tree = extractPesterBlocksFromText(text, file);
        assert.strictEqual(tree.length, 2);

        const getGreeting = tree[0];
        assert.strictEqual(getGreeting.label, "Get-Greeting");
        assert.strictEqual(getGreeting.kind, "block");
        assert.strictEqual(getGreeting.children.length, 2);

        const plain = getGreeting.children[0];
        assert.strictEqual(plain.label, "with a plain name");
        assert.strictEqual(plain.children.length, 2);
        assert.strictEqual(
            plain.children[0].label,
            "returns the default Hello greeting",
        );
        assert.strictEqual(plain.children[0].kind, "test");
        assert.strictEqual(
            plain.children[0].id,
            `${file}::Get-Greeting > with a plain name > returns the default Hello greeting`,
        );

        const farewell = tree[1];
        assert.strictEqual(farewell.label, "Get-Farewell");
        assert.strictEqual(farewell.children.length, 1);
        assert.strictEqual(
            farewell.children[0].label,
            "says goodbye to a named person",
        );
    });

    it("ignores braces inside comments and strings", function () {
        const text = [
            "Describe 'Outer' {",
            "    # closing brace } in a comment",
            "    $x = 'string with } brace'",
            '    $y = "double-quoted } brace"',
            "    It 'still nested' {",
            "        $true | Should -BeTrue",
            "    }",
            "}",
        ].join("\n");
        const tree = extractPesterBlocksFromText(text, file);
        assert.strictEqual(tree.length, 1);
        assert.strictEqual(tree[0].label, "Outer");
        assert.strictEqual(tree[0].children.length, 1);
        assert.strictEqual(tree[0].children[0].label, "still nested");
    });

    it("records 1-based line numbers", function () {
        const text = [
            "",
            "",
            "Describe 'X' {",
            "    It 'works' {",
            "    }",
            "}",
        ].join("\n");
        const tree = extractPesterBlocksFromText(text, file);
        assert.strictEqual(tree[0].line, 3);
        assert.strictEqual(tree[0].children[0].line, 4);
    });

    it("handles single-quote escape inside the name", function () {
        const text = ["It 'Bob''s test' {", "}"].join("\n");
        const tree = extractPesterBlocksFromText(text, file);
        assert.strictEqual(tree.length, 1);
        assert.strictEqual(tree[0].label, "Bob's test");
    });

    it("returns an empty array for a file with no Pester blocks", function () {
        const tree = extractPesterBlocksFromText("function Foo {}", file);
        assert.deepStrictEqual(tree, []);
    });

    it("marks `It -ForEach` as a block (Pester expands it at runtime)", function () {
        const text = [
            "Describe 'X' {",
            "    It 'greets <Name>' -ForEach @(",
            "        @{ Name = 'Alice' }",
            "        @{ Name = 'Bob' }",
            "    ) {",
            "        $true | Should -BeTrue",
            "    }",
            "    It 'plain test' {",
            "        $true | Should -BeTrue",
            "    }",
            "}",
        ].join("\n");
        const tree = extractPesterBlocksFromText(text, file);
        assert.strictEqual(tree.length, 1);
        const describe = tree[0];
        assert.strictEqual(describe.children.length, 2);
        assert.strictEqual(describe.children[0].label, "greets <Name>");
        assert.strictEqual(
            describe.children[0].kind,
            "block",
            "ForEach It should be a block so the runner can expand it",
        );
        assert.strictEqual(describe.children[1].label, "plain test");
        assert.strictEqual(describe.children[1].kind, "test");
    });

    it("marks `It -TestCases` (legacy parameter name) as a block", function () {
        const text = [
            "Describe 'X' {",
            "    It 'case <_>' -TestCases @(1, 2) {",
            "        $true | Should -BeTrue",
            "    }",
            "}",
        ].join("\n");
        const tree = extractPesterBlocksFromText(text, file);
        assert.strictEqual(tree[0].children[0].kind, "block");
    });
});
