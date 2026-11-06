// The prompt editor may already have inserted connected text. Expand each exact
// upstream text only once, including when a generated sibling is run again.
export function appendGenerationText(prompt: string, texts: Array<{ label: string; text: string }>) {
    let result = prompt;
    for (const { label, text } of texts) {
        const value = text.trim();
        if (!value || result.includes(value)) continue;
        result += `\n\n【${label}】\n${text}`;
    }
    return result;
}
