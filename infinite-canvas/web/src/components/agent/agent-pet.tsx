import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { motion } from "motion/react";
import { Bot, LoaderCircle } from "lucide-react";
import { useTranslation } from "react-i18next";

import { AgentCloudChat } from "./agent-cloud-chat";
import { canvasThemes } from "@/lib/canvas-theme";
import { AGENT_PANEL_POSITION_KEY, agentPanelSize, anchorAgentPanelPosition, clampAgentPanelPosition, parseAgentPanelPosition, type AgentPanelPosition } from "@/lib/agent-panel-position";
import { useEffectiveCardSkin } from "@/lib/canvas/use-canvas-theme";
import { activePromptCloudApi, useConfigStore } from "@/stores/use-config-store";
import { useAgentStore } from "@/stores/use-agent-store";
import { useThemeStore } from "@/stores/use-theme-store";

const PET_ART: Record<string, { idle: string; busy: string; label: string }> = {
    angel: { idle: "/skins/angel-girl-idle.webp", busy: "/skins/angel-girl-write.webp", label: "config.preferences.cardSkins.angel.label" },
    fish: { idle: "/skins/lantern-guard-idle.png", busy: "/skins/lantern-guard-raise.png", label: "config.preferences.cardSkins.fish.label" },
};
const PET_SIZE = 112;
const PET_MARGIN = 8;
const POSITION_KEY = "canvas-agent-pet-position";
const PANEL_INTERACTIVE_SELECTOR = "button, a, input, select, textarea, [role='button'], [role='combobox'], [contenteditable]";

type PetPosition = { x: number; y: number };
type PanelDrag = { pointerId: number; startX: number; startY: number; origin: AgentPanelPosition; moved: boolean };

function viewportSize() {
    const width = typeof window === "undefined" ? 1280 : window.innerWidth;
    const height = typeof window === "undefined" ? 720 : window.innerHeight;
    return { width, height };
}

function clampPosition(position: PetPosition, viewport = viewportSize()): PetPosition {
    return {
        x: Math.min(Math.max(PET_MARGIN, position.x), Math.max(PET_MARGIN, viewport.width - PET_SIZE - PET_MARGIN)),
        y: Math.min(Math.max(PET_MARGIN, position.y), Math.max(PET_MARGIN, viewport.height - PET_SIZE - PET_MARGIN)),
    };
}

function initialPosition(): PetPosition {
    if (typeof window === "undefined") return { x: PET_MARGIN, y: PET_MARGIN };
    try {
        const stored = JSON.parse(localStorage.getItem(POSITION_KEY) || "");
        if (Number.isFinite(stored?.x) && Number.isFinite(stored?.y)) return clampPosition({ x: stored.x, y: stored.y });
    } catch {}
    const viewport = viewportSize();
    return { x: viewport.width - PET_SIZE - 16, y: viewport.height - PET_SIZE - 16 };
}

function initialPanelPosition(): AgentPanelPosition | null {
    if (typeof window === "undefined") return null;
    try {
        const saved = parseAgentPanelPosition(window.localStorage.getItem(AGENT_PANEL_POSITION_KEY));
        return saved ? clampAgentPanelPosition(saved, viewportSize()) : null;
    } catch {
        return null;
    }
}

function persistPanelPosition(position: AgentPanelPosition) {
    try {
        window.localStorage.setItem(AGENT_PANEL_POSITION_KEY, JSON.stringify(position));
    } catch {
        // Private browsing, disabled storage, or a full quota must not break dragging.
    }
}

