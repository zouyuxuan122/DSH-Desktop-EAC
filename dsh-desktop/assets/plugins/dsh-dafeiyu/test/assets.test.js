import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const assetRoot = join(repositoryRoot, 'assets', 'pet')
const manifestPath = join(repositoryRoot, 'assets', 'pet-manifest.json')

async function pngFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await pngFiles(path))
    else if (entry.isFile() && entry.name.endsWith('.png')) files.push(path)
  }
  return files
}

test('pet manifest allowlists every bundled runtime frame', async () => {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  assert.equal(manifest.formatVersion, 1)
  assert.equal(manifest.baseSize, 238)
  assert.ok(Object.keys(manifest.clips).length >= 18)

  const declared = new Set()
  for (const [clipName, clip] of Object.entries(manifest.clips)) {
    assert.ok(Array.isArray(clip.frames) && clip.frames.length > 0, `${clipName} has no frames`)
    assert.ok(Number.isInteger(clip.frameMs) && clip.frameMs > 0, `${clipName} has invalid frameMs`)
    for (const frame of clip.frames) {
      assert.equal(typeof frame, 'string')
      const path = resolve(assetRoot, frame)
      assert.ok(path.startsWith(`${assetRoot}${sep}`), `${clipName} escapes the asset root`)
      assert.equal(declared.has(frame), false, `duplicate frame declaration: ${frame}`)
      declared.add(frame)
      const bytes = await readFile(path)
      assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])
      const width = bytes.readUInt32BE(16)
      const height = bytes.readUInt32BE(20)
      assert.ok(width > 0 && width <= manifest.maxFrameWidth, `${frame} width exceeds the runtime envelope`)
      assert.ok(height > 0 && height <= manifest.maxFrameHeight, `${frame} height exceeds the runtime envelope`)
    }
  }

  const bundled = new Set((await pngFiles(assetRoot)).map((path) => relative(assetRoot, path).split(sep).join('/')))
  assert.deepEqual([...bundled].sort(), [...declared].sort())
  for (const clip of Object.values(manifest.stateMap)) assert.ok(manifest.clips[clip])
  for (const clip of Object.values(manifest.workingActivityMap)) assert.ok(manifest.clips[clip])
  for (const clip of manifest.idleMicroClips) assert.ok(manifest.clips[clip])
})

test('multi-frame clips keep the mildly accelerated motion timing', async () => {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const expectedFrameMs = {
    blink: 100,
    glance: 160,
    working_search: 135,
    working_command: 135,
    walk_start_left: 118,
    walk_stop_left: 135,
    walk_start_right: 118,
    walk_stop_right: 135,
    head_pat: 180,
    poke: 170,
    tail: 220,
  }

  for (const [clipName, frameMs] of Object.entries(expectedFrameMs)) {
    assert.equal(manifest.clips[clipName].frameMs, frameMs, `${clipName} motion timing drifted`)
  }
})

test('dragging keeps a stable held frame without procedural motion', async () => {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  assert.deepEqual(manifest.clips.dragging.frames, ['dragging/dragging_238_01.png'])
  assert.equal(manifest.clips.dragging.motion, undefined)
})

test('drag phase clips cover release, daze, and protest', async () => {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const expected = {
    dragging_release: { frame: 'dragging/dragging_238_02.png', frameMs: 200, loop: false },
    dragging_dizzy: { frame: 'dragging/dragging_238_03.png', frameMs: 260, loop: true },
    dragging_protest: { frame: 'dragging/dragging_238_04.png', frameMs: 260, loop: false },
  }

  for (const [clipName, expectation] of Object.entries(expected)) {
    const clip = manifest.clips[clipName]
    assert.ok(clip, `${clipName} must stay registered in the manifest`)
    assert.deepEqual(clip.frames, [expectation.frame], `${clipName} frame drifted`)
    assert.equal(clip.frameMs, expectation.frameMs, `${clipName} timing drifted`)
    assert.equal(clip.loop, expectation.loop, `${clipName} looping drifted`)
  }
})

test('original notification sounds are valid short mono WAV files', async () => {
  for (const name of ['success.wav', 'error.wav']) {
    const bytes = await readFile(join(repositoryRoot, 'assets', 'sounds', name))
    assert.equal(bytes.subarray(0, 4).toString('ascii'), 'RIFF')
    assert.equal(bytes.subarray(8, 12).toString('ascii'), 'WAVE')
    assert.equal(bytes.readUInt16LE(22), 1, `${name} must stay mono`)
    assert.equal(bytes.readUInt32LE(24), 44100, `${name} sample rate drifted`)
    assert.ok(bytes.length > 20_000 && bytes.length < 50_000, `${name} should remain a short lightweight alert`)
  }
})
