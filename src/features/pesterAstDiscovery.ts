// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import * as path from "path";
import type { PesterTestNode } from "./pesterRunnerInvoker";
import vscode = require("vscode");

/**
 * Eager test discovery via PSES's `documentSymbol` provider.
 *
 * Why a second discovery path? VS Code only calls `TestController.resolveHandler`
 * when the user expands a file in the Test Explorer, which means in-editor
 * "gutter" decorations (the green/red dots next to each `It` / `Describe`)
 * never appear before the user has shown some interest in a file.
 *
 * PowerShell Editor Services already walks the AST eagerly to produce CodeLens
 * entries for `Describe` / `Context` / `It`, so we piggy-back on the same
 * symbols. They arrive as a flat `SymbolInformation`-shaped list (PSES uses
 * `SymbolType.Function`), but `vscode.executeDocumentSymbolProvider` may
 * return nested `DocumentSymbol[]` from other extensions — both shapes work.
 *
 * The IDs we produce here MUST match what `PesterRunner.ps1 -Discover` emits,
 * so that when the user clicks "Run" on an AST-discovered item the runner's
 * result events bind to the right `TestItem`. The shared scheme — inspired
 * by Justin Grote's `pester/vscode-adapter` — is:
 *
 *     `${normalisedFilePath}>>BlockName>>BlockName>>TestName`
 *
 * where each `Name` is the trimmed, UNEXPANDED Pester block / test name
 * (so `It 'greets <Name>' -ForEach @(...)` contributes `greets <Name>`, not
 * `greets Alice`). At run time the runner appends sorted `>>Key=Value`
 * segments per ForEach iteration so each instance has a unique id, and the
 * controller resolves the original (unexpanded) AST `TestItem` to all of
 * its iterations via id-prefix lookup.
 */

/** Separator used between every segment of a Pester test id. */
export const ID_SEP = ">>";

const PESTER_BLOCK_REGEX = /^(Describe|Context|It)\b/i;

/**
 * Extract the test name (the first string / bareword argument) from the
 * leading line of a Pester block, as captured by PSES's symbol provider.
 *
 * PSES sets the symbol name to the trimmed text of the line up to but not
 * including the opening `{`, e.g. `Describe 'Get-Greeting'`, `It "throws on
 * empty"`, `Context -Name MyContext -Tag Slow`. We accept:
 *   - single-quoted strings: `Describe 'Foo'`
 *   - double-quoted strings: `It "foo"`
 *   - barewords with no whitespace: `Context Foo`
 *   - explicit `-Name <value>` form (PSES often emits this verbatim).
 */
export function extractPesterBlockName(
    symbolName: string,
): { keyword: "Describe" | "Context" | "It"; name: string; tags?: string[] } | undefined {
    const trimmed = symbolName.trim();
    const keywordMatch = /^(Describe|Context|It)\b/i.exec(trimmed);
    if (keywordMatch === null) {
        return undefined;
    }
    const keyword = keywordMatch[1].toLowerCase();
    const normalised =
        keyword === "describe"
            ? "Describe"
            : keyword === "context"
              ? "Context"
              : "It";
    let rest = trimmed.substring(keywordMatch[0].length).trim();
    // Strip a trailing opening brace if PSES left it (defensive — its
    // CodeLens path normally removes it already).
    if (rest.endsWith("{")) {
        rest = rest.slice(0, -1).trimEnd();
    }
    if (rest.length === 0) {
        return undefined;
    }
    // Pull tags out of the parameter list before we consume the name; the
    // `-Tag` parameter can appear before OR after `-Name`, and either before
    // or after the positional name, so a free-form scan is the simplest
    // robust approach. Splice the matched range out of `rest` so the
    // downstream name parser doesn't treat `-Tag` as a bareword name.
    const tagScan = scanTagParameter(rest);
    if (tagScan !== undefined) {
        rest = (rest.substring(0, tagScan.start) +
            " " +
            rest.substring(tagScan.end)).trim();
        if (rest.length === 0) {
            return undefined;
        }
    }
    const tags = tagScan?.tags ?? [];
    // Skip a leading `-Name ` parameter, including its short form.
    const nameParam = /^-Name\s+/i.exec(rest);
    if (nameParam !== null) {
        rest = rest.substring(nameParam[0].length);
    }
    const result = (name: string): { keyword: "Describe" | "Context" | "It"; name: string; tags?: string[] } => {
        return tags.length > 0
            ? { keyword: normalised, name, tags }
            : { keyword: normalised, name };
    };
    // Quoted: capture between matching quotes, allowing PowerShell's `''` and
    // `""` escape sequences inside (we only consume up to the closing quote
    // that isn't doubled).
    const quoteChar = rest.charAt(0);
    if (quoteChar === "'" || quoteChar === '"') {
        let i = 1;
        let value = "";
        while (i < rest.length) {
            const ch = rest.charAt(i);
            if (ch === quoteChar) {
                if (rest.charAt(i + 1) === quoteChar) {
                    value += ch;
                    i += 2;
                    continue;
                }
                return result(value);
            }
            value += ch;
            i++;
        }
        // Unterminated quote — bail out rather than guess.
        return undefined;
    }
    // Bareword: name runs until whitespace or end.
    const bareword = /^(\S+)/.exec(rest);
    if (bareword === null) {
        return undefined;
    }
    return result(bareword[1]);
}

