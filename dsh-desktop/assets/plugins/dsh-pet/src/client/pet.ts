// 宠物页面：单个宠物实例（PetCard）+ 多开容器（PetMulti）。
// 工厂形态与 settings.ts 一致：client 半侧不能顶层 import react，
// react 能力由 DSH 运行时注入（rt），组件在工厂内制造。
// 动作配置在本模块持有：PetMulti 加载后赋值，PetCard 只读（单一事实来源 = config.jsonc）。
import { pick, rollKind, pickCategoryAction } from './pickers';
import { planMove } from './motion';
import { assertClientConfig, EMPTY_CONF, applyUserOverrides, stripJsonc, type UserOverrides } from './config';
import { balanceEventIndex, balancePercent, fetchBalanceState, type BalanceState } from './balance';
import { makeBalanceBubble } from './bubble';
import { CANVAS_H, FEET_Y, HIT_BOX, DRAG_THRESHOLD, PET_REF_WIDTH } from './constants';
import { petBridge } from './settings';
import type { ClientConfig, Corner, Pet } from './types';
import type * as ReactNS from 'react';
import type { Dispatch, ReactNode, SetStateAction, useEffect, useRef } from 'react';
import type { jsx } from 'react/jsx-runtime';

/** 运行时配置（PetMulti 加载后赋值；PetCard 只读） */
let config: ClientConfig = EMPTY_CONF;

/** 余额气泡展示时长（ms）：定时自动消失，与动画生命周期解耦 */
const BUBBLE_DURATION_MS = 10 * 1000;

/** 内联 CSS —— 注入一次（官方插件标准做法） */
const css = [
  '.dsh-pet-root{position:fixed;z-index:40;pointer-events:none;user-select:none}',
  '.dsh-pet-root[data-corner="bottom-right"]{right:var(--dsh-pet-mx,24px);bottom:var(--dsh-pet-my,0)}',
  '.dsh-pet-root[data-corner="bottom-left"]{left:var(--dsh-pet-mx,24px);bottom:var(--dsh-pet-my,0)}',
  '.dsh-pet-root[data-corner="top-right"]{right:var(--dsh-pet-mx,24px);top:var(--dsh-pet-my,0)}',
  '.dsh-pet-root[data-corner="top-left"]{left:var(--dsh-pet-mx,24px);top:var(--dsh-pet-my,0)}',
  '.dsh-pet-stage{position:relative;width:var(--dsh-pet-size,462px);height:calc(var(--dsh-pet-size,462px)*9/16);pointer-events:none}',
  '.dsh-pet-video{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;pointer-events:none;opacity:0;transition:opacity .18s ease;transform-origin:center}',
  '.dsh-pet-video.is-front{opacity:1}',
  '.dsh-pet-hit{position:absolute;pointer-events:auto;cursor:default;z-index:1}',
  '.dsh-pet-hit.dragging{cursor:grabbing}',
  '@media (prefers-reduced-motion: reduce){.dsh-pet-video{transition:none}}',
].join('\n');
const cssTag = 'dsh-pet/style.css';
function injectCss(): void {
  if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css="' + cssTag + '"]') === null) {
    const tag = document.createElement('style');
    tag.dataset.plugin = 'dsh-pet';
    tag.dataset.pluginCss = cssTag;
    tag.textContent = css;
    document.head.appendChild(tag);
  }
}

/**
 * 制造宠物页面组件（工厂，与 makePetConfigSection 同理：react 由运行时注入）。
 * @param rt 运行时注入的 react 能力（h=jsx / useState / useEffect / useRef）
 * @returns PetMulti 多开容器组件（内部渲染多个 PetCard）
 */
