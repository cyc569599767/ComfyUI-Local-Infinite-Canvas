// Pure history operations shared by UI and regression tests. No transport/storage.
export type HistoryMessage = {
    id: string;
    role: "user" | "assistant" | "system" | "tool" | "error";
    text: string;
    turnId?: string;
    promptText?: string;
    hasAttachments?: boolean;
    attachments?: Array<{ id: string; name: string; url: string }>;
};
export type ReplayAttachment = { dataUrl: string };
export type HistoryApiMessage = { role: "user" | "assistant"; content: unknown };

export function regenerationPlan<T extends HistoryMessage>(messages: T[], id: string): { user: T; prefix: T[]; removed: T[] } | null {
    const index = messages.findIndex(message => message.id === id);
    if (index < 0) return null;
    const selected = messages[index];
    if (selected.role !== "user" && selected.role !== "assistant") return null;
    let userIndex = selected.role === "user" ? index : -1;
    if (selected.role === "assistant") {
        if (selected.turnId) userIndex = messages.findIndex((item, i) => i < index && item.role === "user" && (item.turnId || item.id) === selected.turnId);
        else for (let i = index - 1; i >= 0; i--) { if (messages[i].role === "user") { userIndex = i; break; } }
    }
    if (userIndex < 0) return null;
    return { user: messages[userIndex], prefix: messages.slice(0, userIndex), removed: messages.slice(userIndex) };
}

export function deleteHistoryMessage<T extends HistoryMessage>(messages: T[], id: string): T[] {
    // Delete the selected message and the whole suffix, irrespective of role.
    // A stale/missing selector is a no-op, never an implicit deletion of the last item.
    const index = messages.findIndex(message => message.id === id);
    return index < 0 ? messages : messages.slice(0, index);
}

export function requiresUnavailableAttachments(user: HistoryMessage, attachments?: ReplayAttachment[]): boolean {
    return Boolean(user.hasAttachments || user.attachments?.length) && !attachments?.length;
}

export function rebuildChatHistory(messages: HistoryMessage[], attachmentsFor: (id: string) => ReplayAttachment[] | undefined): HistoryApiMessage[] {
    return messages.flatMap<HistoryApiMessage>(item => {
        if (item.role !== "user" && item.role !== "assistant") return [];
        if (item.role === "assistant") return item.text.trim() ? [{ role: "assistant" as const, content: item.text }] : [];
        const images = attachmentsFor(item.id);
        const text = item.promptText ?? item.text;
        const content = images?.length
            ? [{ type: "text", text: text || "请查看这些图片。" }, ...images.map(image => ({ type: "image_url", image_url: { url: image.dataUrl } }))]
            : requiresUnavailableAttachments(item) ? `${text}\n[此历史消息的图片已不可用；不要推测图片内容。]` : text;
        return [{ role: "user" as const, content }];
    });
}

export function persistChatMessage<T extends HistoryMessage & { title?: string; meta?: string; reasoning?: string }>(message: T) {
    return {
        id: message.id, role: message.role, title: message.title, text: message.text,
        meta: message.meta, reasoning: message.reasoning, turnId: message.turnId,
        promptText: message.promptText,
        hasAttachments: Boolean(message.hasAttachments || message.attachments?.length),
    };
}
