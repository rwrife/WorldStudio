import test from 'node:test'
import assert from 'node:assert/strict'
import { validateGlbBytes } from '../src/main/glb-validation'
import { validateCutout } from '../src/main/image-validation'
import { errorText, localUrl, settingsSchema } from '../src/main/validation'
import { boxSchema, itemEditsSchema, layoutSchema, parseDetections, worldConfigSchema, worldRequestSchema } from '../src/main/world'
import { modelPackages, needsWorldModel } from '../src/shared/world-models'
import { editProfile, type WorldConfig, type WorldReadiness } from '../src/shared/world'
import { triangleGlb } from './fixtures'

test('ComfyUI connections stay on loopback', () => {
  assert.equal(localUrl('http://127.0.0.1:8189/'), 'http://127.0.0.1:8189')
  assert.equal(localUrl('http://localhost:8189'), 'http://localhost:8189')
  assert.equal(localUrl('http://[::1]:8189'), 'http://[::1]:8189')
  for (const url of ['https://127.0.0.1:8189', 'http://192.168.1.4:8189', 'http://example.com', 'http://127.0.0.1:8189/api', 'http://user:pw@127.0.0.1:8189', 'http://127.0.0.1:8189/?x=1'])
    assert.throws(() => localUrl(url), /local ComfyUI URL/, url)
  assert.equal(settingsSchema.parse({ comfyUrl: 'http://127.0.0.1:8189/', comfyRoot: 'C:\\ComfyUI', comfyOutput: 'C:\\ComfyUI\\output' }).comfyUrl, 'http://127.0.0.1:8189')
  assert.throws(() => settingsSchema.parse({ comfyUrl: 'http://127.0.0.1:8189', comfyRoot: 'x', comfyOutput: 'y', extra: 1 }))
})

test('world briefs, boxes and layouts are validated at the IPC boundary', () => {
  const brief = { title: '', location: 'Desert outpost', style: 'pixel-art inspired voxels', props: [{ name: 'Cactus', description: '', quantity: 4 }], seed: 1, steps: 20, referenceStrength: 0.3 }
  assert.deepEqual(worldRequestSchema.parse(brief), brief)
  const failure = worldRequestSchema.safeParse({ ...brief, location: 'x', style: '' })
  assert.equal(failure.success, false)
  assert.match(errorText(failure.error), /Describe the world or location\. Describe the art style\./)
  assert.match(errorText(worldRequestSchema.safeParse({ ...brief, props: [{ name: ' ', description: '', quantity: 1 }] }).error), /Every prop needs a name/)
  assert.match(errorText(worldRequestSchema.safeParse({ ...brief, props: Array.from({ length: 25 }, () => brief.props[0]) }).error), /at most 24 props/)
  assert.equal(worldRequestSchema.safeParse({ ...brief, referenceStrength: 0.9 }).success, false)
  assert.equal(worldRequestSchema.safeParse({ ...brief, rig: true }).success, false, 'unknown fields are rejected')

  assert.equal(boxSchema.safeParse({ x: 0.5, y: 0.5, w: 0.5, h: 0.5 }).success, true)
  assert.equal(boxSchema.safeParse({ x: 0.8, y: 0.5, w: 0.5, h: 0.2 }).success, false)
  assert.equal(itemEditsSchema.safeParse([{ id: 'a', name: 'Crate', description: '', quantity: 1, boxes: [], approved: true }]).success, true)
  assert.equal(itemEditsSchema.safeParse([{ id: 'a', name: '', description: '', quantity: 1, boxes: [], approved: true }]).success, false)
  assert.equal(layoutSchema.safeParse([{ itemId: crypto.randomUUID(), transforms: [{ position: [1, 0, 2], rotationY: 0.5, scale: 1 }] }]).success, true)
  assert.equal(layoutSchema.safeParse([{ itemId: '../world.json', transforms: [] }]).success, false)
  assert.equal(layoutSchema.safeParse([{ itemId: crypto.randomUUID(), transforms: [{ position: [Infinity, 0, 0], rotationY: 0, scale: 1 }] }]).success, false)

  const config = worldConfigSchema.parse({ imageProfile: 'sd15', checkpoint: '', meshProfile: 'mini', meshCheckpoint: '' })
  assert.equal(config.editModel, editProfile.model)
  assert.equal(worldConfigSchema.safeParse({ ...config, meshProfile: 'rigged' }).success, false)
})

