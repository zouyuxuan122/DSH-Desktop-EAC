// dsh-distribution 发行版描述符（阶段 3）：打包时生成 DistributionDescriptor，
// 随资源分发到 dsh-desktop/distribution-descriptor.json。
//
// 协议：https://github.com/T-Auto/dsh-distribution（Draft，apiVersion v1alpha1）。
// 原则：只描述真实情况 —— 组件与版本全部来自 assets/SOURCES.json（插件来源
// 台账）与 dsh-desktop/package.json（内核钉版），数据位置只写已核实的路径；
// 尚未核实的资源（如会话目录布局随内核版本演进）不编造，宁可省略。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const DSH_HOME = '~/.dsh';

function githubRef(repository, version) {
  // https://github.com/<owner>/<repo>[#subdir|/tree/...] -> pkg:github/<owner>/<repo>@<ref>
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/#]+)/.exec(String(repository || ''));
  if (!match) return null;
  return `pkg:github/${match[1]}/${match[2]}@${version || 'main'}`;
}

function componentRef(entry) {
  if (entry.type === 'host-fused') {
    return { ref: `builtin:eac-host/${entry.name || entry.id}`, note: '宿主融合能力，随壳分发' };
  }
  const upstream = entry.upstream || {};
  if (upstream.repository) {
    const ref = githubRef(upstream.repository, entry.version)
      || `pkg:eac-vendored/${entry.name || entry.id}@${entry.version || 'local'}`;
    return { ref, upstreamPinned: upstream.pinnedHead || upstream.refType || 'version' };
  }
  return { ref: `builtin:eac/${entry.name || entry.id}@${entry.version || 'local'}`, note: 'EAC 自研' };
}

export function genDistributionDescriptor({ ddRoot, stagedOut }) {
  const pkg = JSON.parse(readFileSync(path.join(ddRoot, 'package.json'), 'utf8'));
  const ledger = JSON.parse(readFileSync(path.join(ddRoot, 'assets', 'SOURCES.json'), 'utf8'));
  // 内核钉版：dependencies["@deepseek-ai/dsh"] = file:vendor/kernel/<ver>/...tgz
  const kernelDep = pkg.dependencies?.['@deepseek-ai/dsh'] || '';
  const kernelVersion = /deepseek-ai-dsh-([\w.\-+]+)\.tgz/.exec(kernelDep)?.[1] || 'unknown';
  const appVersion = pkg.version || 'unknown';

  const components = [
    { id: 'runtime', ref: `pkg:npm/@deepseek-ai/dsh@${kernelVersion}`, note: 'DeepSeek Harness 内核（vendored tarball，禁止改动）' },
    { id: 'shell', ref: `pkg:github/zouyuxuan122/DSH-Desktop-EAC@v${appVersion}`, dependsOn: ['runtime'], note: 'Tauri 2 桌面壳 + sidecar' },
  ];
  for (const entry of ledger.components) {
    if (entry.line !== 'main') continue; // aio-v1 线由发行分支自带 seed 描述
    if (!['plugin', 'skin', 'preset', 'source-copy', 'seed'].includes(entry.type)) continue;
    const { ref, ...rest } = componentRef(entry);
    components.push({ id: entry.type === 'source-copy' ? `${entry.name}#source-copy` : String(entry.name || entry.id), ref, dependsOn: ['runtime'], ...rest });
  }

  const descriptor = {
    apiVersion: 'distribution.dsh.dev/v1alpha1',
    kind: 'DistributionDescriptor',
    distribution: { id: 'urn:github:zouyuxuan122:dsh-desktop-eac', version: appVersion },
    displayName: 'Deepseek Harness EAC（全量/精简双形态，Tauri 2）',
    protocols: [
      {
        apiVersion: 'composition.distribution.dsh.dev/v1alpha1',
        kind: 'EnvironmentComposition',
        required: true,
        spec: { components },
      },
      {
        apiVersion: 'layout.distribution.dsh.dev/v1alpha1',
        kind: 'ManagedLayout',
        required: true,
        spec: {
          resources: [
            { id: 'config', role: 'config', location: { type: 'absolute-path', value: DSH_HOME }, ownership: 'exclusive', portability: 'portable', sensitivity: 'private' },
            { id: 'profile', role: 'state', location: { type: 'absolute-path', value: `${DSH_HOME}/profiles/web-desktop` }, ownership: 'exclusive', portability: 'conditional', sensitivity: 'private' },
            { id: 'extensions', role: 'extensions', location: { type: 'absolute-path', value: `${DSH_HOME}/profiles/web-desktop/node_modules` }, ownership: 'exclusive', portability: 'conditional', sensitivity: 'public' },
            { id: 'agent-presets', role: 'data', location: { type: 'absolute-path', value: `${DSH_HOME}/.agent-presets` }, ownership: 'exclusive', portability: 'portable', sensitivity: 'private' },
          ],
        },
      },
      {
        apiVersion: 'lifecycle.distribution.dsh.dev/v1alpha1',
        kind: 'EnvironmentLifecycle',
        required: false,
        spec: { states: ['available', 'active', 'inactive', 'broken', 'migrating'] },
      },
      {
        apiVersion: 'portability.distribution.dsh.dev/v1alpha1',
        kind: 'EnvironmentPortability',
        required: false,
        spec: { modes: ['clone', 'export', 'migrate'] },
      },
    ],
    'x-eac': {
      installProfiles: ['full', 'lite'],
      profileMarker: 'dsh-desktop/profile.txt',
      ledger: 'dsh-desktop/assets/SOURCES.json',
      generatedAt: new Date().toISOString(),
    },
  };

  mkdirSync(stagedOut, { recursive: true });
  writeFileSync(path.join(stagedOut, 'distribution-descriptor.json'), JSON.stringify(descriptor, null, 2) + '\n');
  return { kernelVersion, appVersion, components: components.length };
}
