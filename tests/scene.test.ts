import test from 'node:test'
import assert from 'node:assert/strict'
import {
  batchQueue, batchSummary, blankItem, clampBox, cropRect, initialItems, itemKey, mergeDetections, mergeProps, placeBox, placeItem,
  sceneReady, sceneSize, setPhaseStatus, slug
} from '../src/shared/scene'
import { conceptPrompt, environmentPrompt, limits, propIsolatePrompt, propTextPrompt, type WorldItem, type WorldRequest } from '../src/shared/world'

let counter = 0
const id = () => `id-${++counter}`
const prop = (name: string, extra: Partial<WorldItem> = {}): WorldItem => ({ ...blankItem(id(), { kind: 'prop', name, description: '', quantity: 1, origin: 'listed', boxes: [] }), ...extra })
const request: WorldRequest = {
  title: 'Harbor', location: 'A fishing harbor market on a wooden pier', style: 'stylized low-poly, warm light',
  props: [{ name: 'Barrel', description: 'oak, iron bands', quantity: 3 }, { name: 'Lantern post', description: '', quantity: 1 }],
  seed: 1, steps: 20, referenceStrength: 0.3
}

test('boxes clamp into the image and crops are padded squares inside it', () => {
  assert.deepEqual(clampBox({ x: -0.2, y: 0.5, w: 2, h: 0.001 }), { x: 0, y: 0.5, w: 1, h: 0.02 })
  const crop = cropRect({ x: 0.9, y: 0.1, w: 0.2, h: 0.1 }, 1000, 800)
  assert.equal(crop.width, crop.height)
  assert.ok(crop.x >= 0 && crop.y >= 0 && crop.x + crop.width <= 1000 && crop.y + crop.height <= 800)
  assert.ok(crop.width > 0.1 * 1000, 'crop is padded beyond the box')
  assert.equal(cropRect({ x: 0.5, y: 0.5, w: 0.01, h: 0.01 }, 1000, 1000).width, 64, 'tiny boxes still give a usable crop')
})

test('placement maps lower boxes nearer the camera and centres horizontally', () => {
  const far = placeBox({ x: 0.45, y: 0.25, w: 0.1, h: 0.1 }), near = placeBox({ x: 0.45, y: 0.8, w: 0.1, h: 0.1 })
  assert.ok(near.position[2] > far.position[2])
  assert.equal(far.position[0], 0)
  assert.equal(far.position[1], 0)
  assert.ok(placeBox({ x: 0.8, y: 0.5, w: 0.1, h: 0.1 }).position[0] > 0)
  assert.deepEqual(placeItem({ kind: 'environment', boxes: [], quantity: 1 }), [{ position: [0, 0, 0], rotationY: 0, scale: sceneSize }])
  const box = { x: 0.2, y: 0.5, w: 0.1, h: 0.2 }
  const placed = placeItem({ kind: 'prop', boxes: [box], quantity: 3 })
  assert.equal(placed.length, 3)
  assert.deepEqual(placed[0], placeBox(box))
  assert.notDeepEqual(placed[1].position, placed[0].position, 'extra instances are scattered')
  assert.equal(placeItem({ kind: 'prop', boxes: [box, box, box], quantity: 2 }).length, 2, 'quantity caps instances')
  assert.equal(placeItem({ kind: 'prop', boxes: [], quantity: 1 }, 3).length, 1)
})

test('item keys compare singular and plural prop names', () => {
  assert.equal(itemKey('Wooden Barrels'), itemKey('wooden barrel'))
  assert.equal(itemKey('Boxes'), 'box')
  assert.equal(itemKey('Berries'), 'berry')
  assert.equal(itemKey('Glass'), 'glass')
})

test('prop lists merge duplicates and the environment comes first', () => {
  const merged = mergeProps([], [{ name: 'Barrel', description: 'oak', quantity: 2 }, { name: ' barrels ', description: 'pine', quantity: 49 }, { name: '', description: 'x', quantity: 1 }])
  assert.deepEqual(merged, [{ name: 'Barrel', description: 'oak', quantity: limits.quantity }])
  const items = initialItems(request, id)
  assert.equal(items[0].kind, 'environment')
  assert.equal(items[0].name, 'Harbor')
  assert.deepEqual(items.slice(1).map(i => [i.name, i.quantity, i.origin]), [['Barrel', 3, 'listed'], ['Lantern post', 1, 'listed']])
  assert.ok(items.every(i => i.approved && i.referenceStatus === 'pending' && i.modelStatus === 'pending'))
})

