import { Clapperboard, Film, Sparkles } from "lucide-react";

import { useCanvasTheme } from "@/lib/canvas/use-canvas-theme";
import type { CanvasNodeContext } from "@/types/canvas-plugin";

/**
 * 短剧 / 自动化节点的「卡片内容」。
 *
 * 画布节点渲染要求节点定义提供 `Content`，否则会退化成
 * 「缺少插件 / 插件未安装或未启用」。这两个节点的实际编辑界面在面板里
 * （Panel），卡片本身只需要给一句状态摘要 + 双击入口。
 */
function DramaLikeCard({
    ctx,
    title,
    accent,
    icon,
    summary,
    hint,
}: {
    ctx: CanvasNodeContext;
    title: string;
    accent: string;
    icon: React.ReactNode;
    summary: string;
    hint: string;
}) {
    const theme = useCanvasTheme();
    return (
        <div
            className="flex h-full w-full flex-col justify-between gap-2 p-3"
            style={{ color: theme.node.text }}
            // 卡片内层双击会盖住节点外层判定，这里直接接管，避免点标题没反应。
            onDoubleClick={(event) => {
                event.stopPropagation();
                ctx.openPanel();
            }}
        >
            <div className="flex items-center gap-2">
                <span className="shrink-0" style={{ color: accent }}>
                    {icon}
                </span>
                <span className="truncate text-sm font-medium">{title}</span>
            </div>
            <div className="space-y-1 text-[11px] leading-4" style={{ color: theme.node.muted }}>
                <div className="flex items-center gap-1.5">
                    <Film className="size-3 shrink-0" />
                    <span className="truncate">{summary}</span>
                </div>
                <div className="flex items-center gap-1.5">
                    <Sparkles className="size-3 shrink-0" />
                    <span className="truncate">{hint}</span>
                </div>
            </div>
        </div>
    );
}

/** 短剧卡片内容：显示剧名/风格/集数，提示双击进入分镜导演台。 */
export function ShortDramaNodeContent({ ctx }: { ctx: CanvasNodeContext }) {
    const card = ctx.node.metadata?.dramaCard;
    const episodes = card?.episodes?.length || 0;
    const shots = card?.episodes?.reduce((sum, item) => sum + (Number(item.shots) || 0), 0) || 0;
    const title = card?.title || "短剧";
    const summary = card
        ? `${card.style || "未设风格"} · ${card.aspect || "16:9"} · ${episodes} 集 / ${shots} 镜`
        : "尚未配置剧本";
    return (
        <DramaLikeCard
            ctx={ctx}
            title={title}
            accent="#fb7185"
            icon={<Clapperboard className="size-4" />}
            summary={summary}
            hint="双击打开分镜导演台"
        />
    );
}

/** 自动化卡片内容：显示来源字数/页数与当前阶段，提示双击进入流水线面板。 */
export function AutomationNodeContent({ ctx }: { ctx: CanvasNodeContext }) {
    const automation = ctx.node.metadata?.automation;
    const chars = (automation?.sourceText || "").length;
    const pages = automation?.pages?.length || 0;
    const stage = automation?.stage || "idle";
    const stageLabel: Record<string, string> = {
        idle: "待开始",
        script: "拆解剧本",
        planning: "分镜规划",
        characters: "角色设定",
        scenes: "场景设定",
        images: "批量出图",
        videoPrompts: "视频提示词",
        videos: "生成视频",
        done: "已完成",
        error: "出错",
        stopped: "已停止",
    };
    const summary = chars ? `${chars} 字 · ${pages} 页` : "尚无来源文本";
    return (
        <DramaLikeCard
            ctx={ctx}
            title="自动化"
            accent="#38bdf8"
            icon={<Clapperboard className="size-4" />}
            summary={summary}
            hint={`${stageLabel[stage] || stage} · 双击打开面板`}
        />
    );
}
