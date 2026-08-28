/** Pure persisted geometry rules for the AgentTeams shell-overlay panel. */
export type PanelMode = 'docked' | 'floating';
export type PanelHeightMode = 'auto' | 'manual';
export type PanelResizeEdge = 'left' | 'bottom' | 'corner';
/** User-owned panel state persisted between browser sessions. */
export interface PanelLayout {
    readonly mode: PanelMode;
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
    readonly heightMode: PanelHeightMode;
}
/** The shell-overlay box and the right edge of its current conversation. */
export interface PanelBounds {
    readonly width: number;
    readonly height: number;
    readonly anchorRight: number;
}
export declare const PANEL_LAYOUT_STORAGE_KEY = "dsh-agent-teams:activity-panel:v1";
export declare const PANEL_COMPACT_BREAKPOINT = 960;
export declare const PANEL_DEFAULT_WIDTH = 388;
export declare const PANEL_DEFAULT_HEIGHT = 640;
export declare const PANEL_MIN_WIDTH = 320;
export declare const PANEL_MAX_WIDTH = 640;
export declare const PANEL_MIN_HEIGHT = 360;
export declare const PANEL_DOCK_TOP = 64;
export declare const PANEL_DOCK_RIGHT = 18;
export declare const PANEL_DOCK_BOTTOM = 48;
export declare const PANEL_FLOAT_MARGIN = 12;
export declare const DEFAULT_PANEL_LAYOUT: PanelLayout;
/** Decode one versioned localStorage value, rejecting partial/corrupt state. */
export declare function parsePanelLayout(value: string | null): PanelLayout;
/** Whether the panel should become a simple inset overlay with no gestures. */
export declare function compactPanelForBounds(bounds: PanelBounds): boolean;
/** Docked and compact panels always fit content; floating panels may be user-sized. */
export declare function panelUsesAutoHeight(layout: PanelLayout, bounds: PanelBounds): boolean;
/** CSS max-height ceiling that keeps an auto-height panel inside its shell. */
export declare function panelMaximumHeight(layout: PanelLayout, bounds: PanelBounds): number;
/** Resolve persisted state into a visible rectangle inside the current shell. */
export declare function resolvePanelGeometry(layout: PanelLayout, bounds: PanelBounds): PanelLayout;
/** Undock without a visual jump by adopting the panel's resolved rectangle. */
export declare function floatPanelLayout(geometry: PanelLayout, bounds: PanelBounds): PanelLayout;
/** Return to the right dock, preserving width and restoring content-fit height. */
export declare function dockPanelLayout(layout: PanelLayout, bounds: PanelBounds): PanelLayout;
/** Translate a floating panel and clamp it back into the visible shell. */
export declare function movePanelLayout(start: PanelLayout, dx: number, dy: number, bounds: PanelBounds): PanelLayout;
/** Resize while keeping the edge opposite the active handle stationary. */
export declare function resizePanelLayout(start: PanelLayout, edge: PanelResizeEdge, dx: number, dy: number, bounds: PanelBounds): PanelLayout;
