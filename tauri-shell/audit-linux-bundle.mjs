import { existsSync, openSync, closeSync, readSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

function walkFiles(root) {
  const out = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile()) out.push(file);
    }
  };
  visit(root);
  return out;
}

function elfMachine(file) {
  const fd = openSync(file, 'r');
  try {
    const header = Buffer.alloc(20);
    if (readSync(fd, header, 0, header.length, 0) !== header.length
      || header[0] !== 0x7f || header.toString('ascii', 1, 4) !== 'ELF') return null;
    return header.readUInt16LE(18);
  } finally {
    closeSync(fd);
  }
}

function containsBytes(file, needle) {
  const fd = openSync(file, 'r');
  const chunk = Buffer.alloc(64 * 1024);
  let carry = Buffer.alloc(0);
  try {
    for (;;) {
      const count = readSync(fd, chunk, 0, chunk.length, null);
      if (count === 0) return false;
      const data = Buffer.concat([carry, chunk.subarray(0, count)]);
      if (data.indexOf(needle) !== -1) return true;
      carry = data.subarray(Math.max(0, data.length - needle.length + 1));
    }
  } finally {
    closeSync(fd);
  }
}

export function auditLinuxBundle(root, options = {}) {
  const absoluteRoot = path.resolve(root);
  const scanRoot = path.resolve(options.scanRoot || absoluteRoot);
  if (!existsSync(absoluteRoot)) throw new Error(`Linux bundle root does not exist: ${absoluteRoot}`);
  if (!existsSync(scanRoot)) throw new Error(`Linux bundle scan root does not exist: ${scanRoot}`);

  const runtime = path.join(absoluteRoot, 'dsh-desktop', 'vendor', 'node', 'node');
  const requiredNative = [
    path.join(absoluteRoot, 'dsh-desktop', 'native', 'supervisor', 'index.node'),
    path.join(absoluteRoot, 'dsh-desktop', 'native', 'snapshot', 'index.node'),
  ];
  const errors = [];
  for (const file of [runtime, ...requiredNative]) {
    if (!existsSync(file)) errors.push(`required Linux payload is missing: ${path.relative(absoluteRoot, file)}`);
  }
  if (existsSync(runtime) && (statSync(runtime).mode & 0o111) === 0) {
    errors.push(`Linux runtime is not executable: ${path.relative(absoluteRoot, runtime)}`);
  }

  const files = walkFiles(scanRoot);
  const forbiddenPaths = (options.forbiddenPaths || [process.cwd()])
    .flatMap((value) => [String(value), String(value).replaceAll('\\', '/')])
    .filter((value, index, all) => value.length > 3 && all.indexOf(value) === index)
    .map((value) => Buffer.from(value));
  for (const file of files) {
    const rel = path.relative(scanRoot, file);
    if (/\.(?:exe|dll)$/i.test(file)) errors.push(`Windows payload in Linux bundle: ${rel}`);
    if (/\.node$/i.test(file) && rel.split(path.sep).some((part) => /(?:^musl[_-]|linuxmusl)/i.test(part))) {
      errors.push(`musl payload in glibc bundle: ${rel}`);
    }
    const machine = elfMachine(file);
    if ((file === runtime || /\.node$/i.test(file)) && machine === null) {
      errors.push(`Linux native payload is not ELF: ${rel}`);
    } else if (machine !== null && machine !== 62) {
      errors.push(`Linux native payload is not x86_64 ELF (e_machine=${machine}): ${rel}`);
    }
    if (forbiddenPaths.some((needle) => containsBytes(file, needle))) {
      errors.push(`local build path embedded in Linux bundle: ${rel}`);
    }
  }
  if (errors.length) throw new Error(errors.join('\n'));
  return { filesChecked: files.length, nativeModules: files.filter((file) => /\.node$/i.test(file)).length };
}

export function auditLinuxGlibc(root, maximum = '2.35') {
  const absoluteRoot = path.resolve(root);
  const candidates = walkFiles(absoluteRoot).filter((file) => elfMachine(file) !== null);
  const [maxMajor, maxMinor] = maximum.split('.').map(Number);
  const violations = [];
  for (const file of candidates) {
    let output;
    try {
      output = execFileSync('readelf', ['--version-info', file], { encoding: 'utf8' });
    } catch (err) {
      throw new Error(`readelf failed for ${path.relative(absoluteRoot, file)}: ${err.message}`);
    }
    for (const match of output.matchAll(/GLIBC_(\d+)\.(\d+)/g)) {
      const major = Number(match[1]);
      const minor = Number(match[2]);
      if (major > maxMajor || (major === maxMajor && minor > maxMinor)) {
        violations.push(`${path.relative(absoluteRoot, file)} requires GLIBC_${major}.${minor}`);
      }
    }
  }
  if (violations.length) throw new Error(`GLIBC baseline ${maximum} exceeded:\n${[...new Set(violations)].join('\n')}`);
  return { binariesChecked: candidates.length, maximum };
}

const invoked = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invoked) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const root = process.argv[2] || path.join(here, 'staged-resources');
  const scanRoot = process.argv[3] || root;
  try {
    const result = auditLinuxBundle(root, { scanRoot });
    const glibc = auditLinuxGlibc(scanRoot);
    console.log(`[audit-linux] OK files=${result.filesChecked} native=${result.nativeModules} glibc<=${glibc.maximum}`);
  } catch (err) {
    console.error(`[audit-linux] FAILED\n${err.message}`);
    process.exitCode = 1;
  }
}