export function makePetUI(rt: {
  h: typeof jsx;
  useState: <T>(init: T) => [T, Dispatch<SetStateAction<T>>];
  useEffect: typeof useEffect;
  useRef: typeof useRef;
}): () => ReactNode {
  const { h, useState, useEffect, useRef } = rt;
  injectCss();

  /** 余额气泡（哑组件：数据与显隐由 PetCard 传入） */
  const BalanceBubble = makeBalanceBubble({ h });

  /** 单个宠物实例（配置由容器 PetMulti 传入） */
  function PetCard({ cfg, balance, balanceTick }: { cfg: Pet; balance: BalanceState | null; balanceTick: number }) {
    // ---- 尺寸（由配置传入；容器/设置页更新后即时跟随）----
    const [size, setSize] = useState(cfg.size);
    const halfW = size / 2;
    const halfH = (size * 9) / 16 / 2;

    // ---- React 状态 ----
    const [anim, setAnim] = useState(config.animations.idle[0] ?? '');
    const [once, setOnce] = useState(true);
    const [facing, setFacing] = useState('left' as 'left' | 'right');
    const [dragging, setDragging] = useState(false);
    const [customPos, setCustomPos] = useState<null | { rx: number; ry: number }>(null);
    // 初始角落与边距（来自配置；可被容器更新覆盖）
    const [corner, setCorner] = useState<Corner>(cfg.position.corner);
    const [margin, setMargin] = useState({ x: cfg.position.marginX, y: cfg.position.marginY });
    // 余额气泡显隐（事件触发时显示，10s 后定时自动消失）
    const [bubbleOn, setBubbleOn] = useState(false);
    const bubbleTimerRef = useRef<number | null>(null);

    // 配置变化即时跟随（容器重新合并 / 设置页保存后通过 petBridge.sync 触发）
    useEffect(() => {
      setSize(cfg.size);
      setCorner(cfg.position.corner);
      setMargin({ x: cfg.position.marginX, y: cfg.position.marginY });
    }, [cfg.size, cfg.position.corner, cfg.position.marginX, cfg.position.marginY]);
    const [seq, setSeq] = useState(0);

    // ---- DOM / 状态 refs ----
    const rootRef = useRef<HTMLDivElement | null>(null);
    const stageRef = useRef<HTMLDivElement | null>(null);
    const videoARef = useRef<HTMLVideoElement | null>(null);
    const videoBRef = useRef<HTMLVideoElement | null>(null);
    const frontRef = useRef(0);
    const pendingRef = useRef<null | { anim: string; once: boolean; gen: number }>(null);
    const genRef = useRef(0);
    const dragRef = useRef({ active: false, dragging: false, sx: 0, sy: 0, offX: 0, offY: 0 });
    const justDraggedRef = useRef(false);
    const animRef = useRef(anim);
    animRef.current = anim;

    const switchTo = (next: string, nextOnce: boolean) => {
      if (!next) return;
      const pending = pendingRef.current;
      if (pending && pending.anim === next && pending.once === nextOnce) return;
      const gen = ++genRef.current;
      pendingRef.current = { anim: next, once: nextOnce, gen };
      const target = frontRef.current === 0 ? videoBRef : videoARef;
      const el = target.current;
      if (!el) return;
      el.src = '/dsh-pet-7340/thumb/' + encodeURIComponent(next) + '.webm';
      el.loop = !nextOnce;
      el.muted = true;
      el.autoplay = true;
      el.playsInline = true;
      el.onended = nextOnce ? handleEnded : null;
      el.load();
      const onReady = () => {
        el.removeEventListener('loadeddata', onReady);
        if (pendingRef.current?.gen !== gen) return;
        const old = frontRef.current === 0 ? videoARef : videoBRef;
        el.classList.add('is-front');
        if (old.current && old.current !== el) {
          old.current.classList.remove('is-front');
          // 拆雷：降级为背景的视频继续播完会触发它身上残留的 onended → handleEnded，
          // 掐断当前前台动画（历史上表现为随机急速跳转/雪崩）。清 handler + 停播彻底消除。
          old.current.onended = null;
          old.current.pause();
        }
        frontRef.current = frontRef.current === 0 ? 1 : 0;
        pendingRef.current = null;
        el.style.transform = facingRef.current === 'right' ? 'scaleX(-1)' : '';
        el.play().catch(() => {});
        if (pendingMoveRef.current) startMoveDrive(el);
      };
      el.addEventListener('loadeddata', onReady);
      if (el.readyState >= 2) onReady();
    };

    // ---- 状态驱动播放 ----
    useEffect(() => {
      switchTo(anim, once);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [anim, once, seq]);
    useEffect(() => () => stopMove(), []);
    useEffect(
      () => () => {
        if (bubbleTimerRef.current !== null) window.clearTimeout(bubbleTimerRef.current);
      },
      [],
    );
    // 余额事件：容器拉取成功后递增 balanceTick → 按档位播放事件动画 + 弹气泡
    // （仅启用余额功能的宠物触发：未启用则该宠物完全不播余额动画、不显示气泡；
    //   无效/不支持按设计不触发动画，错误由容器侧显式上报）
    const prevTickRef = useRef(0);
    useEffect(() => {
      if (!cfg.balanceEnabled) return; // 未启用余额功能 -> 该宠物对余额事件完全免疫
      if (balanceTick === 0 || balanceTick === prevTickRef.current) return;
      prevTickRef.current = balanceTick;
      if (!balance || !balance.ok) return;
      const p = balancePercent(balance);
      if (p === undefined) return; // 当前数据源没有百分比语义（如 DeepSeek 余额），不触发档位动画
      const pool = config.animations.events?.balance;
      if (!pool || pool.length === 0) {
        console.error('[dsh-pet] 配置缺少 animations.events.balance，无法播放余额事件动画');
        return;
      }
      const idx = balanceEventIndex(p);
      const name = pool[idx];
      if (!name) {
        console.error('[dsh-pet] balance 档位索引越界：p=' + p + ' idx=' + idx);
        return;
      }
      console.log(
        '[dsh-pet] ' +
          new Date().toTimeString().slice(0, 8) +
          ' balance pet=' +
          cfg.id +
          ' p=' +
          p.toFixed(1) +
          '% -> [档' +
          idx +
          '] ' +
          name,
      );
      stopMove();
      setBubbleOn(true);
      // 气泡 10s 定时消失（与动画解耦：即使动画被点击/拖拽打断，气泡也按时收起；重复触发先清旧定时器）
      if (bubbleTimerRef.current !== null) window.clearTimeout(bubbleTimerRef.current);
      bubbleTimerRef.current = window.setTimeout(() => setBubbleOn(false), BUBBLE_DURATION_MS);
      setOnce(true);
      setAnim(name);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [balanceTick]);
    useEffect(() => {
      const onResize = () => setCustomPos((prev) => (prev ? { ...prev } : prev));
      window.addEventListener('resize', onResize);
      return () => window.removeEventListener('resize', onResize);
    }, []);

    // ---- 动画链：播完按权重选下一个 ----
    const pickNext = () => {
      const { animations, animationWeights } = config;
      const roll = Math.random();
      const k = rollKind(roll, animationWeights);
      let kind: string;
      let next: string;
      if (k === 'idle') {
        kind = 'IDLE';
        next = pick(animations.idle, animRef.current);
        setAnim(next);
      } else if (k === 'turn') {
        kind = 'TURN';
        next = pick(animations.turn, animRef.current);
        setAnim(next);
      } else if (k === 'move') {
        const moved = tryMove();
        if (moved === false) {
          const act = pickCategoryAction(animations.categories, animations.idle, facingRef.current, animRef.current);
          kind = act.id;
          next = act.name;
          setAnim(next);
        } else {
          kind = 'MOVES';
          // 成功返回具体动作名；占用中返回 true（已有一场移动在进行，不重播、不另设动画）
          next = typeof moved === 'string' ? moved : '移动进行中(不重播)';
        }
      } else {
        const act = pickCategoryAction(animations.categories, animations.idle, facingRef.current, animRef.current);
        kind = act.id;
        next = act.name;
        setAnim(next);
      }
      console.log(
        '[dsh-pet] ' +
          new Date().toTimeString().slice(0, 8) +
          ' pet=' +
          cfg.id +
          ' facing=' +
          facingRef.current +
          ' roll=' +
          roll.toFixed(4) +
          ' -> [' +
          kind +
          '] ' +
          next,
      );
      setOnce(true);
      setSeq((s) => s + 1);
    };

    const handleEnded = (e?: Event) => {
      // 只认前台视频触发的 ended：后台（被降级停播）视频即便有残留事件也一律丢弃，防止掐断当前动画
      const evEl = e && (e.currentTarget as HTMLVideoElement | null);
      if (evEl && !evEl.classList.contains('is-front')) return;
      const { animations } = config;
      if (dragRef.current.active) return;
      // 事件动画播完：回 idle（与 drag/clicks 同分支，不进入随机链）；气泡由定时器自动消失，与动画解耦
      const isEvent = Object.values(animations.events ?? {}).some((pool) => pool.includes(animRef.current));
      if (isEvent) {
        if (animations.idle.length) setAnim(pick(animations.idle, animRef.current));
        setOnce(true);
        setSeq((s) => s + 1);
        return;
      }
      if (animations.turn.includes(animRef.current)) {
        const next = facing === 'left' ? 'right' : 'left';
        setFacing(next);
        facingRef.current = next; // 立即同步：翻转后的 pickNext 用新朝向过滤 noMirror（右侧不选文字类）
      }
      if (animations.drag.includes(animRef.current) || animations.clicks.includes(animRef.current)) {
        if (animations.idle.length) setAnim(pick(animations.idle, animRef.current));
        setOnce(true);
        setSeq((s) => s + 1);
        return;
      }
      pickNext();
    };

    // ---- 移动系统 ----
    const moveRef = useRef<number | null>(null);
    const moveTokenRef = useRef(0);
    const pendingMoveRef = useRef<null | {
      startRatio: number;
      startYRatio: number;
      targetRatio: number;
      dir: number;
      totalRatio: number;
      leadSec: number;
      tailSec: number;
    }>(null);
    const customPosRef = useRef(customPos);
    customPosRef.current = customPos;

    const currentCenterX = () => {
      const cp = customPosRef.current;
      if (cp) return cp.rx * window.innerWidth;
      const rootEl = rootRef.current;
      if (rootEl) return rootEl.getBoundingClientRect().left + halfW;
      return window.innerWidth - 24 - halfW;
    };
    const currentCenterY = () => {
      const cp = customPosRef.current;
      if (cp) return cp.ry * window.innerHeight;
      const rootEl = rootRef.current;
      if (rootEl) return rootEl.getBoundingClientRect().top + halfH;
      return window.innerHeight - 20 - halfH;
    };

    const startMoveDrive = (el: HTMLVideoElement) => {
      const pm = pendingMoveRef.current;
      if (!pm || moveRef.current !== null) return;
      pendingMoveRef.current = null;
      const { startRatio, startYRatio, targetRatio, dir, totalRatio, leadSec, tailSec } = pm;
      const duration = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : 10.09;
      const travelWindow = Math.max(0.1, duration - leadSec - tailSec);
      const token = ++moveTokenRef.current;
      const step = () => {
        if (moveTokenRef.current !== token) return;
        const t = el.currentTime || 0;
        const rootEl = rootRef.current;
        if (rootEl) {
          const W = window.innerWidth;
          const H = window.innerHeight;
          let ratioX;
          if (t <= leadSec) ratioX = startRatio;
          else if (t >= duration - tailSec) ratioX = targetRatio;
          else ratioX = startRatio + dir * totalRatio * ((t - leadSec) / travelWindow);
          const px = ratioX * W;
          const py = startYRatio * H;
          rootEl.style.left = px - halfW + 'px';
          rootEl.style.top = py - halfH + 'px';
          rootEl.style.right = 'auto';
          rootEl.style.bottom = 'auto';
        }
        if (t < duration - tailSec) moveRef.current = requestAnimationFrame(step);
        else {
          moveRef.current = null;
          setCustomPos({ rx: targetRatio, ry: startYRatio });
        }
      };
      moveRef.current = requestAnimationFrame(step);
    };

    /** 尝试发起一次移动：占用中返回 true（不重播），无法移动返回 false，成功返回动作名（供日志显示具体动作） */
    const tryMove = (): boolean | string => {
      if (moveRef.current !== null || pendingMoveRef.current) return true;
      const moves = config.animations.moves;
      const actions = moves.actions;
      if (!actions.length) return false;
      const chosen = actions[Math.floor(Math.random() * actions.length)];
      const mp = Object.assign({}, moves.default, chosen.params || {});
      const dir = (facingRef.current === 'right') !== config.animations.turn.includes(animRef.current) ? 1 : -1;
      const W = window.innerWidth;
      // 移动距离随宠物缩放：config 的 minDist/maxDist 是基准尺寸（462px 宽）下的 px，
      // 按 实际size/基准 等比缩放 —— 小宠物挪小步、大宠物挪大步，与人物自身大小匹配
      const distScale = size / PET_REF_WIDTH;
      const plan = planMove({
        cx: currentCenterX(),
        cy: currentCenterY(),
        W,
        H: window.innerHeight,
        dir,
        minDist: mp.minDist * distScale,
        maxDist: mp.maxDist * distScale,
        margin: mp.margin,
        halfW,
      });
      if (!plan) return false;
      pendingMoveRef.current = {
        ...plan,
        dir,
        leadSec: mp.leadSec,
        tailSec: mp.tailSec,
      };
      setOnce(true);
      setAnim(chosen.name);
      return chosen.name;
    };
    const stopMove = () => {
      pendingMoveRef.current = null;
      moveTokenRef.current++;
      if (moveRef.current !== null) {
        cancelAnimationFrame(moveRef.current);
        moveRef.current = null;
      }
    };

    const facingRef = useRef<'left' | 'right'>(facing);
    facingRef.current = facing;

    // ---- 点击 vs 拖拽 ----
    const handlePointerDown = (e: ReactNS.PointerEvent<HTMLDivElement>) => {
      e.currentTarget.classList.add('dragging');
      stopMove();
      e.currentTarget.setPointerCapture(e.pointerId);
      const rootEl = rootRef.current;
      let offX = 0;
      let offY = 0;
      if (rootEl) {
        const rr = rootEl.getBoundingClientRect();
        offX = e.clientX - (rr.left + rr.width / 2);
        offY = e.clientY - (rr.top + rr.height / 2);
      }
      dragRef.current = { active: true, dragging: false, sx: e.clientX, sy: e.clientY, offX, offY };
    };
    const handlePointerMove = (e: ReactNS.PointerEvent<HTMLDivElement>) => {
      const d = dragRef.current;
      if (!d.active) return;
      const dx = e.clientX - d.sx;
      const dy = e.clientY - d.sy;
      if (!d.dragging) {
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
        d.dragging = true;
        setDragging(true);
        setOnce(true);
        if (config.animations.drag.length) {
          const name = pick(config.animations.drag);
          console.log('[dsh-pet] ' + new Date().toTimeString().slice(0, 8) + ' pet=' + cfg.id + ' -> [DRAG] ' + name);
          setAnim(name);
        }
      }
      const rootEl = rootRef.current;
      if (rootEl) {
        rootEl.style.left = e.clientX - d.offX - halfW + 'px';
        rootEl.style.top = e.clientY - d.offY - halfH + 'px';
        rootEl.style.right = 'auto';
        rootEl.style.bottom = 'auto';
      }
      const stageEl = stageRef.current;
      if (stageEl) stageEl.style.transform = 'none';
    };
    const handlePointerUp = (e: ReactNS.PointerEvent<HTMLDivElement>) => {
      const d = dragRef.current;
      const wasDragging = d.dragging;
      d.active = false;
      d.dragging = false;
      e.currentTarget.classList.remove('dragging');
      if (wasDragging) {
        justDraggedRef.current = true;
        setTimeout(() => {
          justDraggedRef.current = false;
        }, 100);
        setDragging(false);
        setCustomPos({ rx: (e.clientX - d.offX) / window.innerWidth, ry: (e.clientY - d.offY) / window.innerHeight });
        const stageEl = stageRef.current;
        if (stageEl) stageEl.style.transform = 'translateY(' + bottomPad + 'px)';
        if (config.animations.idle.length) setAnim(pick(config.animations.idle, animRef.current));
        setOnce(false);
      }
    };
    const handleClick = () => {
      const d = dragRef.current;
      if (d.active || d.dragging || justDraggedRef.current) return;
      stopMove();
      setOnce(true);
      if (!config.animations.clicks.length) return;
      const name = pick(config.animations.clicks);
      console.log('[dsh-pet] ' + new Date().toTimeString().slice(0, 8) + ' pet=' + cfg.id + ' -> [CLICK] ' + name);
      setAnim(name);
    };

    // ---- 渲染 ----
    const bottomPad = (size * (9 / 16) * (CANVAS_H - FEET_Y)) / CANVAS_H;
    const stageStyle = dragging ? { transform: 'none' } : { transform: 'translateY(' + bottomPad + 'px)' };
    const rootStyle = customPos
      ? (() => {
          const rx = customPos.rx;
          const ry = customPos.ry;
          const left = Math.min(Math.max(rx * window.innerWidth - halfW, 0), window.innerWidth - size);
          const top = Math.min(Math.max(ry * window.innerHeight - halfH, 0), window.innerHeight - (size * 9) / 16);
          return { left: left + 'px', top: top + 'px', right: 'auto', bottom: 'auto' };
        })()
      : {};
    const commonVideoProps = { muted: true, playsInline: true, autoPlay: true, title: 'dsh-pet' };
    const hitProps = {
      className: 'dsh-pet-hit',
      style: {
        left: (HIT_BOX.x0 / 640) * 100 + '%',
        top: (HIT_BOX.y0 / 360) * 100 + '%',
        width: ((HIT_BOX.x1 - HIT_BOX.x0) / 640) * 100 + '%',
        height: ((HIT_BOX.y1 - HIT_BOX.y0) / 360) * 100 + '%',
      },
      onMouseEnter: (e: ReactNS.MouseEvent<HTMLDivElement>) => {
        if (!dragRef.current.active) e.currentTarget.style.cursor = 'grab';
      },
      onMouseLeave: (e: ReactNS.MouseEvent<HTMLDivElement>) => {
        if (!dragRef.current.active) e.currentTarget.style.cursor = 'default';
      },
      onClick: handleClick,
      onPointerDown: handlePointerDown,
      onPointerMove: handlePointerMove,
      onPointerUp: handlePointerUp,
      onPointerCancel: handlePointerUp,
      title: 'dsh-pet',
    };
    return h('div', {
      ref: rootRef,
      className: 'dsh-pet-root',
      'data-corner': corner,
      'data-facing': facing,
      style: Object.assign(
        { '--dsh-pet-size': size + 'px', '--dsh-pet-mx': margin.x + 'px', '--dsh-pet-my': margin.y + 'px' },
        rootStyle,
      ),
      children: [
        // 余额气泡（仅启用余额功能的宠物渲染；显示与否由 bubbleOn 控制）
        balance && balance.ok && cfg.balanceEnabled ? h(BalanceBubble, { state: balance, on: bubbleOn }) : null,
        h('div', {
          ref: stageRef,
          className: 'dsh-pet-stage',
          style: stageStyle,
          children: [
            h('video', Object.assign({}, commonVideoProps, { ref: videoARef, className: 'dsh-pet-video is-front' })),
            h('video', Object.assign({}, commonVideoProps, { ref: videoBRef, className: 'dsh-pet-video' })),
            h('div', hitProps),
          ],
        }),
      ],
    });
  }

  /** 多开容器：拉取配置 → 合并默认+用户层 pets → 渲染多个 PetCard */
  function PetMulti() {
    const [pets, setPets] = useState<Pet[]>([]);
    const [ready, setReady] = useState(false);
    // 余额状态（容器统一拉取，PetCard 共享；balanceTick 每次成功拉取递增，驱动事件动画）
    const [balance, setBalance] = useState<BalanceState | null>(null);
    const [balanceTick, setBalanceTick] = useState(0);

    useEffect(() => {
      let alive = true;
      (async () => {
        try {
          const r1 = await fetch('/dsh-pet-7340/config.jsonc');
          if (!r1.ok) throw new Error('config.jsonc HTTP ' + r1.status);
          config = assertClientConfig(JSON.parse(stripJsonc(await r1.text())));
          const defaults = config.pets;
          // 用户覆盖层（覆盖片段：pets / animations / animationWeights，缺省回落默认）
          let user: UserOverrides = {};
          try {
            const r2 = await fetch('/dsh-pet-7340/config');
            if (r2.ok && r2.status !== 204) user = await r2.json().catch(() => ({}));
          } catch {
            /* 无用户层时忽略 */
          }
          // 合并后统一校验：用户层覆盖可能缺字段（如 moves/events），直接整体替换会静默丢失，
          // 这里对最终配置再跑一遍 assertClientConfig —— 缺失即显式报错，不静默运行残缺配置
          config = assertClientConfig(applyUserOverrides(config, user));
          const merged = config.pets;
          if (!alive) return;
          petBridge.current = merged;
          petBridge.template = defaults.length ? defaults[0] : undefined;
          petBridge.sync = (list: Pet[]) => {
            setPets(list);
            petBridge.current = list;
          };
          setPets(merged);
          setReady(true);
        } catch (e) {
          console.error('[dsh-pet] 配置加载失败', e); // 配置缺失/损坏：显式报错，不静默隐藏
        }
      })();
      return () => {
        alive = false;
        petBridge.sync = () => {};
      };
    }, []);

    // 是否存在启用余额功能的宠物：全禁用时跳过余额轮询（不拉取 /dsh-pet-7340/balance，避免无意义的周期请求）
    const anyBalanceEnabled = pets.some((p) => p.balanceEnabled);

    // 余额轮询：配置就绪（ready）且至少一只宠物启用余额后启动拉取一次，之后按 eventsRefreshSec.balance（秒）周期刷新；
    // 成功递增 balanceTick 触发事件动画；失败/不支持均不触发动画（错误显式 console.error，绝不显示伪造余额）
    useEffect(() => {
      if (!ready || !anyBalanceEnabled) return; // 未就绪 / 全宠物未启用余额：不启动轮询
      let alive = true;
      const refresh = async () => {
        try {
          const state = await fetchBalanceState();
          if (!alive) return;
          setBalance(state);
          if (state.ok) setBalanceTick((t) => t + 1);
          else if (state.reason === 'unsupported') {
            /* 无匹配服务商：按设计不显示、不播动画 */
          } else {
            console.error('[dsh-pet] 余额查询失败 reason=' + state.reason + (state.message ? ' ' + state.message : ''));
          }
        } catch (e) {
          if (alive) console.error('[dsh-pet] 余额拉取异常', e);
        }
      };
      void refresh();
      const intervalMs = Math.max(1000, (config.eventsRefreshSec?.balance ?? 1800) * 1000);
      const timer = window.setInterval(() => void refresh(), intervalMs);
      return () => {
        alive = false;
        window.clearInterval(timer);
      };
    }, [ready, anyBalanceEnabled]);

    // 手动 /balance 触发：1s 轻量轮询触发计数（host 端点响应头已禁止缓存），
    // 计数变化且余额启用时立即刷新余额并递增 balanceTick（与周期轮询同一触发路径）
    useEffect(() => {
      if (!ready || !anyBalanceEnabled) return;
      let alive = true;
      let prev = -1;
      const poll = async () => {
        try {
          const r = await fetch('/dsh-pet-7340/balance/trigger');
          if (!alive || !r.ok) return;
          const data = await r.json().catch(() => null);
          const count = data && typeof data.count === 'number' ? data.count : -1;
          if (count < 0) return;
          if (prev === -1) {
            prev = count; // 首次仅记基线：避免页面加载时重放历史触发
            return;
          }
          if (count === prev) return;
          prev = count;
          const state = await fetchBalanceState();
          if (!alive) return;
          setBalance(state);
          if (state.ok) setBalanceTick((t) => t + 1);
          else {
            console.error(
              '[dsh-pet] 手动触发余额查询失败 reason=' + state.reason + (state.message ? ' ' + state.message : ''),
            );
          }
        } catch {
          /* 轻量轮询失败静默：下一周期再试 */
        }
      };
      void poll();
      const timer = window.setInterval(() => void poll(), 1000);
      return () => {
        alive = false;
        window.clearInterval(timer);
      };
    }, [ready, anyBalanceEnabled]);

    return ready ? pets.map((p) => h(PetCard, { key: p.id, cfg: p, balance, balanceTick })) : null;
  }

  return PetMulti;
}