export function AgentPet() {
    const { t } = useTranslation();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const skin = useEffectiveCardSkin() as string;
    const agentAvatarEnabled = useThemeStore((state) => state.agentAvatarEnabled);
    const pet = agentAvatarEnabled ? PET_ART[skin] : undefined;
    const [broken, setBroken] = useState(false);
    const [position, setPositionState] = useState<PetPosition>(initialPosition);
    const [viewport, setViewport] = useState(viewportSize);
    const [panelPosition, setPanelPositionState] = useState<AgentPanelPosition | null>(initialPanelPosition);
    const panelPositionRef = useRef(panelPosition);
    const panelRef = useRef<HTMLDivElement | null>(null);
    const panelDragRef = useRef<PanelDrag | null>(null);
    const panelMovedRef = useRef(false);
    const [panelDragging, setPanelDragging] = useState(false);
    const positionRef = useRef(position);
    const wrapRef = useRef<HTMLDivElement | null>(null);
    const dragRef = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number; moved: boolean } | null>(null);
    const movedRef = useRef(false);
    const [dragging, setDragging] = useState(false);
    const panelOpen = useAgentStore((state) => state.panelOpen);
    const agentFocus = useAgentStore((state) => state.agentFocus);
    const cloudApi = activePromptCloudApi(useConfigStore((state) => state.config));
    const connected = Boolean(cloudApi?.baseUrl && cloudApi?.apiKey && cloudApi?.model);
    const busy = useAgentStore((state) => state.sending || state.waiting);
    useEffect(() => setBroken(false), [skin]);
    useEffect(() => {
        if (!agentFocus) return;
        let sawActive = false;
        let idleSince = 0;
        const started = Date.now();
        const timer = window.setInterval(() => {
            const nodes = useAgentStore.getState().canvasContext?.snapshot.nodes || [];
            const targets = agentFocus.nodeIds.map((id) => nodes.find((node) => node.id === id)).filter((node) => Boolean(node));
            const active = targets.some((node) => node && ["loading", "queued", "running"].includes(String(node.metadata?.status || "")));
            if (active) {
                sawActive = true;
                idleSince = 0;
                return;
            }
            if (agentFocus.generation && !sawActive && Date.now() - started < 3000) return;
            if (!idleSince) idleSince = Date.now();
            if (Date.now() - idleSince >= 1400) useAgentStore.getState().clearAgentFocus();
        }, 400);
        return () => window.clearInterval(timer);
    }, [agentFocus]);
    useEffect(() => {
        if (!panelOpen) return;
        const onPointerDown = (event: PointerEvent) => {
            if (panelDragRef.current) return;
            const target = event.target;
            if (!(target instanceof Element)) return;
            if (wrapRef.current?.contains(target)) return;
            if (target.closest(".ant-modal-root, .ant-popover, .ant-select-dropdown, .ant-dropdown, [role='dialog'], [data-canvas-agent-keep-open]")) return;
            useAgentStore.getState().closePanel();
        };
        document.addEventListener("pointerdown", onPointerDown, true);
        return () => document.removeEventListener("pointerdown", onPointerDown, true);
    }, [panelOpen]);
    useEffect(() => {
        const onResize = () => {
            const nextViewport = viewportSize();
            setViewport(nextViewport);
            const next = clampPosition(positionRef.current, nextViewport);
            positionRef.current = next;
            setPositionState(next);
            if (panelPositionRef.current) {
                const nextPanel = clampAgentPanelPosition(panelPositionRef.current, nextViewport);
                panelPositionRef.current = nextPanel;
                setPanelPositionState(nextPanel);
                persistPanelPosition(nextPanel);
            }
            // A resize ends the current gesture so its old origin cannot undo the reclamp.
            const drag = panelDragRef.current;
            panelDragRef.current = null;
            setPanelDragging(false);
            if (drag && panelRef.current?.hasPointerCapture(drag.pointerId)) panelRef.current.releasePointerCapture(drag.pointerId);
        };
        window.addEventListener("resize", onResize);
        return () => window.removeEventListener("resize", onResize);
    }, []);

    useEffect(() => {
        if (panelOpen) return;
        const drag = panelDragRef.current;
        panelDragRef.current = null;
        panelMovedRef.current = false;
        setPanelDragging(false);
        if (drag?.moved && panelPositionRef.current) persistPanelPosition(panelPositionRef.current);
        if (drag && panelRef.current?.hasPointerCapture(drag.pointerId)) panelRef.current.releasePointerCapture(drag.pointerId);
    }, [panelOpen]);

    const setPosition = (next: PetPosition) => {
        positionRef.current = next;
        setPositionState(next);
    };
    const persistPosition = () => {
        try {
            localStorage.setItem(POSITION_KEY, JSON.stringify(positionRef.current));
        } catch {}
    };

    const handleClick = (event: ReactMouseEvent<HTMLButtonElement>) => {
        if (event.detail > 0 && movedRef.current) return;
        const state = useAgentStore.getState();
        if (state.panelOpen) {
            state.closePanel();
            return;
        }
        state.openPanel();
    };

    const handlePointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
        if (event.button !== 0) return;
        event.stopPropagation();
        event.currentTarget.setPointerCapture(event.pointerId);
        dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, originX: positionRef.current.x, originY: positionRef.current.y, moved: false };
        movedRef.current = false;
        setDragging(false);
    };
    const handlePointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        const dx = event.clientX - drag.startX;
        const dy = event.clientY - drag.startY;
        if (!drag.moved && Math.hypot(dx, dy) < 4) return;
        if (!drag.moved) {
            drag.moved = true;
            movedRef.current = true;
            setDragging(true);
        }
        event.preventDefault();
        event.stopPropagation();
        setPosition(clampPosition({ x: drag.originX + dx, y: drag.originY + dy }, viewport));
    };
    const handlePointerUp = (event: ReactPointerEvent<HTMLButtonElement>) => {
        const drag = dragRef.current;
        if (!drag) return;
        dragRef.current = null;
        if (drag.moved) {
            event.stopPropagation();
            setPosition(clampPosition(positionRef.current, viewport));
            persistPosition();
            setDragging(false);
        }
    };
    const handlePointerCancel = () => {
        dragRef.current = null;
        setDragging(false);
    };

    const handlePanelPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
        if (panelDragRef.current || event.button !== 0 || !event.isPrimary) return;
        const target = event.target;
        if (!(target instanceof Element) || !target.closest("[data-agent-drag-handle]") || target.closest(PANEL_INTERACTIVE_SELECTOR)) return;
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.setPointerCapture(event.pointerId);
        const origin = panelPositionRef.current ?? anchorAgentPanelPosition(positionRef.current, viewportSize());
        panelDragRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, origin, moved: false };
        panelMovedRef.current = false;
    };
    const handlePanelPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
        const drag = panelDragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        const dx = event.clientX - drag.startX;
        const dy = event.clientY - drag.startY;
        if (!drag.moved && Math.hypot(dx, dy) < 4) return;
        drag.moved = true;
        panelMovedRef.current = true;
        setPanelDragging(true);
        event.preventDefault();
        event.stopPropagation();
        const next = clampAgentPanelPosition({ x: drag.origin.x + dx, y: drag.origin.y + dy }, viewportSize());
        panelPositionRef.current = next;
        setPanelPositionState(next);
    };
    const finishPanelDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
        const drag = panelDragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        panelDragRef.current = null;
        setPanelDragging(false);
        event.stopPropagation();
        if (drag.moved && panelPositionRef.current) {
            const next = clampAgentPanelPosition(panelPositionRef.current, viewportSize());
            panelPositionRef.current = next;
            setPanelPositionState(next);
            persistPanelPosition(next);
        }
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    };
    const handlePanelClickCapture = (event: ReactMouseEvent<HTMLDivElement>) => {
        if (!panelMovedRef.current || event.detail === 0) return;
        panelMovedRef.current = false;
        event.preventDefault();
        event.stopPropagation();
    };

    const { width: panelWidth, height: panelHeight } = agentPanelSize(viewport);
    const { x: panelLeft, y: panelTop } = panelPosition
        ? clampAgentPanelPosition(panelPosition, viewport)
        : anchorAgentPanelPosition(position, viewport);
    const bubbleAbove = position.y > 84;
    const art = pet && !broken ? (busy ? pet.busy : pet.idle) : "";
    const statusColor = connected ? "#16a34a" : busy ? "#d97706" : theme.node.muted;

    return (
        <div
            ref={wrapRef}
            className="fixed z-[90]"
            style={{ left: position.x, top: position.y }}
            data-canvas-shortcuts-ignore
        >
            {agentFocus ? (
                <div
                    className="pointer-events-none absolute left-1/2 z-20 w-max max-w-[260px] rounded-2xl border px-3 py-1.5 text-xs font-medium shadow-xl backdrop-blur"
                    style={{ top: bubbleAbove ? -8 : PET_SIZE + 8, transform: `translate(-50%, ${bubbleAbove ? "-100%" : "0"})`, background: theme.toolbar.panel, borderColor: theme.node.stroke, color: theme.node.text }}
                >
                    <span className="inline-flex items-center gap-1.5">
                        <LoaderCircle className="size-3.5 animate-spin" />
                        {agentFocus.label}
                    </span>
                </div>
            ) : null}
            <div
                ref={panelRef}
                className="fixed z-10 flex min-h-0 min-w-0 flex-col overflow-hidden rounded-[26px] border shadow-2xl backdrop-blur"
                style={{ display: panelOpen ? "flex" : "none", left: panelLeft, top: panelTop, width: panelWidth, height: panelHeight, borderWidth: panelWidth < 2 || panelHeight < 2 ? 0 : undefined, background: theme.node.panel, borderColor: theme.node.stroke, color: theme.node.text, userSelect: panelDragging ? "none" : undefined, cursor: panelDragging ? "grabbing" : undefined }}
                onPointerDownCapture={() => { if (!panelDragRef.current) panelMovedRef.current = false; }}
                onPointerDown={handlePanelPointerDown}
                onPointerMove={handlePanelPointerMove}
                onPointerUp={finishPanelDrag}
                onPointerCancel={finishPanelDrag}
                onLostPointerCapture={finishPanelDrag}
                onClickCapture={handlePanelClickCapture}
                data-agent-panel
                data-canvas-shortcuts-ignore
            >
                <AgentCloudChat />
            </div>
            <motion.button
                type="button"
                className="group relative flex size-28 items-end justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-black/15 dark:focus-visible:ring-white/20"
                style={{ touchAction: "none", cursor: dragging ? "grabbing" : "grab" }}
                onClick={handleClick}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                onPointerCancel={handlePointerCancel}
                aria-label={t(panelOpen ? "agent.pet.close" : "agent.pet.open")}
                title={t(panelOpen ? "agent.pet.close" : "agent.pet.open")}
                animate={dragging ? { y: 0 } : { y: busy ? [0, -2, 0] : [0, -4, 0] }}
                transition={{ duration: busy ? 1.2 : 3.2, repeat: Infinity, ease: "easeInOut" }}
            >
                {art ? (
                    <img
                        src={art}
                        alt={pet ? t(pet.label) : ""}
                        className="max-h-28 w-auto object-contain drop-shadow-[0_12px_26px_rgba(0,0,0,.35)] transition-transform duration-300 group-hover:-translate-y-1 group-hover:scale-[1.03]"
                        draggable={false}
                        onError={() => setBroken(true)}
                    />
                ) : (
                    <span
                        className="grid size-16 place-items-center rounded-full border shadow-xl transition-transform duration-300 group-hover:-translate-y-1"
                        style={{ background: theme.toolbar.panel, borderColor: theme.node.stroke, color: theme.node.text }}
                    >
                        <Bot className="size-7" />
                    </span>
                )}
                <span className="absolute bottom-2 right-2 grid size-5 place-items-center rounded-full border-2" style={{ background: theme.node.panel, borderColor: theme.node.panel }}>
                    <span className="size-2.5 rounded-full" style={{ background: statusColor }} />
                </span>
                {busy ? (
                    <span className="absolute left-1 top-3 grid size-7 place-items-center rounded-full border shadow-md" style={{ background: theme.toolbar.panel, borderColor: theme.node.stroke, color: theme.node.muted }}>
                        <LoaderCircle className="size-3.5 animate-spin" />
                    </span>
                ) : null}
            </motion.button>
        </div>
    );
}
