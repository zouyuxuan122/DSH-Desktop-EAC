import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { auditLinuxBundle } from '../../tauri-shell/audit-linux-bundle.mjs';

const ELF = Buffer.from([
  0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x03, 0x00, 0x3e, 0x00,
]);

function fixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eac-linux-bundle-'));
  const runtime = path.join(root, 'dsh-desktop', 'vendor', 'node', 'node');
  const supervisor = path.join(root, 'dsh-desktop', 'native', 'supervisor', 'index.node');
  const snapshot = path.join(root, 'dsh-desktop', 'native', 'snapshot', 'index.node');
  for (const file of [runtime, supervisor, snapshot]) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, ELF);
  }
  fs.chmodSync(runtime, 0o755);
  return root;
}

test('Linux bundle audit accepts ELF runtime and native modules', () => {
  const root = fixture();
  try {
    assert.deepEqual(auditLinuxBundle(root), { filesChecked: 3, nativeModules: 2 });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Linux bundle audit rejects Windows payloads anywhere in the reachable tree', () => {
  const root = fixture();
  const helper = path.join(root, 'dsh-desktop', 'assets', 'plugins', 'pet', 'helper.exe');
  fs.mkdirSync(path.dirname(helper), { recursive: true });
  fs.writeFileSync(helper, Buffer.from('MZ'));
  try {
    assert.throws(() => auditLinuxBundle(root), /Windows payload.*helper\.exe/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Linux bundle audit rejects a PE native module and a non-executable runtime', () => {
  const root = fixture();
  const native = path.join(root, 'dsh-desktop', 'native', 'snapshot', 'index.node');
  fs.writeFileSync(native, Buffer.from('MZ fake PE'));
  fs.chmodSync(path.join(root, 'dsh-desktop', 'vendor', 'node', 'node'), 0o644);
  try {
    assert.throws(() => auditLinuxBundle(root), /not executable|not ELF/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Linux bundle audit rejects musl native modules in the glibc distribution', () => {
  const root = fixture();
  const native = path.join(root, 'dsh-desktop', 'node_modules', '@img', 'sharp-linuxmusl-x64', 'addon.node');
  fs.mkdirSync(path.dirname(native), { recursive: true });
  fs.writeFileSync(native, ELF);
  try {
    assert.throws(() => auditLinuxBundle(root), /musl payload in glibc bundle.*addon\.node/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Linux bundle audit rejects embedded local build paths', () => {
  const root = fixture();
  const generated = path.join(root, 'dsh-desktop', 'generated.js');
  fs.writeFileSync(generated, 'const source = "/home/alice/work/eac/private.ts";');
  try {
    assert.throws(
      () => auditLinuxBundle(root, { forbiddenPaths: ['/home/alice/work/eac'] }),
      /local build path.*generated\.js/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Linux bundle audit scans the complete extracted artifact outside the resource root', () => {
  const artifact = fs.mkdtempSync(path.join(os.tmpdir(), 'eac-linux-artifact-'));
  const resources = path.join(artifact, 'usr', 'lib', 'deepseek-harness-eac');
  fs.mkdirSync(resources, { recursive: true });
  const payload = fixture();
  fs.cpSync(path.join(payload, 'dsh-desktop'), path.join(resources, 'dsh-desktop'), { recursive: true });
  const leaked = path.join(artifact, 'usr', 'bin', 'generated-launcher');
  fs.mkdirSync(path.dirname(leaked), { recursive: true });
  fs.writeFileSync(leaked, '#!/bin/sh\nexec /root/code/eacnolinux/private-bin\n');
  try {
    assert.throws(
      () => auditLinuxBundle(resources, {
        scanRoot: artifact,
        forbiddenPaths: ['/root/code/eacnolinux'],
      }),
      /local build path.*usr\/bin\/generated-launcher/,
    );
  } finally {
    fs.rmSync(payload, { recursive: true, force: true });
    fs.rmSync(artifact, { recursive: true, force: true });
  }
});