/**
 * Scan a single line of Pester-block parameter text for `-Tag` / `-Tags`
 * values. Handles the common syntaxes:
 *   `-Tag 'slow'`, `-Tag 'a','b'`, `-Tag @('a', 'b')`, `-Tag slow,fast`,
 *   `-Tags 'foo'` (Pester accepts the plural alias).
 * Returns an empty array when no `-Tag` parameter is present. Intentionally
 * forgiving: unrecognised constructs collapse to an empty result rather than
 * raising, since this powers a cosmetic gutter feature.
 */
export function extractTagsFromLine(line: string): string[] {
    return scanTagParameter(line)?.tags ?? [];
}

/**
 * Locate the `-Tag` / `-Tags` parameter in `line` and return both the parsed
 * tag values AND the substring range the parameter (with its values)
 * occupies. Callers can splice that range out before further parsing so
 * `-Tag 'slow'` doesn't bleed into the positional name argument.
 */
function scanTagParameter(line: string): { tags: string[]; start: number; end: number } | undefined {
    const tagMatch = /(?:^|\s)-Tags?\b\s*/i.exec(line);
    if (tagMatch === null) {
        return undefined;
    }
    // Anchor `start` at the `-` so the splice removes the whole switch.
    const start = tagMatch.index + (tagMatch[0].startsWith(" ") ? 1 : 0);
    let i = tagMatch.index + tagMatch[0].length;
    const len = line.length;
    if (i >= len) {
        return { tags: [], start, end: len };
    }
    // Step over a leading `@(` if present and remember to consume its `)`.
    let expectClosingParen = false;
    if (line.charAt(i) === "@" && line.charAt(i + 1) === "(") {
        i += 2;
        expectClosingParen = true;
    }
    const tags: string[] = [];
    while (i < len) {
        // Skip whitespace and separators.
        while (i < len && /[\s,]/.test(line.charAt(i))) {
            i++;
        }
        if (i >= len) break;
        const ch = line.charAt(i);
        if (ch === ")") {
            i++;
            expectClosingParen = false;
            break;
        }
        // Another parameter (e.g. `-ForEach`, `-Name`) ends the tag list.
        if (ch === "-" && i + 1 < len && /[A-Za-z]/.test(line.charAt(i + 1))) {
            break;
        }
        // `{` would start a scriptblock body — definitely past the params.
        if (ch === "{") {
            break;
        }
        if (ch === "'" || ch === '"') {
            const quote = ch;
            i++;
            let value = "";
            while (i < len) {
                const c = line.charAt(i);
                if (c === quote) {
                    if (line.charAt(i + 1) === quote) {
                        value += c;
                        i += 2;
                        continue;
                    }
                    i++;
                    break;
                }
                value += c;
                i++;
            }
            if (value.length > 0) {
                tags.push(value);
            }
            continue;
        }
        // Bareword: a contiguous run of non-whitespace, non-separator chars.
        const wordStart = i;
        while (i < len && !/[\s,)]/.test(line.charAt(i))) {
            i++;
        }
        const value = line.substring(wordStart, i);
        if (value.length > 0 && !value.startsWith("$") && !value.startsWith("@")) {
            tags.push(value);
        }
    }
    if (expectClosingParen) {
        // We never saw the matching `)` — scan ahead to find it so the splice
        // doesn't leave it dangling. Stop at `{` to be safe.
        while (i < len && line.charAt(i) !== ")" && line.charAt(i) !== "{") {
            i++;
        }
        if (i < len && line.charAt(i) === ")") {
            i++;
        }
    }
    // De-duplicate while preserving order.
    const seen = new Set<string>();
    const unique: string[] = [];
    for (const t of tags) {
        if (!seen.has(t)) {
            seen.add(t);
            unique.push(t);
        }
    }
    return { tags: unique, start, end: i };
}

