// 配置层：剥注释、校验 config.jsonc。运行时（ANIM）直接使用与 jsonc 同构的 ClientConfig，
// 不做字段转换；缺失/非法一律视为配置错误（throw，由加载层显式报错）。
import type { Animations, ClientConfig, Corner, Pet, Weights } from './types';

/** 剥除 JSONC 注释（行注释 // 与块注释），得到纯 JSON 字符串 */
export const stripJsonc = (src: string): string =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^\\:])\/\/.*$/gm, '$1')
    .trim();

/** 支持的角落白名单 */
export const CORNERS: Corner[] = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
/** corner 合法性检查用的 string 集合（Corner[] 的 includes 要求 Corner 参数，无法接收未知 string） */
const CORNER_SET: ReadonlySet<string> = new Set(CORNERS);

/** ClientConfig 类型占位（data-less；PetMulti 加载后由 assertClientConfig 赋真实值） */
export const EMPTY_CONF: ClientConfig = {
  notificationsEnabled: true,
  pets: [],
  animations: {
    idle: [],
    turn: [],
    drag: [],
    clicks: [],
    moves: { default: {}, actions: [] },
    categories: [],
    events: {},
  },
  animationWeights: { idle: 0, turn: 0, move: 0 },
  eventsRefreshSec: {},
};

/** 校验 config.jsonc 解析结果并返回 ClientConfig；任一字段缺失/非法即视为配置错误抛出 */
export function assertClientConfig(raw: unknown): ClientConfig {
  if (!raw || typeof raw !== 'object') throw new Error('dsh-pet: config 非对象');
  // raw 是 unknown 输入（jsonc 解析产物），按 Record 读取后逐字段手工校验，字段读写无法静态定型
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cfg = raw as Record<string, any>;

  // ---- pets ----
  const petsArr = cfg.pets;
  if (!Array.isArray(petsArr) || !petsArr.length) throw new Error('dsh-pet: 缺少 pets');
  const seen = new Set<string>();
  const pets: Pet[] = [];
  for (const p of petsArr) {
    const id = String(p?.id ?? '');
    if (!id || seen.has(id)) throw new Error('dsh-pet: pet id 非法或重复「' + id + '」');
    const size = Number(p?.size);
    if (!Number.isFinite(size) || size <= 0) throw new Error('dsh-pet: pet「' + id + '」大小非法');
    const balanceEnabled = p?.balanceEnabled;
    if (typeof balanceEnabled !== 'boolean')
      throw new Error('dsh-pet: pet「' + id + '」缺少 balanceEnabled（需为布尔值 true/false）');
    const corner = p?.position?.corner;
    if (typeof corner !== 'string' || !CORNER_SET.has(corner)) throw new Error('dsh-pet: pet「' + id + '」corner 非法');
    const marginX = Number(p?.position?.marginX);
    const marginY = Number(p?.position?.marginY);
    if (!Number.isFinite(marginX) || !Number.isFinite(marginY)) throw new Error('dsh-pet: pet「' + id + '」边距非法');
    seen.add(id);
    pets.push({ id, size, balanceEnabled, position: { corner: corner as Corner, marginX, marginY } });
  }

  // ---- animations ----
  const a = cfg.animations;
  if (!a || typeof a !== 'object') throw new Error('dsh-pet: 缺少 animations');
  for (const key of ['idle', 'turn', 'drag', 'clicks']) {
    if (!Array.isArray(a[key])) throw new Error('dsh-pet: animations.' + key + ' 缺失');
  }
  if (
    !a.moves ||
    typeof a.moves !== 'object' ||
    typeof a.moves.default !== 'object' ||
    a.moves.default === null ||
    !Array.isArray(a.moves.actions)
  ) {
    throw new Error('dsh-pet: animations.moves 结构非法');
  }
  if (!Array.isArray(a.categories)) throw new Error('dsh-pet: animations.categories 缺失');

  // ---- animations.events（事件动画：事件名 → 非空 string 数组，数组顺序即档位顺序）----
  // 事件功能已内置：events 段与 balance 事件均为必需，缺失即配置不完整，显式报错
  const ev = a.events;
  if (!ev || typeof ev !== 'object' || Array.isArray(ev)) throw new Error('dsh-pet: 缺少 animations.events');
  for (const [eventName, pool] of Object.entries(ev)) {
    if (!Array.isArray(pool) || pool.length === 0) {
      throw new Error('dsh-pet: animations.events.' + eventName + ' 必须是非空动画名数组');
    }
    for (const name of pool) {
      if (typeof name !== 'string' || name.length === 0) {
        throw new Error('dsh-pet: animations.events.' + eventName + ' 含非法动画名');
      }
    }
  }
  const balance = ev.balance;
  if (!Array.isArray(balance) || balance.length === 0) {
    throw new Error('dsh-pet: animations.events.balance 缺失或为空（余额事件必备）');
  }

  // ---- animationWeights ----
  const w = cfg.animationWeights;
  if (!w || typeof w !== 'object') throw new Error('dsh-pet: 缺少 animationWeights');
  for (const key of ['idle', 'turn', 'move']) {
    const v = Number(w[key]);
    if (!Number.isFinite(v) || v < 0) throw new Error('dsh-pet: animationWeights.' + key + ' 非法');
    w[key] = v;
  }

  // ---- eventsRefreshSec（事件刷新周期：事件名 → 正数秒数）----
  // 事件功能已内置：周期段与 balance 周期均为必需，缺失/非法即配置不完整，显式报错
  const ers = cfg.eventsRefreshSec;
  if (!ers || typeof ers !== 'object' || Array.isArray(ers)) throw new Error('dsh-pet: 缺少 eventsRefreshSec');
  const cleaned: Record<string, number> = {};
  for (const [eventName, sec] of Object.entries(ers)) {
    const n = Number(sec);
    if (!Number.isFinite(n) || n <= 0)
      throw new Error('dsh-pet: eventsRefreshSec.' + eventName + ' 非法（需为正数秒）');
    cleaned[eventName] = n;
  }
  const balanceSec = cleaned.balance;
  if (balanceSec === undefined) throw new Error('dsh-pet: eventsRefreshSec.balance 缺失（余额事件周期必备）');

  // ---- notificationsEnabled（系统通知总开关：必填布尔值）----
  const notificationsEnabled = cfg.notificationsEnabled;
  if (typeof notificationsEnabled !== 'boolean')
    throw new Error('dsh-pet: 缺少 notificationsEnabled（需为布尔值 true/false）');

  return { notificationsEnabled, pets, animations: a, animationWeights: w, eventsRefreshSec: cleaned };
}

