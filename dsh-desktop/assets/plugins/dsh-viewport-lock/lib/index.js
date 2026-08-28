/**
 * dsh-viewport-lock — host half (no-op).
 *
 * 视口钳制是纯客户端 CSS（见 lib/client.js）：host 半边仅存在于此包成为
 * 合法 bundle（loader 需要 name/inject/apply 契约）。
 */
export const name = 'viewport-lock';
export const inject = [];
export function apply() {
  // no-op.
}