/**
 * A unified shape covering the two return types of
 * `vscode.executeDocumentSymbolProvider`: nested `DocumentSymbol[]` and flat
 * `SymbolInformation[]`. We only care about a name and the range that the
 * symbol covers.
 */
interface UnifiedSymbol {
    name: string;
    range: vscode.Range;
    children: UnifiedSymbol[];
}

function flatten(
    raw:
        | vscode.DocumentSymbol[]
        | vscode.SymbolInformation[]
        | null
        | undefined,
): UnifiedSymbol[] {
    if (raw === null || raw === undefined) {
        return [];
    }
    const out: UnifiedSymbol[] = [];
    for (const item of raw) {
        // `executeDocumentSymbolProvider` returns either nested
        // `DocumentSymbol[]` or flat `SymbolInformation[]`. Distinguish by
        // structural property — `children` on DocumentSymbol, `location` on
        // SymbolInformation. The `unknown` cast appeases the TS narrowing
        // since both element types share the array slot.
        const candidate = item as unknown as {
            name: string;
            children?: vscode.DocumentSymbol[];
            range?: vscode.Range;
            location?: vscode.Location;
        };
        if (candidate.children !== undefined && candidate.range !== undefined) {
            out.push({
                name: candidate.name,
                range: candidate.range,
                children: flatten(candidate.children),
            });
        } else if (candidate.location !== undefined) {
            out.push({
                name: candidate.name,
                range: candidate.location.range,
                children: [],
            });
        }
    }
    return out;
}

/**
 * Convert document symbols into a `PesterTestNode[]` tree.
 *
 * If the symbols arrive flat (PSES), we rebuild the Describe → Context → It
 * hierarchy by testing range containment in document order. If they arrive
 * nested (a non-PSES provider), we descend through the children recursively.
 */
export function extractPesterBlocksFromSymbols(
    symbols:
        | vscode.DocumentSymbol[]
        | vscode.SymbolInformation[]
        | null
        | undefined,
    file: string,
): PesterTestNode[] {
    const unified = flatten(symbols);
    const pesterOnly = collectPesterSymbols(unified);
    if (pesterOnly.length === 0) {
        return [];
    }
    // Sort so containers come before their children, then ties broken by
    // earlier-end-first (which produces a stable parent before child).
    pesterOnly.sort((a, b) => {
        const c = a.range.start.compareTo(b.range.start);
        if (c !== 0) {
            return c;
        }
        return b.range.end.compareTo(a.range.end);
    });

    const fileNormal = normaliseFilePath(file);
    interface StackFrame {
        node: PesterTestNode;
        name: string;
        chain: string[];
        range: vscode.Range;
    }
    const stack: StackFrame[] = [];
    const roots: PesterTestNode[] = [];

    for (const sym of pesterOnly) {
        const parsed = extractPesterBlockName(sym.name);
        if (parsed === undefined) {
            continue;
        }
        while (
            stack.length > 0 &&
            !stack[stack.length - 1].range.contains(sym.range)
        ) {
            stack.pop();
        }
        const parentChain =
            stack.length > 0 ? stack[stack.length - 1].chain : [];
        const chain = [...parentChain, parsed.name];
        const id = buildAstId(fileNormal, chain);
        const node: PesterTestNode = {
            id,
            label: parsed.name,
            kind: parsed.keyword === "It" ? "test" : "block",
            file: fileNormal,
            line: sym.range.start.line + 1,
            children: [],
        };
        if (parsed.tags && parsed.tags.length > 0) {
            node.tags = parsed.tags;
        }
        if (stack.length === 0) {
            roots.push(node);
        } else {
            stack[stack.length - 1].node.children.push(node);
        }
        if (parsed.keyword !== "It") {
            stack.push({ node, name: parsed.name, chain, range: sym.range });
        }
    }
    return roots;
}

