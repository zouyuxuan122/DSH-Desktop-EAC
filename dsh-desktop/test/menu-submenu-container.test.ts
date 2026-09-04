import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { patchMenuSubmenuContainerSource } = require(join(root, 'scripts', 'patch-deps.js'));

// 0.1.2-alpha.1 产物形态：入口行变量 $，setter J（最小复刻，锚点结构与真包一致）。
const FIX_012 = [
  'const ae=!o.some($=>$.submenu!==void 0&&$.submenu.length>0),V=$=>{',
  'const re=$.submenu!==void 0&&$.submenu.length>0,ie=re&&F===$.id;',
  'return d.jsxs("div",{className:Pe.itemWrap,',
  'onMouseEnter:()=>{J(re?$.id:null)},onMouseLeave:()=>{J(null)},',
  'children:[d.jsxs("button",{children:$.label}),',
  'ie&&$.submenu!==void 0&&d.jsx("div",{className:Pe.submenu,role:"menu",',
  'children:$.submenu.map(fe=>fe.id)})]},$.id)};',
].join('');
// rc.2 产物形态：入口行变量 B，setter z。
const FIX_RC2 = [
  'const ae=!o.some($=>$.submenu!==void 0&&$.submenu.length>0),V=$=>{',
  'const se=$.submenu!==void 0&&$.submenu.length>0,le=se&&F===$.id;',
  'return f.jsxs("div",{className:Re.itemWrap,',
  'onMouseEnter:()=>{z(se?B.id:null)},onMouseLeave:()=>{z(null)},',
  'children:[f.jsxs("button",{children:B.label}),',
  'le&&B.submenu!==void 0&&f.jsx("div",{className:Re.submenu,role:"menu",',
  'children:B.submenu.map(he=>he.id)})]},$.id)};',
].join('');
// 0.1.2 包 + 旧补丁（写死 B/z）的实际输出形态。
const FIX_BROKEN = FIX_012.replace(
  'role:"menu",children:$.submenu.map(',
  'role:"menu",onMouseEnter:()=>{clearTimeout(window.__dshMenuTimer);z(B.id)},'
  + 'onMouseLeave:()=>{clearTimeout(window.__dshMenuTimer);window.__dshMenuTimer=setTimeout(()=>z(null),400)},'
  + 'style:{maxHeight:"calc(100dvh - 96px)",overflowY:"auto",minWidth:320},'
  + '/*dsh-desktop:menu-submenu-hover*/children:B.submenu.map(');

test('0.1.2 形态：容器重建使用捕获的 $/J，不引入未定义的 B/z', () => {
  const out = patchMenuSubmenuContainerSource(FIX_012);
  assert.notEqual(out, undefined);
  assert.match(out, /children:\$\.submenu\.map\(/);
  assert.match(out, /J\(\$\.id\)/);
  assert.match(out, /setTimeout\(\(\)=>J\(null\),400\)/);
  assert.equal(out.includes('B.submenu'), false, 'B 在 0.1.2 里是列表 ref，绝不能出现在 submenu 取值位');
  assert.equal(out.includes('z(B.id)'), false);
});

test('rc.2 形态：捕获即 B/z，重建结果与旧补丁字节一致（行为不变）', () => {
  const out = patchMenuSubmenuContainerSource(FIX_RC2);
  assert.notEqual(out, undefined);
  assert.match(out, /children:B\.submenu\.map\(/);
  assert.match(out, /z\(B\.id\)/);
});

test('修复分支：旧补丁打坏的 0.1.2 包把 B/z 改回 $/J', () => {
  const out = patchMenuSubmenuContainerSource(FIX_BROKEN);
  assert.notEqual(out, undefined);
  assert.match(out, /children:\$\.submenu\.map\(/);
  assert.match(out, /J\(\$\.id\)/);
  assert.match(out, /setTimeout\(\(\)=>J\(null\),400\)/);
  assert.equal(out.includes('B.submenu'), false);
  assert.equal(out.includes('z(B.id)'), false);
});

test('幂等：已正确补丁的包原样返回', () => {
  const once012 = patchMenuSubmenuContainerSource(FIX_012);
  assert.notEqual(once012, undefined);
  assert.equal(patchMenuSubmenuContainerSource(once012), once012);
  const onceBroken = patchMenuSubmenuContainerSource(FIX_BROKEN);
  assert.notEqual(onceBroken, undefined);
  assert.equal(patchMenuSubmenuContainerSource(onceBroken), onceBroken);
  const onceRc2 = patchMenuSubmenuContainerSource(FIX_RC2);
  assert.notEqual(onceRc2, undefined);
  assert.equal(patchMenuSubmenuContainerSource(onceRc2), onceRc2);
});

test('fail-closed：无 submenu 锚点返回 undefined', () => {
  assert.equal(patchMenuSubmenuContainerSource('const x = 1;\n'), undefined);
});

test('fail-closed：role 锚点距离过远返回 undefined', () => {
  const bad = 'role:"menu",' + 'x'.repeat(500) + 'children:$.submenu.map(fe=>fe.id)';
  assert.equal(patchMenuSubmenuContainerSource(bad), undefined);
});
