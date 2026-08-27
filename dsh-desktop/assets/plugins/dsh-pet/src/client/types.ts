// 与 config.jsonc 结构完全同构的类型模型（唯一事实来源 = config.jsonc 的
// animations / animationWeights / pets）。运行时（ANIM / 设置页 / PetCard）
// 直接使用这套结构，不额外造转换后的类型。

/** 支持的角落 */
export type Corner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

/** 移动动作：一个动作名 + 可选覆盖参数（未写字段取 moves.default） */
export interface MoveSpec {
  name: string;
  params?: Record<string, number>;
}

/** 移动池 */
export interface MovesConfig {
  default: Record<string, number>;
  actions: MoveSpec[];
}

/** 随机动作分类（带文字、镜像会颠倒，facing=right 时跳过） */
export interface Category {
  id: string;
  weight: number;
  noMirror?: boolean;
  actions: string[];
}

/** 事件动画：事件名 → 动画名数组（数组顺序 = 档位顺序；不进随机链，只由代码显式触发） */
export type Events = Record<string, string[]>;

/** 动画权重 */
export interface Weights {
  idle: number;
  turn: number;
  move: number;
}

/** config.jsonc 的 animations 段 */
export interface Animations {
  idle: string[];
  turn: string[];
  drag: string[];
  clicks: string[];
  moves: MovesConfig;
  categories: Category[];
  events: Events;
}

/** 一只宠物（与 jsonc pets[i] 同形，position 嵌套） */
export interface Pet {
  id: string;
  size: number;
  /** 是否启用余额功能：true=触发余额动画+显示余额气泡；false=该宠物完全禁用余额。缺失即配置错误 */
  balanceEnabled: boolean;
  position: { corner: Corner; marginX: number; marginY: number };
}

/** config.jsonc 全集——运行时直接使用（ANIM 即本类型） */
export interface ClientConfig {
  /** 系统通知总开关：true=对话完成/生成失败/输出截断/权限申请/用户选择在窗口失焦时弹出系统通知；缺失即配置错误 */
  notificationsEnabled: boolean;
  pets: Pet[];
  animations: Animations;
  animationWeights: Weights;
  /** 事件刷新周期（秒）：事件名 → 间隔；balance = 余额数据刷新 + 动画触发间隔 */
  eventsRefreshSec: Record<string, number>;
}
