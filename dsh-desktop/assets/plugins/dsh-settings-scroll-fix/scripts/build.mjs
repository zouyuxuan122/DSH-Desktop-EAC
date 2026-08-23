import { copyFile, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
await mkdir(resolve(root, 'lib'), { recursive: true })
await Promise.all([
  copyFile(resolve(root, 'src/index.js'), resolve(root, 'lib/index.js')),
  copyFile(resolve(root, 'src/client.js'), resolve(root, 'lib/client.js')),
])
console.log('Built lib/index.js and lib/client.js')
