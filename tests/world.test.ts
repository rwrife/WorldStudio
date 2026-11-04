import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorldManager, type Settings } from '../src/main/world'
import { editProfile, type WorldConfig, type WorldRequest } from '../src/shared/world'
import { triangleGlb } from './fixtures'

const temp = mkdtempSync(join(tmpdir(), 'world-studio-test-'))
const output = join(temp, 'comfy-output')
const checkpoints = ['DreamShaper_8_pruned.safetensors', 'hunyuan3d-dit-v2-mini_fp16.safetensors']
const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')

type Node = { class_type: string; inputs: Record<string, unknown> }
const submitted: Record<string, Node>[] = []
const outputs = new Map<string, { node: string; field: string; filename: string } | 'error' | 'hang'>()
const cancelled: string[] = []
const failText = /^A single Broken statue/
let hangConcept = false

const combo = (values: string[]) => ({ input: { required: { name: [values] } } })
const nodeInfo: Record<string, unknown> = Object.fromEntries([
  'CLIPTextEncode', 'EmptyLatentImage', 'KSampler', 'VAEDecode', 'SaveImage', 'LoadImage', 'ImageScale', 'VAEEncode', 'ImageScaleToTotalPixels',
  'ConditioningZeroOut', 'ReferenceLatent', 'CFGGuider', 'EmptyFlux2LatentImage', 'Flux2Scheduler', 'GetImageSize', 'KSamplerSelect', 'RandomNoise',
  'SamplerCustomAdvanced', 'RemoveBackground', 'InvertMask', 'JoinImageWithAlpha', 'ImageOnlyCheckpointLoader', 'CLIPVisionEncode',
  'Hunyuan3Dv2Conditioning', 'EmptyLatentHunyuan3Dv2', 'VAEDecodeHunyuan3D', 'VoxelToMesh', 'SaveGLB', 'ModelSamplingAuraFlow', 'EmptyImage', 'ImageCompositeMasked'
].map(name => [name, { input: { required: {} } }]))
Object.assign(nodeInfo, {
  CheckpointLoaderSimple: { input: { required: { ckpt_name: [checkpoints] } } },
  LoadBackgroundRemovalModel: { input: { required: { bg_removal_name: [['birefnet.safetensors']] } } },
  UNETLoader: { input: { required: { unet_name: [[editProfile.model]] } } },
  CLIPLoader: { input: { required: { clip_name: [[editProfile.textEncoder]] } } },
  VAELoader: { input: { required: { vae_name: ['COMBO', { options: [editProfile.vae] }] } } },
  CLIPVisionLoader: combo([]),
  CloudOnlyNode: { input: { required: {} }, api_node: true }
})