function collectPesterSymbols(symbols: UnifiedSymbol[]): UnifiedSymbol[] {
    const out: UnifiedSymbol[] = [];
    const walk = (list: UnifiedSymbol[]): void => {
        for (const s of list) {
            if (PESTER_BLOCK_REGEX.test(s.name.trim())) {
                out.push(s);
            }
            if (s.children.length > 0) {
                walk(s.children);
            }
        }
    };
    walk(symbols);
    return out;
}

/**
 * Build a Pester test id from a normalised file path and a chain of
 * UNEXPANDED block / test names. AST discovery only ever produces this
 * shape; the runner adds sorted `>>Key=Value` segments per ForEach
 * iteration after the chain.
 */
export function buildAstId(file: string, chain: readonly string[]): string {
    for (const segment of chain) {
        if (segment.includes(ID_SEP)) {
            throw new Error(
                `Pester test names cannot contain '${ID_SEP}' (the id separator). Offending name: '${segment}'.`,
            );
        }
    }
    return [file, ...chain].join(ID_SEP);
}

/**
 * Normalise a file path so we produce the same string the runner and the
 * file-level `TestItem` (which uses `vscode.Uri.file(...).fsPath`) both use.
 * On Windows `vscode.Uri.file('C:\\…').fsPath` returns a lowercase drive
 * letter, so we mirror that here.
 */
function normaliseFilePath(file: string): string {
    const resolved = path.resolve(file);
    if (process.platform === "win32" && /^[A-Za-z]:/.test(resolved)) {
        return resolved.charAt(0).toLowerCase() + resolved.substring(1);
    }
    return resolved;
}

/**
 * A text-based fallback that scans a `*.Tests.ps1` document for
 * `Describe` / `Context` / `It` calls and builds a `PesterTestNode[]`
 * tree by tracking `{}` brace depth.
 *
 * We use this when PSES's `documentSymbol` provider doesn't respond (the
 * language server may still be starting up, may not be installed, or may be
 * broken). It deliberately doesn't try to be clever about strings, here-docs,
 * or comments — for the gutter-decoration use case, missing a couple of
 * edge-case blocks is fine, but never producing anything is not.
 *
 * Items declared with `-ForEach` or `-TestCases` are reported as `block`s
 * (rather than `test`s) because Pester expands one source-line declaration
 * into N tests at run time. The controller will trigger a real runner
 * discovery to fill in the expanded cases.
 */
const TEST_LINE_REGEX = /^[\s\t]*(Describe|Context|It)\b/i;
const TEST_FULL_REGEX =
    /^[\s\t]*(Describe|Context|It)\s+(?:-Name\s+)?(?:'((?:''|[^'])*)'|"((?:""|[^"])*)"|(\S+))/i;
const FOREACH_LINE_REGEX = /(-ForEach|-TestCases)\b/i;

