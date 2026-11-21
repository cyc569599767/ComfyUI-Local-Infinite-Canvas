import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Clapperboard, ImageIcon, List, Mic, Music2, Scissors, Scroll, Settings2, Sparkles, User, Video, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { canvasThemes } from "@/lib/canvas-theme";
import { useCanvasTheme } from "@/lib/canvas/use-canvas-theme";
import { connectionCreateTypes, connectionMenuDescriptionKey, connectionMenuShowsPlugins, connectionMenuSide, connectionMenuTitleKey, connectionMenuTitleTextKey } from "@/lib/canvas/connection-create-menu";
import { isBuiltinNodeType, listNodeDefinitions, useNodeRegistryVersion } from "@/lib/canvas/node-registry";
import { getNodeSpec } from "@/constant/canvas";
import { CanvasNodeType, type ConnectionHandle, type Position } from "@/types/canvas";

export type PendingConnectionCreate = {
    connection: ConnectionHandle;
    position: Position;
};

/**
 * 「选择节点」主菜单里只显示名称、不显示描述的条目。
 *
 * 自动化与短剧是多环节编排入口，一句话描述说不清它们做什么，反而会把 240px 宽的
 * 菜单撑成两行、挤压后面的条目。详细说明放在节点面板里，菜单保持一眼可扫。
 * 注意：工作台子菜单不受影响，那里必须保留描述来区分几个工作台。
 */
const CREATE_MENU_WITHOUT_DESCRIPTION = new Set<string>([CanvasNodeType.Automation, CanvasNodeType.Drama]);

const MENU_ICONS: Record<string, React.ReactNode> = {
    [CanvasNodeType.Text]: <List className="size-4" />,
    [CanvasNodeType.Image]: <ImageIcon className="size-4" />,
    [CanvasNodeType.Video]: <Video className="size-4" />,
    [CanvasNodeType.Audio]: <Music2 className="size-4" />,
    [CanvasNodeType.VoiceDesign]: <Mic className="size-4" />,
};