test('local vision detections accept 0..1 and 0..1000 boxes and drop degenerate ones', () => {
  const detections = parseDetections({ objects: [
    { name: ' Barrel ', box: [0.1, 0.2, 0.3, 0.6] },
    { name: 'Crate', box: [500, 500, 750, 1000] },
    { name: 'Speck', box: [0.5, 0.5, 0.501, 0.6] },
    { name: '', box: [0.1, 0.1, 0.5, 0.5] }
  ] })
  assert.equal(detections.length, 2)
  assert.equal(detections[0].name, 'Barrel')
  assert.ok(Math.abs(detections[0].box.w - 0.2) < 1e-9 && Math.abs(detections[0].box.h - 0.4) < 1e-9)
  assert.deepEqual(detections[1], { name: 'Crate', box: { x: 0.5, y: 0.5, w: 0.25, h: 0.5 } })
  assert.throws(() => parseDetections({ objects: [{ name: 'x', box: [1, 2] }] }))
})

test('cutouts must be transparent, complete and centred', () => {
  const size = 64
  const bitmap = (fill: (x: number, y: number) => number) => {
    const data = new Uint8Array(size * size * 4)
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) data[(y * size + x) * 4 + 3] = fill(x, y)
    return data
  }
  assert.doesNotThrow(() => validateCutout(bitmap((x, y) => x > 16 && x < 48 && y > 16 && y < 48 ? 255 : 0), size, size))
  assert.throws(() => validateCutout(bitmap(() => 255), size, size), /border/)
  assert.throws(() => validateCutout(bitmap(() => 0), size, size), /usable transparent cutout/)
  assert.throws(() => validateCutout(bitmap((x, y) => x > 2 && x < 61 && y > 2 && y < 61 ? 255 : 0), size, size), /usable transparent cutout/)
  assert.throws(() => validateCutout(new Uint8Array(32 * 32 * 4), 32, 32), /too small/)
})

test('GLB validation accepts embedded static geometry and rejects incomplete files', () => {
  const glb = triangleGlb()
  assert.equal(validateGlbBytes(glb), false, 'an untextured mesh is valid geometry but not textured')
  assert.throws(() => validateGlbBytes(glb, 1024), /without base-color textures/)
  assert.throws(() => validateGlbBytes(glb.subarray(0, glb.length - 4)), /complete binary glTF/)
  assert.throws(() => validateGlbBytes(Buffer.from('not a model')), /complete binary glTF/)
  assert.throws(() => validateGlbBytes(triangleGlb({ buffers: [{ byteLength: 36, uri: 'mesh.bin' }] })), /external resources/)
  assert.throws(() => validateGlbBytes(triangleGlb({ nodes: [{}] })), /no mesh geometry/)
  assert.throws(() => validateGlbBytes(triangleGlb({ accessors: [{ bufferView: 0, componentType: 5126, count: 30, type: 'VEC3' }] })), /incomplete vertex geometry/)
})

test('model downloads are only offered for missing or unsupported weights', () => {
  const config: WorldConfig = { imageProfile: 'sd15', checkpoint: 'custom.safetensors', meshProfile: 'mini', meshCheckpoint: '', visionModel: '',
    backgroundModel: 'my-birefnet.safetensors', editModel: 'flux-2-klein-4b.safetensors', editTextEncoder: editProfile.textEncoder, editVae: 'other-vae.safetensors' }
  const ready: WorldReadiness = { devices: [], checkpoints: ['custom.safetensors'], visionModels: [], clipVision: [],
    backgroundModels: ['my-birefnet.safetensors'], diffusionModels: ['flux-2-klein-4b.safetensors'], textEncoders: [editProfile.textEncoder], vaes: ['other-vae.safetensors'] }
  const [editModel, textEncoder, vae, background] = modelPackages.edit.models
  assert.equal(needsWorldModel(modelPackages.sd15.models[0], config, ready), false, 'user checkpoints stay supported')
  assert.equal(needsWorldModel(background, config, ready), false)
  assert.equal(needsWorldModel(editModel, config, ready), false, 'full-precision klein is accepted')
  assert.equal(needsWorldModel(textEncoder, config, ready), false)
  assert.equal(needsWorldModel(vae, config, ready), true, 'an unrelated VAE is not the FLUX.2 VAE')
  assert.equal(needsWorldModel(editModel, { ...config, editModel: 'flux1-dev.safetensors' }, { ...ready, diffusionModels: ['flux1-dev.safetensors'] }), true)
  assert.equal(needsWorldModel(modelPackages.hunyuan.models[0], config, ready), true, 'nothing selected')
  for (const pkg of Object.values(modelPackages)) for (const model of pkg.models) {
    assert.match(model.url, /^https:\/\/huggingface\.co\/[^/]+\/[^/]+\/resolve\/[0-9a-f]{40}\//)
    assert.match(model.sha256, /^[0-9a-f]{64}$/)
  }
})
