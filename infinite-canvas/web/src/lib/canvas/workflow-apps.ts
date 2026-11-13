/**
 * 「应用」：多个工作流组合成的固定功能。
 *
 * 和自由卡片的区别：自由卡片是单个工作流的入口，参数（提示词、尺寸、参考图）
 * 每次都要用户给；应用是一条预先排好的链——按顺序放好几张工作流卡片并用连线
 * 串起来，用户只需要在最上游填一次输入。
 *
 * 存储放 localStorage 而不是网关：应用只是「哪些工作流、按什么顺序、怎么连」
 * 的编排描述，不含模型文件也不含执行状态，放在前端即可，改完立刻生效，
 * 不必等网关重启或触发工作流扫描。
 */
export type WorkflowAppStep = {
    /** 工作流 id（对应 FreeWorkflowSummary.id）。 */
    workflowId: string;
    /** 该步骤在链上的显示名，空则用工作流名。 */
    label?: string;
    /**
     * 卡片摆放的相对列号：0 是最左的上游，往后每步 +1。
     * 允许重复，表示同一列纵向排列（并行分支）。
     */
    column: number;
    /** 同列内的纵向序号，用于决定上下位置。 */
    row?: number;
};

export type WorkflowApp = {
    id: string;
    name: string;
    description?: string;
    createdAt: string;
    updatedAt: string;
    steps: WorkflowAppStep[];
};

export const WORKFLOW_APPS_KEY = "infinite-canvas:workflow_apps";

function safeStorage(): Storage | null {
    try {
        return typeof window === "undefined" ? null : window.localStorage;
    } catch {
        return null;
    }
}

function normalizeStep(raw: unknown): WorkflowAppStep | null {
    if (!raw || typeof raw !== "object") return null;
    const value = raw as Record<string, unknown>;
    const workflowId = String(value.workflowId || "").trim();
    if (!workflowId) return null;
    const column = Number(value.column);
    const row = Number(value.row);
    return {
        workflowId,
        label: String(value.label || "").trim() || undefined,
        column: Number.isFinite(column) && column >= 0 ? Math.floor(column) : 0,
        row: Number.isFinite(row) && row >= 0 ? Math.floor(row) : undefined,
    };
}

function normalizeApp(raw: unknown): WorkflowApp | null {
    if (!raw || typeof raw !== "object") return null;
    const value = raw as Record<string, unknown>;
    const id = String(value.id || "").trim();
    const name = String(value.name || "").trim();
    if (!id || !name) return null;
    const steps = (Array.isArray(value.steps) ? value.steps : []).map(normalizeStep).filter((step): step is WorkflowAppStep => Boolean(step));
    const now = new Date().toISOString();
    return {
        id,
        name,
        description: String(value.description || "").trim() || undefined,
        createdAt: String(value.createdAt || now),
        updatedAt: String(value.updatedAt || now),
        steps,
    };
}

/**
 * 读取全部应用。坏数据不能拖垮整个列表：逐个校验，跳过不合法项。
 * 存储不可用或 JSON 损坏时返回空数组——侧栏显示「还没有应用」，不是报错。
 */
export function readWorkflowApps(): WorkflowApp[] {
    const storage = safeStorage();
    if (!storage) return [];
    try {
        const raw = storage.getItem(WORKFLOW_APPS_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed.map(normalizeApp).filter((app): app is WorkflowApp => Boolean(app));
    } catch {
        return [];
    }
}

export function writeWorkflowApps(apps: WorkflowApp[]): boolean {
    const storage = safeStorage();
    if (!storage) return false;
    try {
        storage.setItem(WORKFLOW_APPS_KEY, JSON.stringify(apps));
        return true;
    } catch {
        // 配额满或被拒绝时返回 false，调用方据此提示用户，而不是静默丢数据。
        return false;
    }
}

/**
 * 把应用的步骤展开成卡片摆放计划。
 *
 * 列号决定横向位置，同列内按出现顺序纵向堆叠。工作流已被删除的步骤会被跳过，
 * 并如实回报缺失项——静默丢一步会让用户拿到一个「少了一环」的残缺链。
 */
export function planWorkflowAppLayout(
    app: WorkflowApp,
    availableWorkflowIds: string[],
    geometry: { columnGap: number; rowGap: number },
): { placements: Array<{ step: WorkflowAppStep; x: number; y: number }>; missing: string[] } {
    const available = new Set(availableWorkflowIds);
    const placements: Array<{ step: WorkflowAppStep; x: number; y: number }> = [];
    const missing: string[] = [];
    const usedRows = new Map<number, number>();

    app.steps.forEach((step) => {
        if (!available.has(step.workflowId)) {
            if (!missing.includes(step.workflowId)) missing.push(step.workflowId);
            return;
        }
        const column = step.column;
        const row = usedRows.get(column) ?? 0;
        usedRows.set(column, row + 1);
        placements.push({
            step,
            x: column * geometry.columnGap,
            y: (step.row ?? row) * geometry.rowGap,
        });
    });

    return { placements, missing };
}
