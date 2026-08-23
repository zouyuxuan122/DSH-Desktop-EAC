/**
 * dsh-pet-settings — host half (no-op).
 *
 * 桌宠设置分区完全由浏览器半边完成（设置页「桌宠」分区：页面桌宠开关走
 * pluginManager 桥，大肥鱼参数走 dsh-dafeiyu 的 config 端点），本半边仅为
 * 让包成为合法 bundle。
 */
export const name = 'pet-settings';
export const inject = [];
export function apply() {
  // no-op.
}
