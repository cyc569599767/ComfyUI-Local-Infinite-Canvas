export type AgentPanelPosition = { x: number; y: number };
export type AgentPanelViewport = { width: number; height: number };

export const AGENT_PANEL_POSITION_KEY = "canvas-agent-panel-position";
export const AGENT_PANEL_MARGIN = 8;

function viewportDimension(value: number): number {
    return Number.isFinite(value) ? Math.max(0, value) : 0;
}

/** No minimum size: even very small viewports must contain the whole panel. */
export function agentPanelSize(viewport: AgentPanelViewport): AgentPanelViewport {
    return {
        width: Math.min(460, Math.max(0, viewportDimension(viewport.width) - AGENT_PANEL_MARGIN * 2)),
        height: Math.min(680, Math.max(0, viewportDimension(viewport.height) - AGENT_PANEL_MARGIN * 2)),
    };
}

export function clampAgentPanelPosition(position: AgentPanelPosition, viewport: AgentPanelViewport): AgentPanelPosition {
    const width = viewportDimension(viewport.width);
    const height = viewportDimension(viewport.height);
    const size = agentPanelSize(viewport);
    // If an axis is narrower than both margins, collapse the empty panel at its center.
    const marginX = Math.min(AGENT_PANEL_MARGIN, width / 2);
    const marginY = Math.min(AGENT_PANEL_MARGIN, height / 2);
    return {
        x: Math.min(Math.max(marginX, Number.isFinite(position.x) ? position.x : marginX), Math.max(marginX, width - size.width - marginX)),
        y: Math.min(Math.max(marginY, Number.isFinite(position.y) ? position.y : marginY), Math.max(marginY, height - size.height - marginY)),
    };
}

/** Used only until the user has saved/dragged the panel independently of the pet. */
export function anchorAgentPanelPosition(pet: AgentPanelPosition, viewport: AgentPanelViewport, petSize = 112, gap = 12): AgentPanelPosition {
    const size = agentPanelSize(viewport);
    const spaceAbove = pet.y - gap - AGENT_PANEL_MARGIN;
    const spaceBelow = viewport.height - pet.y - petSize - gap - AGENT_PANEL_MARGIN;
    return clampAgentPanelPosition({
        x: pet.x + petSize - size.width,
        y: spaceAbove >= spaceBelow ? pet.y - gap - size.height : pet.y + petSize + gap,
    }, viewport);
}

/** Storage may contain old, malformed, or manually edited data; never coerce coordinates. */
export function parseAgentPanelPosition(value: string | null): AgentPanelPosition | null {
    if (!value) return null;
    try {
        const parsed: unknown = JSON.parse(value);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
        const position = parsed as Partial<AgentPanelPosition>;
        if (typeof position.x !== "number" || typeof position.y !== "number" || !Number.isFinite(position.x) || !Number.isFinite(position.y)) return null;
        return { x: position.x, y: position.y };
    } catch {
        return null;
    }
}
