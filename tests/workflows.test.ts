import test from 'node:test'
import assert from 'node:assert/strict'
import { conceptWorkflow, editWorkflow, isolationWorkflow, meshWorkflow, propTextWorkflow, type Workflow } from '../src/main/workflows'
import { editProfile, meshTextureProfile, type WorldConfig, type WorldRequest } from '../src/shared/world'

const config: WorldConfig = {
  imageProfile: 'sd15', checkpoint: 'DreamShaper_8_pruned.safetensors', meshProfile: 'mini', meshCheckpoint: 'hunyuan3d-dit-v2-mini_fp16.safetensors',
  visionModel: '', backgroundModel: 'birefnet.safetensors', editModel: editProfile.model, editTextEncoder: editProfile.textEncoder, editVae: editProfile.vae,
  meshTextureModel: meshTextureProfile.model, meshVision: meshTextureProfile.vision, meshShapeVae: meshTextureProfile.shapeVae, meshTextureVae: meshTextureProfile.textureVae
}
const request: WorldRequest = { title: 'Forge', location: 'A dwarven forge hall', style: 'painterly', props: [{ name: 'Anvil', description: '', quantity: 2 }], seed: 42, steps: 24, referenceStrength: 0.4 }

/** Every node link must point at a node that exists, so ComfyUI never receives a dangling graph. */
function assertLinked(workflow: Workflow) {
  for (const [id, node] of Object.entries(workflow))
    for (const value of Object.values(node.inputs))
      if (Array.isArray(value) && typeof value[0] === 'string' && typeof value[1] === 'number')
        assert.ok(workflow[value[0]], `node ${id} (${node.class_type}) links to missing node ${value[0]}`)
}

test('concept workflow renders the brief in the art style, optionally from a reference image', () => {
  const plain = conceptWorkflow(config, request, 'world_concept')
  assertLinked(plain)
  assert.equal(plain['1'].inputs.ckpt_name, config.checkpoint)
  assert.match(String(plain['2'].inputs.text), /dwarven forge hall.*2 Anvil.*Art style: painterly/)
  assert.equal(plain['4'].class_type, 'EmptyLatentImage')
  assert.equal(plain['4'].inputs.width, 512)
  assert.equal(plain['5'].inputs.seed, 42)
  assert.equal(plain['5'].inputs.steps, 24)
  assert.equal(plain['7'].inputs.filename_prefix, 'world_concept')
  assert.equal(conceptWorkflow({ ...config, imageProfile: 'sdxl' }, request, 'x')['4'].inputs.width, 1024)

  const guided = conceptWorkflow(config, request, 'world_concept', 'reference.png')
  assertLinked(guided)
  assert.equal(guided['8'].inputs.image, 'reference.png')
  assert.equal(guided['4'].class_type, 'VAEEncode')
  assert.ok(Math.abs(Number(guided['5'].inputs.denoise) - 0.6) < 1e-9)
})

test('prop isolation uses FLUX.2 klein edit and BiRefNet so only a transparent cutout is saved', () => {
  const workflow = editWorkflow(config, 'Isolate the anvil', 7, 'item_ref', 'crop.png')
  assertLinked(workflow)
  assert.equal(workflow['1'].class_type, 'UNETLoader')
  assert.equal(workflow['1'].inputs.unet_name, editProfile.model)
  assert.equal(workflow['2'].inputs.type, 'flux2')
  assert.equal(workflow['4'].inputs.image, 'crop.png')
  assert.equal(workflow['8'].inputs.text, 'Isolate the anvil')
  assert.equal(workflow['10'].class_type, 'ReferenceLatent')
  assert.equal(workflow['14'].inputs.steps, editProfile.steps)
  assert.equal(workflow['21'].inputs.noise_seed, 7)
  assert.equal(workflow['16'].inputs.bg_removal_name, 'birefnet.safetensors')
  assert.deepEqual(workflow['17'].inputs.image, ['23', 0])
  assert.deepEqual(workflow['7'].inputs.images, ['19', 0], 'the saved image is the alpha cutout, not the raw edit')
  assert.throws(() => editWorkflow({ ...config, editModel: '' }, 'x', 1, 'p', 'crop.png'), /FLUX\.2 klein/)
  assert.throws(() => editWorkflow(config, 'x', 1, 'p', ''), /input image/)
  assert.throws(() => editWorkflow({ ...config, backgroundModel: '' }, 'x', 1, 'p', 'crop.png'), /background-removal/)
})

test('props missing from the concept are drawn from text and isolated in the same style', () => {
  const workflow = propTextWorkflow(config, 'A single anvil', { seed: 3, steps: 20 }, 'item_ref')
  assertLinked(workflow)
  assert.equal(workflow['2'].inputs.text, 'A single anvil')
  assert.deepEqual(workflow['17'].inputs.image, ['6', 0])
  assert.deepEqual(workflow['7'].inputs.images, ['19', 0])
  const imported = isolationWorkflow(config, 'item_ref', 'upload.png')
  assertLinked(imported)
  assert.deepEqual(imported['7'].inputs.images, ['19', 0])
})

test('mesh workflows save a GLB from node 9 for geometry and textured profiles', () => {
  const mini = meshWorkflow(config, { seed: 5, steps: 30 }, 'item_mesh', 'cutout.png')
  assertLinked(mini)
  assert.equal(mini['1'].inputs.ckpt_name, config.meshCheckpoint)
  assert.equal(mini['7'].inputs.octree_resolution, 128)
  assert.equal(mini['9'].class_type, 'SaveGLB')
  assert.equal(mini['9'].inputs.filename_prefix, 'item_mesh')
  assert.equal(meshWorkflow({ ...config, meshProfile: 'standard' }, { seed: 5, steps: 30 }, 'm', 'c.png')['7'].inputs.octree_resolution, 256)
  assert.ok(!Object.values(mini).some(node => /rig|skin|anim/i.test(node.class_type)), 'world models are static')

  const textured = meshWorkflow({ ...config, meshProfile: 'textured' }, { seed: 5, steps: 30 }, 'item_mesh', 'cutout.png')
  assertLinked(textured)
  assert.equal(textured['1'].inputs.unet_name, meshTextureProfile.model)
  assert.equal(textured['8'].class_type, 'Trellis2Conditioning')
  assert.equal(textured['9'].class_type, 'SaveGLB')
  assert.equal(textured['26'].inputs.texture_size, meshTextureProfile.textureSize)
})