const body = async (request: IncomingMessage) => {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}
const server = createServer(async (request, response) => {
  const send = (value: unknown, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)) }
  const url = request.url ?? '/'
  if (url === '/system_stats') return send({ devices: [{ name: 'cuda:0 Test GPU', type: 'cuda', vram_total: 24 * 2 ** 30, vram_free: 22 * 2 ** 30 }] })
  if (url === '/object_info') return send(nodeInfo)
  if (url === '/api/tags') return send({ models: [{ name: 'qwen2.5vl:7b' }, { name: 'gpt-oss:120b-cloud' }] })
  if (url === '/api/show') return send({ capabilities: ['completion', 'vision'] })
  if (url === '/api/generate') {
    const { prompt } = JSON.parse((await body(request)).toString())
    assert.deepEqual(JSON.parse(prompt).expected_props, ['Barrel', 'Broken statue', 'Lantern'])
    return send({ done: true, response: JSON.stringify({ objects: [
      { name: 'barrel', box: [100, 500, 250, 800] }, { name: 'Barrels', box: [300, 500, 450, 800] },
      { name: 'Lantern', box: [600, 200, 700, 600] }, { name: 'Fishing net', box: [750, 600, 950, 900] }
    ] }) })
  }
  if (url === '/upload/image') {
    const name = /filename="([^"]+)"/.exec((await body(request)).toString('latin1'))?.[1]
    return send({ name, subfolder: '', type: 'input' })
  }
  if (url.startsWith('/api/jobs/')) { cancelled.push(url.split('/')[3]); return send({}) }
  if (url === '/prompt') {
    const { prompt, prompt_id: id } = JSON.parse((await body(request)).toString()) as { prompt: Record<string, Node>; prompt_id: string }
    submitted.push(prompt)
    const [node, save] = Object.entries(prompt).find(([, n]) => n.class_type === 'SaveImage' || n.class_type === 'SaveGLB')!
    const texts = Object.values(prompt).filter(n => n.class_type === 'CLIPTextEncode').map(n => String(n.inputs.text))
    if (hangConcept && node === '7' && prompt['1'].class_type === 'CheckpointLoaderSimple') outputs.set(id, 'hang')
    else if (texts.some(text => failText.test(text))) outputs.set(id, 'error')
    else {
      const mesh = save.class_type === 'SaveGLB'
      const filename = `${save.inputs.filename_prefix}_00001_.${mesh ? 'glb' : 'png'}`
      writeFileSync(join(output, filename), mesh ? triangleGlb() : png)
      outputs.set(id, { node, field: mesh ? '3d' : 'images', filename })
    }
    return send({ prompt_id: id, number: submitted.length })
  }
  if (url.startsWith('/history/')) {
    const id = url.slice('/history/'.length), result = outputs.get(id)
    if (!result || result === 'hang') return send({})
    if (result === 'error') return send({ [id]: { outputs: {}, status: { completed: false, status_str: 'error', messages: [['execution_error', { node_type: 'KSampler', exception_message: 'CUDA out of memory' }]] } } })
    return send({ [id]: { outputs: { [result.node]: { [result.field]: [{ filename: result.filename, subfolder: '', type: 'output' }] } }, status: { completed: true, status_str: 'success', messages: [] } } })
  }
  send({ error: 'not found' }, 404)
})

const ready = new Promise<string>(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)))
after(() => { server.close(); rmSync(temp, { recursive: true, force: true }) })
mkdirSync(output, { recursive: true })

const config: WorldConfig = {
  imageProfile: 'sd15', checkpoint: checkpoints[0], meshProfile: 'mini', meshCheckpoint: checkpoints[1], visionModel: 'qwen2.5vl:7b',
  backgroundModel: 'birefnet.safetensors', editModel: editProfile.model, editTextEncoder: editProfile.textEncoder, editVae: editProfile.vae
}
const brief: WorldRequest = {
  title: 'Harbor Market', location: 'A small fishing harbor market on a wooden pier at dusk', style: 'stylized hand-painted low-poly',
  props: [{ name: 'Barrel', description: 'oak with iron bands', quantity: 2 }, { name: 'Broken statue', description: '', quantity: 1 }, { name: 'Lantern', description: '', quantity: 1 }],
  seed: 1234, steps: 20, referenceStrength: 0.3
}

async function manager(name: string, base: string, assets = new Map<string, string>()) {
  const settings: Settings = { comfyUrl: base, comfyRoot: join(temp, 'comfy'), comfyOutput: output }
  let busy = false
  const acquire = () => {
    if (busy) throw new Error('Another job is running.')
    busy = true
    return () => { busy = false }
  }
  const images = { normalize: (file: string) => readFile(file), crop: async () => png }
  return new WorldManager(join(temp, name), assets, () => settings, acquire, () => {}, images, undefined, base)
}

