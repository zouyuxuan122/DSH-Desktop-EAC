// 余额气泡（client 半侧）：展示当前服务商余额/用量。哑组件——数据由上层传入，
// 自身不发起请求；工厂形态与 pet.ts 一致（react 由 DSH 运行时注入）。
import { urgentWindow, resetInText, deepseekPricingTier } from './balance';
import type { BalanceState } from './balance';
import type { ReactNode } from 'react';
import type { jsx } from 'react/jsx-runtime';

/** 气泡内联样式：白色半透明圆润泡 + 底部小尾巴指向宠物；字体用上首软糖体（本地打包，稳定）。
 * 所有尺寸基于 `--dsh-pet-size`（宠物宽度 px）等比缩放——宠物放大/缩小，气泡跟随。
 * 系数按默认 462px 设计：21px 字号 → ×0.0455、120px 最小宽 → 0.26、230px 最大宽 → 0.5 等。 */
const bubbleCss = [
  // 本地字体：/dsh-pet-7340/font/ 由 host 从 assets/fonts 提供；font-display swap 先回退后切换
  '@font-face{font-family:"ShangshouSoftCandy";src:url("/dsh-pet-7340/font/上首软糖体.ttf") format("truetype");font-display:swap;font-weight:400}',
  '.dsh-pet-bubble{position:absolute;left:50%;transform:translateX(-50%);' +
    'bottom:calc(100% - var(--dsh-pet-size)*0.108);' +
    'min-width:calc(var(--dsh-pet-size)*0.26);max-width:calc(var(--dsh-pet-size)*0.5);' +
    'padding:calc(var(--dsh-pet-size)*0.022) calc(var(--dsh-pet-size)*0.030);' +
    'border-radius:calc(var(--dsh-pet-size)*0.035);' +
    'background:rgba(255,255,255,.92);' +
    'color:#2b2b2b;font-family:"ShangshouSoftCandy","Yuanti SC","YouYuan","幼圆","Comic Sans MS","PingFang SC","Microsoft YaHei",sans-serif;' +
    'font-size:calc(var(--dsh-pet-size)*0.0455);line-height:1.6;z-index:3;pointer-events:none;' +
    'box-shadow:0 calc(var(--dsh-pet-size)*0.009) calc(var(--dsh-pet-size)*0.035) rgba(0,0,0,.14),0 1px 3px rgba(0,0,0,.08);' +
    'backdrop-filter:blur(6px);opacity:0;transition:opacity .25s ease;white-space:nowrap}',
  // 底部尾巴：小三角指向下方宠物（同样随宠物缩放）
  '.dsh-pet-bubble::after{content:"";position:absolute;left:50%;bottom:calc(var(--dsh-pet-size)*-0.017);' +
    'transform:translateX(-50%);border:calc(var(--dsh-pet-size)*0.017) solid transparent;' +
    'border-top-color:rgba(255,255,255,.92);border-bottom:none}',
  '.dsh-pet-bubble.is-on{opacity:1}',
  '.dsh-pet-bubble .pet-bub-title{font-size:calc(var(--dsh-pet-size)*0.035);color:rgba(43,43,43,.6);margin-bottom:calc(var(--dsh-pet-size)*0.009)}',
  '.dsh-pet-bubble .pet-bub-row{display:flex;justify-content:space-between;gap:calc(var(--dsh-pet-size)*0.030)}',
  '.dsh-pet-bubble .pet-bub-sub{font-size:calc(var(--dsh-pet-size)*0.035);color:rgba(43,43,43,.6)}',
  '.dsh-pet-bubble .pet-bub-val{font-variant-numeric:tabular-nums;font-weight:650;color:#1f1f1f}',
  '.dsh-pet-bubble .pet-bub-err{color:#d94f3d;font-size:calc(var(--dsh-pet-size)*0.035)}',
  '.dsh-pet-bubble .pet-bub-tag{margin-left:calc(var(--dsh-pet-size)*0.013);font-size:calc(var(--dsh-pet-size)*0.022);color:rgba(43,43,43,.55);border:1px solid rgba(43,43,43,.25);' +
    'border-radius:calc(var(--dsh-pet-size)*0.013);padding:0 calc(var(--dsh-pet-size)*0.009);vertical-align:1px}',
  // 峰/谷计价档位标注：峰红、谷绿
  '.dsh-pet-bubble .pet-bub-tier{font-weight:700}',
  '.dsh-pet-bubble .pet-bub-tier-peak{color:#e53935}',
  '.dsh-pet-bubble .pet-bub-tier-idle{color:#2e9e4f}',
].join('\n');

/** 只注入一次 */
function injectBubbleCss(): void {
  if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css="dsh-pet/bubble"]') === null) {
    const tag = document.createElement('style');
    tag.dataset.plugin = 'dsh-pet';
    tag.dataset.pluginCss = 'dsh-pet/bubble';
    tag.textContent = bubbleCss;
    document.head.appendChild(tag);
  }
}

/**
 * 制造余额气泡（工厂）。
 * 工厂内注入样式一次（与 pet.ts 的 injectCss 同模式）；组件为哑组件，props = { state, on }。
 */
export function makeBalanceBubble(rt: { h: typeof jsx }): (props: { state: BalanceState; on: boolean }) => ReactNode {
  const { h } = rt;
  injectBubbleCss();

  return function BalanceBubble({ state, on }: { state: BalanceState; on: boolean }) {
    const rows: ReactNode[] = [];
    if (state.ok) {
      if (state.kind === 'opencode') {
        // 联想框两行：第一行「周额度已用 88%」，第二行「2.5 天重置」
        const w = urgentWindow(state);
        if (w) {
          const reset = resetInText(w.resetsAt);
          rows.push(
            h('div', { className: 'pet-bub-row', children: w.label + '额度已用 ' + Math.round(w.percent) + '%' }),
          );
          rows.push(h('div', { className: 'pet-bub-row pet-bub-sub', children: reset ? reset + '重置' : '已重置' }));
        } else {
          rows.push(h('div', { className: 'pet-bub-row', children: '额度数据不可用' }));
        }
      } else {
        // DeepSeek：单行「余额（峰/谷）¥x.xx」——按北京时间峰谷价档上色（峰红/谷绿）
        const tier = deepseekPricingTier();
        rows.push(
          h('div', {
            className: 'pet-bub-row',
            children: h('span', {
              children: [
                '余额（',
                h('span', {
                  className: 'pet-bub-tier pet-bub-tier-' + tier,
                  children: tier === 'peak' ? '峰' : '谷',
                }),
                '）¥' + (state.total ?? '-'),
              ],
            }),
          }),
        );
      }
    } else {
      // 显式展示不可用原因，绝不伪造数字
      const msg =
        state.reason === 'unsupported'
          ? '当前服务商暂不支持余额查询'
          : state.reason === 'credential-missing'
            ? '缺少凭证：' + (state.message ?? '')
            : '余额查询失败';
      rows.push(h('div', { className: 'pet-bub-err', children: msg }));
    }

    return h('div', {
      className: 'dsh-pet-bubble' + (on ? ' is-on' : ''),
      children: rows,
    });
  };
}