export function extractPesterBlocksFromText(
    text: string,
    file: string,
): PesterTestNode[] {
    interface Frame {
        node: PesterTestNode;
        name: string;
        chain: string[];
        brace: number;
    }
    const fileNormal = normaliseFilePath(file);
    const roots: PesterTestNode[] = [];
    const stack: Frame[] = [];
    const lines = text.split(/\r?\n/);
    let brace = 0;
    for (let lineNo = 0; lineNo < lines.length; lineNo++) {
        const line = lines[lineNo];
        if (TEST_LINE_REGEX.test(line)) {
            const match = TEST_FULL_REGEX.exec(line);
            if (match !== null) {
                const keyword = (match[1].charAt(0).toUpperCase() +
                    match[1].slice(1).toLowerCase()) as
                    | "Describe"
                    | "Context"
                    | "It";
                // The regex's quoted/bareword alternatives are mutually
                // exclusive — exactly one of groups 2/3/4 carries the name.
                // ESLint flags `!== undefined` as "always true" because the
                // capture-group types are inferred as plain string; use a
                // truthiness check instead, accepting that an empty quoted
                // name (`It '' {}`) collapses to the bareword branch.
                const rawSingle = match[2];
                const rawDouble = match[3];
                const rawBare = match[4];
                let name: string;
                if (typeof rawSingle === "string") {
                    name = rawSingle.replace(/''/g, "'");
                } else if (typeof rawDouble === "string") {
                    name = rawDouble.replace(/""/g, '"');
                } else {
                    name = rawBare;
                }
                while (
                    stack.length > 0 &&
                    brace <= stack[stack.length - 1].brace
                ) {
                    stack.pop();
                }
                const parentChain =
                    stack.length > 0 ? stack[stack.length - 1].chain : [];
                const chain = [...parentChain, name];
                const id = buildAstId(fileNormal, chain);
                // Items declared with `-ForEach` or `-TestCases` expand into
                // N tests at runtime; surface them as blocks so the user gets
                // a chevron and the runner can fill in the real cases.
                const hasForEach = FOREACH_LINE_REGEX.test(line);
                const tags = extractTagsFromLine(line);
                const node: PesterTestNode = {
                    id,
                    label: name,
                    kind: keyword === "It" && !hasForEach ? "test" : "block",
                    file: fileNormal,
                    line: lineNo + 1,
                    children: [],
                };
                if (tags.length > 0) {
                    node.tags = tags;
                }
                if (stack.length === 0) {
                    roots.push(node);
                } else {
                    stack[stack.length - 1].node.children.push(node);
                }
                // Open the new scope at the current brace level. The `{`
                // counter is bumped below when we process the same line's
                // characters. Also push `It -ForEach` so descendant blocks
                // (rare but legal) would still be tracked.
                stack.push({ node, name, chain, brace });
            }
        }
        brace += countBracesIgnoringStrings(line);
    }
    return roots;
}

/**
 * Count `{` minus `}` on a single line while ignoring those inside the most
 * common PowerShell string forms and line comments. Far from a real parser,
 * but enough for typical Pester layouts.
 */
function countBracesIgnoringStrings(line: string): number {
    let depth = 0;
    let i = 0;
    while (i < line.length) {
        const ch = line.charAt(i);
        if (ch === "#") {
            break;
        }
        if (ch === "'") {
            i++;
            while (i < line.length) {
                if (line.charAt(i) === "'") {
                    if (line.charAt(i + 1) === "'") {
                        i += 2;
                        continue;
                    }
                    i++;
                    break;
                }
                i++;
            }
            continue;
        }
        if (ch === '"') {
            i++;
            while (i < line.length) {
                if (line.charAt(i) === "`" && i + 1 < line.length) {
                    i += 2;
                    continue;
                }
                if (line.charAt(i) === '"') {
                    if (line.charAt(i + 1) === '"') {
                        i += 2;
                        continue;
                    }
                    i++;
                    break;
                }
                i++;
            }
            continue;
        }
        if (ch === "{") {
            depth++;
        } else if (ch === "}") {
            depth--;
        }
        i++;
    }
    return depth;
}

/** True when the document should be considered for Pester AST discovery. */
export function isPesterTestDocument(uri: vscode.Uri): boolean {
    if (uri.scheme !== "file") {
        return false;
    }
    return /\.tests\.ps1$/i.test(uri.fsPath);
}

/**
 * Ask VS Code for the document symbols of `uri` and translate them into a
 * `PesterTestNode[]` tree. Returns an empty array if no provider responds
 * (e.g. PSES not yet activated) or the file has no Pester blocks.
 */
export async function discoverViaDocumentSymbols(
    uri: vscode.Uri,
): Promise<PesterTestNode[]> {
    const symbols = await vscode.commands.executeCommand<
        vscode.DocumentSymbol[] | vscode.SymbolInformation[] | undefined
    >("vscode.executeDocumentSymbolProvider", uri);
    return extractPesterBlocksFromSymbols(symbols, uri.fsPath);
}