test('a world runs end to end: concept, detection, batch extraction, batch 3D, layout and export', async () => {
  const base = await ready
  const assets = new Map<string, string>()
  const studio = await manager('studio', base, assets)
  studio.saveConfig(config)
  const ready_ = await studio.readiness()
  assert.deepEqual(ready_.visionModels, ['qwen2.5vl:7b'], 'cloud Ollama models are never offered')
  assert.deepEqual(ready_.vaes, [editProfile.vae])
  assert.equal(Math.round(ready_.devices[0].freeGB), 22)

  const id = studio.create(brief)
  let world = studio.snapshot().worlds[0]
  assert.deepEqual(world.items.map(i => i.name), ['Harbor Market', 'Barrel', 'Broken statue', 'Lantern'])

  await studio.runConcept(id)
  world = studio.snapshot().worlds[0]
  assert.equal(world.status, 'idle')
  assert.equal(world.conceptSource, 'generated')
  assert.match(world.conceptUrl!, /^studio:\/\/asset\/world-/)
  assert.match(String(submitted.at(-1)!['2'].inputs.text), /fishing harbor.*2 Barrel \(oak with iron bands\).*Art style: stylized hand-painted low-poly/)
  assert.ok(existsSync(join(temp, 'studio', 'worlds', id, 'concept.png')))
  assert.ok(existsSync(join(temp, 'studio', 'worlds', id, 'workflows', 'concept.json')), 'the exact workflow is recorded')
  await assert.rejects(studio.runConcept(id), /already has a concept/)

  await studio.detect(id)
  world = studio.snapshot().worlds[0]
  const named = (n: string) => world.items.find(i => i.name === n)!
  assert.equal(named('Barrel').boxes.length, 2)
  assert.equal(named('Lantern').boxes.length, 1)
  assert.equal(named('Broken statue').boxes.length, 0)
  assert.equal(named('Fishing net').origin, 'detected')
  assert.match(world.message, /placed 4 boxes.*Not found in the concept.*Broken statue/)

  const before = submitted.length
  await studio.runBatch(id, 'reference')
  world = studio.snapshot().worlds[0]
  assert.equal(world.status, 'idle', 'one failed item does not fail the batch')
  assert.deepEqual(world.items.map(i => [i.name, i.referenceStatus]), [
    ['Harbor Market', 'complete'], ['Barrel', 'complete'], ['Broken statue', 'failed'], ['Lantern', 'complete'], ['Fishing net', 'complete']
  ])
  assert.match(named('Broken statue').referenceMessage!, /KSampler: CUDA out of memory/)
  assert.equal(named('Broken statue').referenceUrl, undefined, 'failed items are never shown as complete')
  assert.match(world.message, /4 complete, 1 failed, 0 skipped of 5 approved\. Failed items are not used/)
  const batch = submitted.slice(before)
  assert.equal(batch.length, 5)
  assert.match(String(batch[0]['8'].inputs.text), /^Remove these objects: Barrel, Broken statue, Lantern, Fishing net\. Show only the empty location/, 'environment runs first')
  assert.match(String(batch[1]['8'].inputs.text), /^Isolate the Barrel \(oak with iron bands\) from this image/)
  assert.equal(batch[1]['1'].class_type, 'UNETLoader')
  assert.match(String(batch[2]['2'].inputs.text), /^A single Broken statue, a static prop belonging in A small fishing harbor.*Art style: stylized/)
  assert.ok(batch.every(workflow => workflow['16']?.class_type === 'LoadBackgroundRemovalModel'), 'every reference is background-removed')

  studio.setItemPhase(id, named('Broken statue').id, 'reference', 'skip')
  assert.equal(studio.snapshot().worlds[0].items[2].referenceStatus, 'skipped')

  await studio.runBatch(id, 'model')
  world = studio.snapshot().worlds[0]
  assert.equal(world.status, 'idle')
  assert.deepEqual(world.items.map(i => i.modelStatus), ['complete', 'complete', 'pending', 'complete', 'complete'])
  assert.equal(named('Barrel').transforms.length, 2, 'one transform per instance')
  assert.equal(world.items[0].transforms[0].scale, 10, 'the environment is the scene base')
  assert.equal(named('Barrel').modelTextured, false)
  assert.ok(submitted.slice(-4).every(workflow => workflow['9'].class_type === 'SaveGLB'))
  await assert.rejects(studio.runBatch(id, 'model'), /No approved items with completed references/)

  const barrel = named('Barrel')
  studio.saveLayout(id, [{ itemId: barrel.id, transforms: [{ position: [1, 0, 2], rotationY: 0.5, scale: 1.5 }, barrel.transforms[1]] }])
  assert.deepEqual(studio.snapshot().worlds[0].items[1].transforms[0], { position: [1, 0, 2], rotationY: 0.5, scale: 1.5 })

  const exported = await studio.exportBundle(id, join(temp, 'exports'), triangleGlb())
  assert.deepEqual(readdirSync(join(exported, 'models')).sort(), ['barrel.glb', 'fishing-net.glb', 'harbor-market.glb', 'lantern.glb'])
  assert.ok(existsSync(join(exported, 'scene.glb')) && existsSync(join(exported, 'concept.png')))
  const manifest = JSON.parse(readFileSync(join(exported, 'world.json'), 'utf8'))
  assert.equal(manifest.format, 'world-studio/1')
  assert.equal(manifest.scene, 'scene.glb')
  assert.equal(manifest.items.length, 5)
  assert.deepEqual(manifest.items[1].instances[0], { position: [1, 0, 2], rotationY: 0.5, scale: 1.5 })
  assert.equal(manifest.items[2].model, undefined)
  assert.deepEqual(manifest.items[2].status, { reference: 'skipped', model: 'pending' })
  await assert.rejects(studio.exportBundle(id, join(temp, 'exports'), new Uint8Array(12)), /complete binary glTF/)

  const reopened = await manager('studio', base)
  const persisted = reopened.snapshot().worlds[0]
  assert.equal(persisted.items[1].modelStatus, 'complete')
  assert.match(persisted.items[1].modelUrl!, /^studio:\/\/asset\//)
  assert.ok([...assets.values()].every(file => file.startsWith(join(temp, 'studio'))), 'assets only map into the workspace')
})

test('missing weights stop the job with a download recovery instead of a fake result', async () => {
  const base = await ready
  const studio = await manager('missing', base)
  studio.saveConfig({ ...config, checkpoint: 'not-installed.safetensors' })
  const id = studio.create(brief)
  await assert.rejects(studio.runConcept(id), /Select an installed SD 1\.5 or SDXL checkpoint/)
  let world = studio.snapshot().worlds[0]
  assert.equal(world.status, 'failed')
  assert.deepEqual(world.recovery, { package: 'sd15' })
  assert.equal(world.conceptUrl, undefined)

  studio.saveConfig({ ...config, editModel: 'flux1-kontext.safetensors' })
  nodeInfo.UNETLoader = { input: { required: { unet_name: [[editProfile.model, 'flux1-kontext.safetensors']] } } }
  await studio.runConcept(id)
  await assert.rejects(studio.runBatch(id, 'reference'), /supported distilled FLUX\.2 klein 4B/)
  world = studio.snapshot().worlds[0]
  assert.equal(world.status, 'failed')
  assert.ok(world.items.every(item => item.referenceStatus === 'pending'), 'no item is marked complete or failed when the batch cannot start')
})

test('cancelling a running job cancels only its own ComfyUI prompt and preserves the world', async () => {
  const base = await ready
  const studio = await manager('cancel', base)
  studio.saveConfig(config)
  const id = studio.create(brief)
  hangConcept = true
  const running = studio.runConcept(id)
  while (!studio.snapshot().worlds[0].promptId) await new Promise(resolve => setTimeout(resolve, 10))
  const promptId = studio.snapshot().worlds[0].promptId!
  await studio.cancel()
  await assert.rejects(running, /cancelled/)
  hangConcept = false
  const world = studio.snapshot().worlds[0]
  assert.equal(world.status, 'cancelled')
  assert.equal(world.conceptUrl, undefined)
  assert.deepEqual(cancelled, [promptId])
})