/** 合并宠物：用户层（{ pets }，与 jsonc 同构）全量替换默认；无用户层回落默认 */
export function resolvePets(defaults: Pet[], user: { pets?: Pet[] }): Pet[] {
  if (user && Array.isArray(user.pets)) return user.pets.length ? user.pets : defaults;
  return defaults;
}

/** 用户覆盖片段（与 jsonc 同构；高级用户直接编辑 main-config.json，缺省字段回落默认） */
export interface UserOverrides {
  pets?: Pet[];
  animations?: Animations;
  animationWeights?: Weights;
  eventsRefreshSec?: Record<string, number>;
  /** 系统通知总开关（可选）：用户层给出时优先于默认配置 */
  notificationsEnabled?: boolean;
}

/** 合并用户覆盖片段到完全体配置：pets / animations / animationWeights / eventsRefreshSec 有则整体替换，缺省回落默认 */
export function applyUserOverrides(base: ClientConfig, user: UserOverrides): ClientConfig {
  const next: ClientConfig = { ...base, pets: resolvePets(base.pets, user) };
  if (user.animations) next.animations = user.animations;
  if (user.animationWeights) next.animationWeights = user.animationWeights;
  if (user.eventsRefreshSec) next.eventsRefreshSec = user.eventsRefreshSec;
  // 系统通知总开关：用户层显式给出时优先，缺省回落默认配置
  if (user.notificationsEnabled !== undefined) next.notificationsEnabled = user.notificationsEnabled;
  return next;
}