test('detections fill listed props, keep user boxes and add unknown props for review', () => {
  const drawn = { x: 0.1, y: 0.1, w: 0.1, h: 0.1 }
  const items = [prop('Barrel', { quantity: 2 }), prop('Lantern', { boxes: [drawn] })]
  const result = mergeDetections(items, [
    { name: 'barrels', box: { x: 0.2, y: 0.5, w: 0.1, h: 0.2 } },
    { name: 'Barrel', box: { x: 0.4, y: 0.5, w: 0.1, h: 0.2 } },
    { name: 'Barrel', box: { x: 0.6, y: 0.5, w: 0.1, h: 0.2 } },
    { name: 'Lantern', box: { x: 0.7, y: 0.1, w: 0.1, h: 0.3 } },
    { name: 'Fishing net', box: { x: 0.5, y: 0.6, w: 0.2, h: 0.2 } },
    { name: '  ', box: { x: 0.5, y: 0.6, w: 0.2, h: 0.2 } }
  ], id)
  assert.equal(result[0].boxes.length, 2, 'boxes are limited by quantity')
  assert.deepEqual(result[1].boxes, [drawn], 'user-drawn boxes are never replaced')
  assert.equal(result.length, 3)
  assert.equal(result[2].name, 'Fishing net')
  assert.equal(result[2].origin, 'detected')
  assert.equal(items[0].boxes.length, 0, 'inputs are not mutated')
})

test('batch queues run the environment first and only retry failures on request', () => {
  const environment = blankItem(id(), { kind: 'environment', name: 'Base', description: '', quantity: 1, origin: 'environment', boxes: [] })
  const ok = prop('Barrel', { referenceStatus: 'complete' })
  const failed = prop('Crate', { referenceStatus: 'failed' })
  const rejected = prop('Cart', { approved: false })
  const items = [ok, failed, rejected, environment]
  assert.deepEqual(batchQueue(items, 'reference').map(i => i.name), ['Base'])
  assert.deepEqual(batchQueue(items, 'reference', true).map(i => i.name), ['Base', 'Crate'])
  assert.deepEqual(batchQueue(items, 'model').map(i => i.name), ['Barrel'], '3D needs a completed reference')
  const summary = batchSummary(items, 'reference')
  assert.equal(summary.total, 3)
  assert.equal(summary.complete, 1)
  assert.equal(summary.failed, 1)
  assert.equal(summary.pending, 1)
  assert.equal(summary.done, 1)
})

test('retry and skip reset the right fields and never touch running items', () => {
  const item = prop('Barrel', { referenceStatus: 'complete', referenceUrl: 'a', modelStatus: 'complete', modelUrl: 'b' })
  const retried = setPhaseStatus(item, 'reference', 'retry')
  assert.equal(retried.referenceStatus, 'pending')
  assert.equal(retried.referenceUrl, undefined)
  assert.equal(retried.modelStatus, 'pending')
  assert.equal(retried.modelUrl, undefined)
  const remodel = setPhaseStatus(item, 'model', 'retry')
  assert.equal(remodel.referenceUrl, 'a')
  assert.equal(remodel.modelUrl, undefined)
  assert.equal(setPhaseStatus(item, 'model', 'skip').modelStatus, 'skipped')
  assert.throws(() => setPhaseStatus({ ...item, modelStatus: 'running' }, 'model', 'skip'), /currently generating/)
  assert.equal(sceneReady([item]), true)
  assert.equal(sceneReady([{ ...item, approved: false }]), false)
  assert.equal(slug('  Harbor Market: Night!  '), 'harbor-market-night')
  assert.equal(slug('***'), 'item')
})

test('prompts keep the art style for concepts and edit-only wording for crops', () => {
  const concept = conceptPrompt(request)
  assert.match(concept, /3 Barrel \(oak, iron bands\)/)
  assert.match(concept, /Art style: stylized low-poly, warm light/)
  assert.match(concept, /no characters/)
  const isolate = propIsolatePrompt({ name: 'Barrel', description: 'oak' })
  assert.match(isolate, /^Isolate the Barrel \(oak\) from this image, show the entire object, remove the background/)
  assert.doesNotMatch(isolate, /harbor/i, 'the world brief is not resent for crops')
  assert.match(propTextPrompt({ name: 'Crate', description: '' }, request), /A single Crate, a static prop belonging in A fishing harbor.*Art style: stylized/)
  const environment = environmentPrompt([{ name: 'Barrel' }, { name: 'Barrel' }, { name: 'Lantern post' }])
  assert.match(environment, /^Remove these objects: Barrel, Lantern post\. Show only the empty location/)
  assert.doesNotMatch(environmentPrompt([]), /Remove these objects/)
})