export function ConnectionCreateMenu({
    pending,
    scale = 1,
    onCreate,
    onClose,
}: {
    pending: PendingConnectionCreate;
    scale?: number;
    onCreate: (type: string) => void;
    onClose: () => void;
}) {
    const theme = useCanvasTheme();
    const { t } = useTranslation();
    useNodeRegistryVersion();
    // 左侧 = 往上游接一个节点，右侧 = 往下游生成一个产物，两套菜单项完全不同。
    const side = connectionMenuSide(pending.connection.handleType);
    const types = connectionCreateTypes(side);
    const pluginDefinitions = connectionMenuShowsPlugins(side)
        ? listNodeDefinitions()
              .filter((def) => def.showInCreateMenu !== false && !isBuiltinNodeType(def.type))
              .sort((a, b) => Number(Boolean(b.insertBefore)) - Number(Boolean(a.insertBefore)))
        : [];
    return (
        <div
            className="absolute z-[120] w-[240px] rounded-2xl border p-2 shadow-2xl backdrop-blur"
            data-connection-create-menu
            data-connection-create-menu-side={side}
            style={{ left: pending.position.x, top: pending.position.y, transform: `scale(${1 / scale})`, transformOrigin: "top left", background: theme.node.panel, borderColor: theme.node.stroke, color: theme.node.text }}
            onMouseDown={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
        >
            <div className="mb-1.5 flex items-center justify-between px-1">
                <span className="text-sm font-medium" style={{ color: theme.node.muted }}>
                    {t(connectionMenuTitleKey(side))}
                </span>
                <button type="button" className="grid size-7 place-items-center rounded-lg text-base opacity-55 transition hover:bg-white/10 hover:opacity-100" onClick={onClose} aria-label={t("canvas.createMenu.close")}>
                    ×
                </button>
            </div>
            <div className="grid gap-0.5">
                {types.map((type) => {
                    const descriptionKey = connectionMenuDescriptionKey(side, type);
                    return (
                        <ConnectionCreateOption
                            key={type}
                            theme={theme}
                            icon={MENU_ICONS[type]}
                            title={t(connectionMenuTitleTextKey(side, type))}
                            description={descriptionKey ? t(descriptionKey) : undefined}
                            onClick={() => onCreate(type)}
                        />
                    );
                })}
                {pluginDefinitions.length ? (
                    <div className="mt-1 border-t pt-1.5" style={{ borderColor: theme.node.stroke }}>
                        <div className="px-2 pb-1 text-xs" style={{ color: theme.node.muted }}>
                            {t("canvas.createMenu.plugins")}
                        </div>
                        {pluginDefinitions.map((def) => (
                            <ConnectionCreateOption key={def.type} theme={theme} icon={def.icon} title={getNodeSpec(def.type).title} description={def.description} onClick={() => onCreate(def.type)} />
                        ))}
                    </div>
                ) : null}
                <ConnectionCreateOption theme={theme} icon={<Settings2 className="size-4" />} title={t("canvas.createMenu.config")} description={t("canvas.createMenu.configDescription")} onClick={() => onCreate(CanvasNodeType.Config)} />
            </div>
        </div>
    );
}

export function ConnectionCreateOption({ theme, icon, title, description, onClick }: { theme: (typeof canvasThemes)[keyof typeof canvasThemes]; icon: React.ReactNode; title: string; description?: string; onClick?: () => void }) {
    return (
        <button
            type="button"
            className="flex h-12 w-full cursor-pointer items-center gap-2.5 rounded-xl px-2 text-left transition"
            style={{ color: theme.node.text }}
            onClick={onClick}
            onMouseEnter={(event) => (event.currentTarget.style.background = theme.node.fill)}
            onMouseLeave={(event) => (event.currentTarget.style.background = "transparent")}
        >
            <span className="grid size-9 shrink-0 place-items-center rounded-lg" style={{ background: theme.node.fill, color: theme.node.muted }}>
                {icon}
            </span>
            <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2 text-sm font-medium leading-5">{title}</span>
                {description ? (
                    <span className="mt-0.5 block truncate text-xs" style={{ color: theme.node.muted }}>
                        {description}
                    </span>
                ) : null}
            </span>
        </button>
    );
}

export function NodeCreateMenu({ position, scale = 1, onCreate, onClose }: { position: Position; scale?: number; onCreate: (type: string, metadata?: Record<string, unknown>) => void; onClose: () => void }) {
    const theme = useCanvasTheme();
    const { t } = useTranslation();
    useNodeRegistryVersion();
    const menuRef = useRef<HTMLDivElement>(null);
    // 工作台走自己的子菜单入口，所以不能被 showInCreateMenu 这个「普通节点列表」开关筛掉，
    // 否则先过滤再挑 type 会永远得到空数组，子菜单点了没反应。
    const allDefinitions = listNodeDefinitions();
    const workbenches = allDefinitions.filter((def) => def.type === CanvasNodeType.Workbench && def.showInCreateMenu !== false);
    const plainDefinitions = allDefinitions.filter((def) => def.type !== CanvasNodeType.Workbench && def.showInCreateMenu !== false);
    const [workbenchOpen, setWorkbenchOpen] = useState(false);
    // Close automatically when clicking outside the menu.
    useEffect(() => {
        const handlePointerDown = (event: PointerEvent) => {
            if (menuRef.current && !menuRef.current.contains(event.target as Node)) onClose();
        };
        // 子菜单被 Portal 到 body，已不在 menuRef 的 DOM 子树里。
        // 不排除它的话，点一下子菜单就会先被判定为「点了外面」而整个关掉。
        const handlePointerDownWithPortal = (event: PointerEvent) => {
            const target = event.target as Element | null;
            if (target?.closest?.("[data-workbench-menu]")) return;
            handlePointerDown(event);
        };
        document.addEventListener("pointerdown", handlePointerDownWithPortal, true);
        return () => document.removeEventListener("pointerdown", handlePointerDownWithPortal, true);
    }, [onClose]);
    return (
        <div
            ref={menuRef}
            className="absolute z-[120] max-h-[70vh] w-[240px] overflow-y-auto rounded-2xl border p-2 shadow-2xl backdrop-blur thin-scrollbar"
            data-canvas-no-zoom
            style={{ left: position.x, top: position.y, transform: `scale(${1 / scale})`, transformOrigin: "top left", background: theme.node.panel, borderColor: theme.node.stroke, color: theme.node.text }}
            onPointerDown={(event) => event.stopPropagation()}
        >
            <div className="mb-1.5 flex items-center justify-between px-1">
                <span className="text-sm font-medium" style={{ color: theme.node.muted }}>
                    {t("canvas.createMenu.select")}
                </span>
                <button type="button" className="grid size-7 place-items-center rounded-lg opacity-55 transition hover:opacity-100" onClick={onClose} aria-label={t("canvas.createMenu.close")}>
                    <X className="size-4" />
                </button>
            </div>
            <div className="grid gap-0.5">
                {plainDefinitions.map((def) => (
                    <ConnectionCreateOption
                        key={def.type}
                        theme={theme}
                        icon={def.icon}
                        title={getNodeSpec(def.type).title}
                        description={CREATE_MENU_WITHOUT_DESCRIPTION.has(def.type) ? undefined : def.description}
                        onClick={() => onCreate(def.type)}
                    />
                ))}
                {workbenches.length ? (
                    <WorkbenchSubmenu
                        theme={theme}
                        open={workbenchOpen}
                        onOpenChange={setWorkbenchOpen}
                        onCreate={(kind) => {
                            setWorkbenchOpen(false);
                            // 三种工作台是同一个节点类型，靠 metadata.workbenchKind 区分。
                            onCreate(CanvasNodeType.Workbench, { workbenchKind: kind });
                        }}
                    />
                ) : null}
            </div>
        </div>
    );
}

/**
 * 工作台清单。
 *
 * 三种工作台共用一个节点类型，子菜单里必须按 kind 各列一项并写具体名字：
 * 都叫「工作台」的话，用户点进去之前根本不知道里面是什么。
 */
const WORKBENCH_ITEMS = [
    { kind: "storyboard" as const, icon: <Clapperboard className="size-4" />, titleKey: "canvas.workbench.storyboard", descriptionKey: "canvas.workbench.storyboardDescription" },
    { kind: "digital-human" as const, icon: <User className="size-4" />, titleKey: "canvas.workbench.digitalHuman", descriptionKey: "canvas.workbench.digitalHumanDescription" },
    { kind: "video-editor" as const, icon: <Scissors className="size-4" />, titleKey: "canvas.workbench.videoEditor", descriptionKey: "canvas.workbench.videoEditorDescription" },
    { kind: "novel" as const, icon: <Scroll className="size-4" />, titleKey: "canvas.workbench.novel", descriptionKey: "canvas.workbench.novelDescription" },
    { kind: "agent-creation" as const, icon: <Sparkles className="size-4" />, titleKey: "canvas.workbench.agentCreation", descriptionKey: "canvas.workbench.agentCreationDescription" },
];

/**
 * 「工作台」hover 子菜单。
 *
 * 工作台承载的是完整编辑面板（故事分镜导演台、数字人、视频编辑），和普通节点不是一类东西，
 * 所以单独分组；主项本身不创建任何东西，必须选到具体工作台才建卡片，
 * 避免用户点一下就得到一个不知道是什么的空节点。
 */
function WorkbenchSubmenu({
    theme,
    open,
    onOpenChange,
    onCreate,
}: {
    theme: (typeof canvasThemes)[keyof typeof canvasThemes];
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onCreate: (kind: (typeof WORKBENCH_ITEMS)[number]["kind"]) => void;
}) {
    const { t } = useTranslation();
    const closeTimer = useRef<number | null>(null);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const submenuRef = useRef<HTMLDivElement>(null);
    // 子菜单必须 Portal 到 body：主菜单是 overflow-y-auto，子菜单留在里面会被裁掉，
    // 用户只能看到一条横向滚动条、菜单不出现（实测就是这样）。
    const [anchor, setAnchor] = useState<{ left: number; top: number; maxHeight: number } | null>(null);
    const cancelClose = () => {
        if (closeTimer.current !== null) {
            window.clearTimeout(closeTimer.current);
            closeTimer.current = null;
        }
    };
    // 鼠标从主项移到子菜单要穿过几像素空隙，立刻关闭会让子菜单点不到。
    const scheduleClose = () => {
        cancelClose();
        closeTimer.current = window.setTimeout(() => onOpenChange(false), 180);
    };
    // 用视口坐标：主菜单有 transform: scale()，getBoundingClientRect 拿到的已经是缩放后的真实位置。
    const place = useCallback(() => {
        const rect = triggerRef.current?.getBoundingClientRect();
        if (!rect) return;
        const gap = 4;
        // 要放得下「故事分镜导演台」和完整的一行说明：230 会把说明截成「…」。
        const width = 320;
        const margin = 8;

        // 水平：优先贴触发项右侧。右侧装不下时不要翻到左边（那样会横跨主菜单、
        // 压住画布内容，视觉上像是飘到了别的地方），而是把子菜单右对齐到窗口边缘，
        // 让它始终紧贴在触发项所在的这一侧。
        const fitsRight = rect.right + gap + width <= window.innerWidth - margin;
        const left = fitsRight
            ? rect.right + gap
            : Math.max(margin, Math.min(rect.left - gap - width, window.innerWidth - width - margin));

        // 垂直：先与触发项顶部对齐，渲染后再用真实高度校正（见下方 layout 副作用），
        // 这里只给一个宽松的上界，避免用估算高度把位置提前压偏。
        setAnchor({ left, top: Math.max(margin, rect.top), maxHeight: Math.max(160, window.innerHeight - margin * 2) });
    }, []);

    // 渲染后用真实高度校正垂直位置：保证整块留在视口内，且仍尽量贴近触发项顶部。
    useLayoutEffect(() => {
        if (!open || !anchor) return;
        const element = submenuRef.current;
        const rect = triggerRef.current?.getBoundingClientRect();
        if (!element || !rect) return;
        const margin = 8;
        const height = element.offsetHeight;
        const maxTop = Math.max(margin, window.innerHeight - height - margin);
        const top = Math.max(margin, Math.min(rect.top, maxTop));
        const maxHeight = Math.max(160, window.innerHeight - top - margin);
        // 位置没变化就不要 setState，否则会在同一帧里反复触发 layout 循环。
        setAnchor((previous) =>
            previous && previous.top === top && previous.left === anchor.left && previous.maxHeight === maxHeight ? previous : { left: anchor.left, top, maxHeight },
        );
    }, [open, anchor]);
    useEffect(() => {
        if (!open) return;
        place();
        // 滚动或改变窗口大小时主菜单可能移动，子菜单要跟着重算，否则会飘在错误位置。
        const onMove = () => place();
        window.addEventListener("scroll", onMove, true);
        window.addEventListener("resize", onMove);
        return () => {
            window.removeEventListener("scroll", onMove, true);
            window.removeEventListener("resize", onMove);
        };
    }, [open, place]);
    useEffect(() => cancelClose, []);
    return (
        <div className="relative" onMouseEnter={() => { cancelClose(); onOpenChange(true); }} onMouseLeave={scheduleClose}>
            <button
                ref={triggerRef}
                type="button"
                className="flex h-11 w-full items-center gap-2.5 rounded-xl px-2 text-left"
                style={{ color: theme.node.text }}
                aria-haspopup="menu"
                aria-expanded={open}
                data-workbench-trigger
                onMouseEnter={(event) => (event.currentTarget.style.background = theme.node.fill)}
                onMouseLeave={(event) => (event.currentTarget.style.background = "transparent")}
                onClick={() => onOpenChange(!open)}
            >
                <span className="grid size-9 shrink-0 place-items-center rounded-lg" style={{ background: theme.node.fill, color: theme.node.muted }}>
                    <Clapperboard className="size-4" />
                </span>
                <span className="min-w-0 flex-1">
                    {/* 主项只留标题：副标题在这里没有信息量（子菜单项自己会说明），
                        多一行只会让菜单更长、更花。 */}
                    <span className="flex items-center gap-2 text-sm font-medium leading-5">
                        {t("canvas.createMenu.workbench")}
                        <span className="text-xs" style={{ color: theme.node.muted }}>▸</span>
                    </span>
                </span>
            </button>
            {open && anchor
                ? createPortal(
                      <div
                          ref={submenuRef}
                          className="fixed z-[140] w-[320px] overflow-y-auto rounded-xl border p-1 shadow-2xl backdrop-blur thin-scrollbar"
                          style={{ left: anchor.left, top: anchor.top, maxHeight: anchor.maxHeight, background: theme.node.panel, borderColor: theme.node.stroke }}
                          role="menu"
                          data-workbench-menu
                          onMouseEnter={cancelClose}
                          onMouseLeave={scheduleClose}
                          onPointerDown={(event) => event.stopPropagation()}
                      >
                          {WORKBENCH_ITEMS.map((item) => (
                              <ConnectionCreateOption
                                  key={item.kind}
                                  theme={theme}
                                  icon={item.icon}
                                  title={t(item.titleKey)}
                                  description={t(item.descriptionKey)}
                                  onClick={() => onCreate(item.kind)}
                              />
                          ))}
                      </div>,
                      document.body,
                  )
                : null}
        </div>
    );
}
