/**
 * ============================================================================
 * dsh-pet 宿主半侧的类型声明（TypeScript）
 * ============================================================================
 *
 * 【用途】
 *   给 lib/index.js（宿主半侧）提供类型信息，让 TypeScript 用户/编辑器
 *   在 import 本包时获得智能提示和类型检查。纯类型文件，不影响运行时。
 *
 * 【对应实现】
 *   lib/index.js —— 注册 /pet/ 前缀路由，向浏览器提供动画 WebM 文件。
 *
 * ============================================================================
 * @module dsh-pet
 */
import type { Context } from '@deepseek-ai/cordis';
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver';

/** Cordis 插件名（loader 诊断用），与 lib/index.js 的 name 一致 */
export declare const name = 'pet';
/** 需要注入的服务列表（webServer），与 lib/index.js 的 inject 一致 */
export declare const inject: string[];

/** 插件配置：/pet 路由的资源根目录 */
export interface Config {
    /**
     * "full"（原始 1200×1200）资源的根目录，当部署方下载了原始母版时使用。
     * 默认 `$DSH_HOME/pet-assets`。
     */
    fullRoot?: string;
}

/**
 * 宿主插件主体：注册 /pet 前缀路由。
 * @param ctx    - 插件上下文；ctx.webServer 是 Web 服务器服务
 * @param config - 本行配置（来自 patch 树）
 */
export declare function apply(ctx: Context, config: Config): void;

export type { WebRoute };
