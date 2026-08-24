/** Content-block structure helpers. @module @deepseek-ai/dsh-llm/content */
import type { ContentBlock } from './types.ts';
import type { Message } from './message.ts';
/** Model-facing stand-in for an image removed to fit a provider request bound. */
export declare const OFFLOADED_IMAGE_TEXT = "[image omitted to keep the request within its image limit; older images are omitted first. If this image is still needed, read its file again when a path is available; otherwise ask the user to attach it again.]";
/**
 * True when typed model content contains an image block, walking nested
 * tool-result content. This is the one recursive image walk shared by every
 * image policy (capability gating, text-only serialization, compaction
 * survey), so a consumer cannot silently diverge on nesting depth.
 * @param content - typed model content blocks.
 * @returns whether any nested block is an image.
 */
export declare function contentHasImage(content: readonly ContentBlock[]): boolean;
/**
 * Return transient request messages whose oldest images are replaced until
 * their accumulated base64 payload fits the configured bound. The selection
 * is deterministic from durable message order and attachment metadata; a
 * provider can serialize the returned messages without reading omitted bytes.
 * @param messages - complete request history, oldest first.
 * @param maxRequestImageBytes - positive bound on total base64 image payload; undefined preserves every image.
 * @returns the original messages when they already fit, otherwise shallow message copies with replaced content trees.
 */
export declare function offloadRequestImages(messages: readonly Message[], maxRequestImageBytes: number | undefined): readonly Message[];
//# sourceMappingURL=content.d.ts.map