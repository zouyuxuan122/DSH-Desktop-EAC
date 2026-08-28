/** Pure persisted geometry rules for the AgentTeams shell-overlay panel. */
export const PANEL_LAYOUT_STORAGE_KEY = 'dsh-agent-teams:activity-panel:v1';
export const PANEL_COMPACT_BREAKPOINT = 960;
export const PANEL_DEFAULT_WIDTH = 388;
export const PANEL_DEFAULT_HEIGHT = 640;
export const PANEL_MIN_WIDTH = 320;
export const PANEL_MAX_WIDTH = 640;
export const PANEL_MIN_HEIGHT = 360;
export const PANEL_DOCK_TOP = 64;
export const PANEL_DOCK_RIGHT = 18;
export const PANEL_DOCK_BOTTOM = 48;
export const PANEL_FLOAT_MARGIN = 12;
export const DEFAULT_PANEL_LAYOUT = Object.freeze({
    mode: 'docked',
    x: 0,
    y: PANEL_DOCK_TOP,
    width: PANEL_DEFAULT_WIDTH,
    height: PANEL_DEFAULT_HEIGHT,
    heightMode: 'auto',
});
function clamp(value, minimum, maximum) {
    return Math.min(Math.max(value, minimum), maximum);
}
function finite(value) {
    return typeof value === 'number' && Number.isFinite(value);
}
/** Decode one versioned localStorage value, rejecting partial/corrupt state. */
export function parsePanelLayout(value) {
    if (value === null)
        return DEFAULT_PANEL_LAYOUT;
    try {
        const parsed = JSON.parse(value);
        if (typeof parsed !== 'object' || parsed === null)
            return DEFAULT_PANEL_LAYOUT;
        const record = parsed;
        if ((record.mode !== 'docked' && record.mode !== 'floating')
            || !finite(record.x) || !finite(record.y)
            || !finite(record.width) || !finite(record.height)) {
            return DEFAULT_PANEL_LAYOUT;
        }
        return {
            mode: record.mode,
            x: record.x,
            y: record.y,
            width: record.width,
            height: record.height,
            // v1 values written before content-fit height existed have no mode.
            // Treat them as automatic so the upgrade removes legacy blank space.
            heightMode: record.mode === 'floating' && record.heightMode === 'manual' ? 'manual' : 'auto',
        };
    }
    catch {
        return DEFAULT_PANEL_LAYOUT;
    }
}
/** Whether the panel should become a simple inset overlay with no gestures. */
export function compactPanelForBounds(bounds) {
    return bounds.width <= PANEL_COMPACT_BREAKPOINT;
}
/** Docked and compact panels always fit content; floating panels may be user-sized. */
export function panelUsesAutoHeight(layout, bounds) {
    return compactPanelForBounds(bounds) || layout.mode === 'docked' || layout.heightMode === 'auto';
}
/** CSS max-height ceiling that keeps an auto-height panel inside its shell. */
export function panelMaximumHeight(layout, bounds) {
    const bottomInset = compactPanelForBounds(bounds) || layout.mode === 'floating'
        ? PANEL_FLOAT_MARGIN
        : PANEL_DOCK_BOTTOM;
    return Math.max(1, bounds.height - layout.y - bottomInset);
}
/** Resolve persisted state into a visible rectangle inside the current shell. */
export function resolvePanelGeometry(layout, bounds) {
    const boundsWidth = Math.max(1, bounds.width);
    const boundsHeight = Math.max(1, bounds.height);
    if (compactPanelForBounds(bounds)) {
        return {
            ...layout,
            x: PANEL_FLOAT_MARGIN,
            y: PANEL_FLOAT_MARGIN,
            width: Math.max(1, boundsWidth - PANEL_FLOAT_MARGIN * 2),
            height: Math.max(1, boundsHeight - PANEL_FLOAT_MARGIN * 2),
        };
    }
    const maximumWidth = Math.max(1, Math.min(PANEL_MAX_WIDTH, boundsWidth - PANEL_FLOAT_MARGIN * 2));
    const minimumWidth = Math.min(PANEL_MIN_WIDTH, maximumWidth);
    const width = clamp(layout.width, minimumWidth, maximumWidth);
    const maximumHeight = Math.max(1, boundsHeight - PANEL_FLOAT_MARGIN * 2);
    const minimumHeight = Math.min(PANEL_MIN_HEIGHT, maximumHeight);
    if (layout.mode === 'docked') {
        const y = clamp(PANEL_DOCK_TOP, PANEL_FLOAT_MARGIN, Math.max(PANEL_FLOAT_MARGIN, boundsHeight - minimumHeight - PANEL_FLOAT_MARGIN));
        const availableHeight = Math.max(1, boundsHeight - y - PANEL_DOCK_BOTTOM);
        const height = clamp(availableHeight, Math.min(minimumHeight, availableHeight), maximumHeight);
        const anchorRight = clamp(bounds.anchorRight, 0, boundsWidth);
        const maximumX = Math.max(PANEL_FLOAT_MARGIN, boundsWidth - width - PANEL_FLOAT_MARGIN);
        const x = clamp(anchorRight - PANEL_DOCK_RIGHT - width, PANEL_FLOAT_MARGIN, maximumX);
        return { mode: 'docked', x, y, width, height, heightMode: layout.heightMode };
    }
    const height = clamp(layout.height, minimumHeight, maximumHeight);
    return {
        mode: 'floating',
        x: clamp(layout.x, PANEL_FLOAT_MARGIN, Math.max(PANEL_FLOAT_MARGIN, boundsWidth - width - PANEL_FLOAT_MARGIN)),
        y: clamp(layout.y, PANEL_FLOAT_MARGIN, Math.max(PANEL_FLOAT_MARGIN, boundsHeight - height - PANEL_FLOAT_MARGIN)),
        width,
        height,
        heightMode: layout.heightMode,
    };
}
/** Undock without a visual jump by adopting the panel's resolved rectangle. */
export function floatPanelLayout(geometry, bounds) {
    return resolvePanelGeometry({ ...geometry, mode: 'floating' }, bounds);
}
/** Return to the right dock, preserving width and restoring content-fit height. */
export function dockPanelLayout(layout, bounds) {
    return resolvePanelGeometry({ ...layout, mode: 'docked', heightMode: 'auto' }, bounds);
}
/** Translate a floating panel and clamp it back into the visible shell. */
export function movePanelLayout(start, dx, dy, bounds) {
    return resolvePanelGeometry({ ...start, mode: 'floating', x: start.x + dx, y: start.y + dy }, bounds);
}
/** Resize while keeping the edge opposite the active handle stationary. */
export function resizePanelLayout(start, edge, dx, dy, bounds) {
    if (start.mode === 'docked') {
        if (edge !== 'left')
            return resolvePanelGeometry(start, bounds);
        return resolvePanelGeometry({ ...start, width: start.width - dx }, bounds);
    }
    const resolved = resolvePanelGeometry(start, bounds);
    const minimumWidth = Math.min(PANEL_MIN_WIDTH, resolved.x + resolved.width - PANEL_FLOAT_MARGIN);
    const minimumHeight = Math.min(PANEL_MIN_HEIGHT, bounds.height - resolved.y - PANEL_FLOAT_MARGIN);
    if (edge === 'left') {
        const right = resolved.x + resolved.width;
        const maximumWidth = Math.max(1, Math.min(PANEL_MAX_WIDTH, right - PANEL_FLOAT_MARGIN));
        const width = clamp(resolved.width - dx, Math.min(minimumWidth, maximumWidth), maximumWidth);
        return { ...resolved, x: right - width, width };
    }
    const maximumHeight = Math.max(1, bounds.height - resolved.y - PANEL_FLOAT_MARGIN);
    const height = clamp(resolved.height + dy, Math.min(minimumHeight, maximumHeight), maximumHeight);
    if (edge === 'bottom')
        return { ...resolved, height, heightMode: 'manual' };
    const maximumWidth = Math.max(1, Math.min(PANEL_MAX_WIDTH, bounds.width - resolved.x - PANEL_FLOAT_MARGIN));
    const width = clamp(resolved.width + dx, Math.min(minimumWidth, maximumWidth), maximumWidth);
    return { ...resolved, width, height, heightMode: 'manual' };
}
