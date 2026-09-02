import type { Context } from '@deepseek-ai/cordis';
/** Cordis row identifier used by cordis.patch.yml. */
export declare const name = "dsh-composer-dynamic-island";
/**
 * The headless bundle entry has no configuration knobs.
 * Browser behavior remains in the optional DSH Web client adapter.
 */
export type Config = {};
/** Empty schema keeps the complete Cordis plugin contract explicit. */
export declare const Config: Schemastery<Config>;
/**
 * Activate the portable headless facet.
 *
 * The function intentionally has no effects: hosts without the DSH Web client
 * surface must be able to install and remove this bundle without failing boot.
 */
export declare function apply(_ctx: Context, _config?: Config): void;
//# sourceMappingURL=index.d.ts.map