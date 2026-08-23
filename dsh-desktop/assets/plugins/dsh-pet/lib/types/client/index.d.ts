/**
 * ============================================================================
 * dsh-pet 浏览器半侧的类型声明（TypeScript）
 * ============================================================================
 *
 * 【用途】
 *   给 lib/client.js（浏览器半侧）提供类型信息。纯类型文件，不影响运行时。
 *
 * 【对应实现】
 *   lib/client.js —— 注册宠物到官方 `shell.overlay` 列表槽，播放动画。
 *
 * 【注意】
 *   当前 DSH 客户端配置管线尚未打通，apply 实际收到的 config 是空对象，
 *   下面这些配置项已按默认值实现在代码里，但**尚未真正可覆盖**。
 *
 * ============================================================================
 * @module dsh-pet/client
 */
import type { Context } from '@deepseek-ai/dsh-client-runtime';

/** Cordis 插件名（loader 诊断用），与 lib/client.js 的 name 一致 */
export declare const name = 'pet';
/** 需要注入的服务列表（slots 槽位注册表），与 lib/client.js 的 inject 一致 */
export declare const inject: string[];

/** 插件配置：显示调参 */
export interface Config {
    /** 宠物显示高度（px）。默认 260。 */
    size?: number;
    /** 默认角落：'bottom-right' | 'bottom-left'。默认 'bottom-right'。 */
    position?: 'bottom-right' | 'bottom-left';
}

/**
 * 客户端插件主体：把宠物注册进 `shell.overlay`。
 * @param ctx    - 客户端根上下文（ctx.slots 提供槽位注册）
 * @param config - 本行配置（来自 patch 树；当前实际为空对象）
 */
export declare function apply(ctx: Context, config: Config): void;
