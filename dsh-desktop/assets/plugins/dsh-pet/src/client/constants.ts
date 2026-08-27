// 画布 / 几何常量：与 640×360 播放变体强耦合，属于运行时几何，不作为配置。
/** thumb 画布高度 */
export const CANVAS_H = 360;
/** thumb 画布上「脚底」的 y 坐标（人物站在 y=330 线上） */
export const FEET_Y = 330;
/** 点击/拖拽命中矩形（thumb 640×360 像素坐标） */
export const HIT_BOX = { x0: 200, y0: 50, x1: 440, y1: 335 };
/** 拖拽判定阈值（px） */
export const DRAG_THRESHOLD = 5;
/** 移动距离缩放基准（px）：config.jsonc 的 moves.minDist/maxDist 是「基准宠物宽 462px」下的绝对像素，
 *  运行时乘以 实际size/基准 等比缩放 —— 任何缩放下，行进距离与人物自身大小成比例（小宠物挪小步、大宠物挪大步） */
export const PET_REF_WIDTH = 462;
