/**
 * types-jsyaml.d.ts — js-yaml（内置 dsh 的传递依赖，无独立 @types）的
 * 最小 ambient 垫片，仅覆盖 lib/plugin-manager-core.ts 用到的 API。
 */
declare module 'js-yaml' {
  export interface YAMLType {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    new (tag: string, opts: Record<string, unknown>): unknown;
  }
  export const Type: YAMLType;
  export interface Schema {
    extend(type: unknown): Schema;
  }
  export const JSON_SCHEMA: Schema;
  export function load(
    content: string, opts?: { schema?: Schema },
  ): unknown;
}
