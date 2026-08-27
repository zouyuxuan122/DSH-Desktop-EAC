import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const launch = process.platform === 'win32'
  ? {
      command: 'powershell',
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', resolve(root, 'scripts', 'build-helper.ps1')],
    }
  : process.platform === 'linux'
    ? { command: 'bash', args: [resolve(root, 'scripts', 'build-helper.sh')] }
    : process.platform === 'darwin'
      ? { command: 'bash', args: [resolve(root, 'native', 'macos', 'build.sh')] }
    : undefined

if (!launch) {
  throw new Error(`Helper builds are not configured for ${process.platform}/${process.arch}`)
}

const child = spawn(launch.command, launch.args, { cwd: root, stdio: 'inherit' })
child.once('error', (error) => {
  console.error(`Unable to start the Helper build: ${error.message}`)
  process.exitCode = 1
})
child.once('exit', (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0)
})
