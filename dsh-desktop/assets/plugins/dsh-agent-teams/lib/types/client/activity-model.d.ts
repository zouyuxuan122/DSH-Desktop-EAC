/** Pure relationship projections used by the AgentTeams activity panel. */
/** Minimum task shape needed to derive dependency relationships. */
export interface RelationshipTask {
    readonly id: string;
    readonly dependencies: readonly string[];
    readonly depth: number;
}
/** One dependency-depth stage in stable display order. */
export interface RelationshipStage<T extends RelationshipTask> {
    readonly depth: number;
    readonly tasks: readonly T[];
}
/** Geometry used by the compact task DAG in the activity panel. */
export interface CompactDagNode<T extends RelationshipTask> {
    readonly task: T;
    readonly x: number;
    readonly y: number;
}
/** One dependency edge routed between two compact DAG nodes. */
export interface CompactDagEdge {
    readonly from: string;
    readonly to: string;
    readonly path: string;
}
/** Complete, scrollable compact DAG projection. */
export interface CompactDagLayout<T extends RelationshipTask> {
    readonly width: number;
    readonly height: number;
    readonly nodes: readonly CompactDagNode<T>[];
    readonly edges: readonly CompactDagEdge[];
}
/** Reference-panel geometry: narrow nodes with enough room for curved edges. */
export declare const COMPACT_DAG_NODE_WIDTH = 92;
export declare const COMPACT_DAG_NODE_HEIGHT = 30;
export declare const COMPACT_DAG_COLUMN_GAP = 26;
export declare const COMPACT_DAG_ROW_GAP = 8;
/** Use a fill-width grid when the task graph has no real dependency edges. */
export declare function usesParallelTaskGrid<T extends RelationshipTask>(tasks: readonly T[]): boolean;
/**
 * Whether an expanded activity panel still belongs to the current session.
 *
 * The panel is mounted in the root-scoped shell overlay, so React does not
 * remount it when the conversation route changes. Ownership keeps an expanded
 * panel from leaking onto the new-session screen (or another conversation)
 * while its local open state is being reset.
 */
export declare function activityPanelExpandedForSession(open: boolean, owner: string | undefined, current: string | undefined): boolean;
/**
 * Resolve the task whose dependency chain should be highlighted.
 *
 * A pinned task is an explicit user choice. Keyboard focus takes precedence
 * over delayed pointer intent so an older hover timer cannot steal the active
 * chain from someone navigating the task map with the keyboard.
 */
export declare function dependencyFocusTaskId(pinnedTaskId: string | null, keyboardTaskId: string | null, hoverTaskId: string | null): string | null;
/** Group tasks by their precomputed dependency depth. */
export declare function taskStages<T extends RelationshipTask>(tasks: readonly T[]): readonly RelationshipStage<T>[];
/**
 * Lay tasks out as the reference panel's compact left-to-right DAG.
 *
 * Columns are dependency-depth stages. Rows are stable task-id order within
 * each stage. Edges use cubic curves so fan-in remains readable without
 * turning every task into a large card.
 */
export declare function compactDagLayout<T extends RelationshipTask>(tasks: readonly T[]): CompactDagLayout<T>;
/**
 * Return the complete upstream/downstream chain around one task.
 *
 * Traversal uses both dependency directions and remains cycle-safe, so the UI
 * can highlight every handoff related to the focused task even if malformed
 * durable data contains a cycle.
 */
export declare function relatedTaskIds(taskId: string, tasks: readonly RelationshipTask[]): ReadonlySet<string>;
