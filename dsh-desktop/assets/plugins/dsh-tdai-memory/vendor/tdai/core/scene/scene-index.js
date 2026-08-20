/**
 * Scene Index: maintains a JSON index of all scene blocks for quick lookup.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { parseSceneBlock } from "./scene-format.js";
/**
 * Read the scene index from disk.
 *
 * The index is written exclusively by syncSceneIndex() (engineering side).
 * The LLM is sandboxed to scene_blocks/ and cannot access this file.
 */
export async function readSceneIndex(dataDir) {
    const indexPath = path.join(dataDir, ".metadata", "scene_index.json");
    try {
        const raw = await fs.readFile(indexPath, "utf-8");
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed))
            return [];
        const entries = [];
        for (const item of parsed) {
            if (!item || typeof item !== "object")
                continue;
            const filename = typeof item.filename === "string" ? item.filename : "";
            if (!filename)
                continue;
            entries.push({
                filename,
                summary: typeof item.summary === "string" ? item.summary : "",
                heat: typeof item.heat === "number" ? item.heat : 0,
                created: typeof item.created === "string" ? item.created : "",
                updated: typeof item.updated === "string" ? item.updated : "",
            });
        }
        return entries;
    }
    catch {
        return [];
    }
}
/**
 * Write the scene index to disk.
 */
export async function writeSceneIndex(dataDir, entries) {
    const indexPath = path.join(dataDir, ".metadata", "scene_index.json");
    await fs.mkdir(path.dirname(indexPath), { recursive: true });
    await fs.writeFile(indexPath, JSON.stringify(entries, null, 2), "utf-8");
}
/**
 * Rebuild scene index by scanning all .md files in the scene_blocks directory.
 */
export async function syncSceneIndex(dataDir) {
    const blocksDir = path.join(dataDir, "scene_blocks");
    let files;
    try {
        files = (await fs.readdir(blocksDir)).filter((f) => f.endsWith(".md"));
    }
    catch {
        files = [];
    }
    const entries = [];
    for (const file of files) {
        try {
            const raw = await fs.readFile(path.join(blocksDir, file), "utf-8");
            const block = parseSceneBlock(raw, file);
            entries.push({
                filename: file,
                summary: block.meta.summary,
                heat: block.meta.heat,
                created: block.meta.created,
                updated: block.meta.updated,
            });
        }
        catch {
            // File may have been deleted between readdir and readFile (e.g. by concurrent
            // SceneExtractor soft-delete). Skip it and continue syncing the rest.
            continue;
        }
    }
    await writeSceneIndex(dataDir, entries);
    return entries;
}
