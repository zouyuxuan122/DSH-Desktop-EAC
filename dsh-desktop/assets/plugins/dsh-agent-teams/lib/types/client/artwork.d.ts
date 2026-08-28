/**
 * Shared whale artwork lookup for the activity panel and the conversation
 * card: role keywords map to the packaged role images; the captain always
 * uses the lead whale.
 * @module dsh-agent-teams/client/artwork
 */
/** Artwork route prefix served by the plugin host half. */
export declare const ART_BASE = "/plugins/dsh-agent-teams/assets/";
/** Captain artwork (always the lead whale). */
export declare const LEAD_ART = "/plugins/dsh-agent-teams/assets/team-lead-v2.png";
/** Status action artwork per member activity. */
export declare const ACTION_ART: Record<'working' | 'idle' | 'unknown', string>;
/**
 * Member artwork URL, or null when no role matches (initial-letter fallback).
 * @param name - the member's display name.
 * @param role - the member's role text.
 * @returns the artwork URL, or null when unmatched.
 */
export declare function memberArtUrl(name: string, role: string): string | null;
