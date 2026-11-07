import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";

// Source integration regression: keep the original text in one persistent slot,
// not a second copy inside the transient optimization preview. No model calls.
const source = readFileSync(new URL("../src/components/canvas/canvas-node-prompt-panel.tsx", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const tree = ts.createSourceFile("canvas-node-prompt-panel.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function find(predicate: (node: ts.Node) => boolean) {
    const nodes: ts.Node[] = [];
    function visit(node: ts.Node) {
        if (predicate(node)) nodes.push(node);
        ts.forEachChild(node, visit);
    }
    visit(tree);
    return nodes;
}
const disclosures = find(node => ts.isJsxSelfClosingElement(node) && node.tagName.getText(tree) === "OriginalPromptDisclosure");

test("the prompt panel has exactly one original-prompt disclosure", () => {
    expect(disclosures).toHaveLength(1);
});

test("original prompt remains outside the transient result preview and hidden for caption mode", () => {
    expect(disclosures).toHaveLength(1);
    const disclosure = disclosures[0];
    expect(disclosure.getText(tree)).toContain("text={originalPrompt}");
    expect(disclosure.getText(tree)).toContain("key={`${node.id}:${originalPrompt}`}");
    let expression = disclosure.parent;
    while (ts.isParenthesizedExpression(expression)) expression = expression.parent;
    expect(ts.isConditionalExpression(expression)).toBe(true);
    expect((expression as ts.ConditionalExpression).condition.getText(tree)).toBe('mode !== "text" && originalPrompt');
    // The preview is an immediately invoked arrow function. The retained slot
    // belongs directly to CanvasNodePromptPanel, so hiding that preview cannot
    // remove the only copy of the user's original text.
    let ancestor: ts.Node | undefined = disclosure.parent;
    while (ancestor && !ts.isFunctionDeclaration(ancestor)) {
        expect(ts.isArrowFunction(ancestor) || ts.isFunctionExpression(ancestor)).toBe(false);
        ancestor = ancestor.parent;
    }
    expect((ancestor as ts.FunctionDeclaration).name?.text).toBe("CanvasNodePromptPanel");
});

test("closing, replacing and appending optimized results keep the original prompt", () => {
    const clear = find(node => ts.isVariableDeclaration(node) && node.name.getText(tree) === "clearOptimizePreview")[0] as ts.VariableDeclaration;
    expect(clear).toBeDefined();
    expect(clear.initializer?.getText(tree)).toContain("promptOptimizePrompt: undefined");
    expect(clear.initializer?.getText(tree)).not.toContain("promptOptimizeSource:");
    expect(source).toContain("applyPromptResult(previewPrompt);\n                                        clearPreview();");
    expect(source).toContain('applyPromptResult(draft.trim() ? `${draft.trim()}\\n\\n${previewPrompt}` : previewPrompt);');
});
