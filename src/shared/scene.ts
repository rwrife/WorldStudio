import type { Box, ItemPhase, ItemStatus, PropSpec, Transform, WorldItem, WorldRequest } from './world'
import { limits } from './world'

/** Scene footprint in metres; generated meshes are normalized to unit size before transforms apply. */
export const sceneSize = 10
const horizon = 0.2

export function clampBox(box: Box): Box {
  const x = Math.min(Math.max(box.x, 0), 0.98), y = Math.min(Math.max(box.y, 0), 0.98)
  return { x, y, w: Math.min(Math.max(box.w, 0.02), 1 - x), h: Math.min(Math.max(box.h, 0.02), 1 - y) }
}

/** Square, padded pixel crop around a normalized box, clamped to the image. */
export function cropRect(box: Box, width: number, height: number, padding = 0.18) {
  const b = clampBox(box)
  const cx = (b.x + b.w / 2) * width, cy = (b.y + b.h / 2) * height
  let side = Math.max(b.w * width, b.h * height) * (1 + padding * 2)
  side = Math.round(Math.min(Math.max(side, 64), width, height))
  const x = Math.round(Math.min(Math.max(cx - side / 2, 0), width - side))
  const y = Math.round(Math.min(Math.max(cy - side / 2, 0), height - side))
  return { x, y, width: side, height: side }
}

const round = (value: number) => Math.round(value * 1000) / 1000

/** Approximate ground placement from a concept-image box: lower in frame is nearer the camera. */
export function placeBox(box: Box): Transform {
  const b = clampBox(box)
  const bottom = Math.min(Math.max(b.y + b.h, horizon), 1)
  const near = (bottom - horizon) / (1 - horizon)
  const depth = 0.55 + 0.45 * near
  const x = (b.x + b.w / 2 - 0.5) * sceneSize * 0.9 / depth
  const z = (near - 0.5) * sceneSize * 0.85
  const scale = Math.min(Math.max(Math.max(b.h, b.w * 0.8) / depth * sceneSize * 0.6, 0.25), sceneSize * 0.6)
  return { position: [round(x), 0, round(z)], rotationY: 0, scale: round(scale) }
}

export function environmentTransform(): Transform {
  return { position: [0, 0, 0], rotationY: 0, scale: sceneSize }
}

/** One transform per instance: detected boxes first, then remaining quantity scattered around the last one. */
export function placeItem(item: Pick<WorldItem, 'kind' | 'boxes' | 'quantity'>, index = 0): Transform[] {
  if (item.kind === 'environment') return [environmentTransform()]
  const placed = item.boxes.slice(0, item.quantity).map(placeBox)
  const anchor: Transform = placed.at(-1) ?? {
    position: [round(((index % 5) - 2) * sceneSize * 0.16), 0, round((Math.floor(index / 5) % 3 - 1) * sceneSize * 0.2)],
    rotationY: 0, scale: 1
  }
  for (let i = placed.length; i < item.quantity; i++) {
    const angle = (i * 2.399963) % (Math.PI * 2), distance = anchor.scale * (1.1 + 0.25 * i)
    placed.push({ ...anchor, position: [round(anchor.position[0] + Math.cos(angle) * distance), 0, round(anchor.position[2] + Math.sin(angle) * distance)], rotationY: round(angle) })
  }
  return placed
}

export function itemKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').map(word =>
    word.length <= 3 ? word : word.endsWith('ies') ? word.slice(0, -3) + 'y' : /(?:x|ch|sh|ss)es$/.test(word) ? word.slice(0, -2) :
      word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word).join(' ')
}
const sameThing = (a: string, b: string) => {
  const x = itemKey(a), y = itemKey(b)
  return !!x && !!y && (x === y || ` ${x} `.includes(` ${y} `) || ` ${y} `.includes(` ${x} `))
}

type NewItem = Pick<WorldItem, 'kind' | 'name' | 'description' | 'quantity' | 'origin' | 'boxes'>
export function blankItem(id: string, value: NewItem): WorldItem {
  return { id, approved: true, referenceStatus: 'pending', modelStatus: 'pending', transforms: [], ...value }
}

export function initialItems(request: Pick<WorldRequest, 'title' | 'location' | 'props'>, id: () => string): WorldItem[] {
  const environment = blankItem(id(), { kind: 'environment', name: request.title || 'Environment', description: request.location.slice(0, 500), quantity: 1, origin: 'environment', boxes: [] })
  return [environment, ...mergeProps([], request.props).map(prop => blankItem(id(), { kind: 'prop', ...prop, origin: 'listed', boxes: [] }))]
}

/** Combine duplicate prop rows by name, keeping the first description and summing quantity. */
export function mergeProps(existing: PropSpec[], props: PropSpec[]): PropSpec[] {
  const result = existing.map(prop => ({ ...prop }))
  for (const prop of props) {
    const name = prop.name.trim()
    if (!name) continue
    const match = result.find(p => itemKey(p.name) === itemKey(name))
    if (match) match.quantity = Math.min(match.quantity + prop.quantity, limits.quantity)
    else result.push({ name, description: prop.description.trim(), quantity: Math.min(Math.max(Math.round(prop.quantity), 1), limits.quantity) })
  }
  return result
}

export interface Detection { name: string; box: Box }
/**
 * Assign local-vision detections to listed props that have no boxes yet. User-drawn boxes are never replaced.
 * Unmatched detections become new approved props so the user can review or reject them.
 */
export function mergeDetections(items: WorldItem[], detections: Detection[], id: () => string): WorldItem[] {
  const result = items.map(item => ({ ...item, boxes: [...item.boxes] }))
  const fillable = new Set(result.filter(item => item.kind === 'prop' && !item.boxes.length).map(item => item.id))
  for (const detection of detections) {
    const box = clampBox(detection.box), name = detection.name.trim().slice(0, 80)
    if (!name) continue
    const match = result.find(item => item.kind === 'prop' && sameThing(item.name, name))
    if (match) {
      if (fillable.has(match.id) && match.boxes.length < Math.min(match.quantity, limits.boxes)) match.boxes.push(box)
      continue
    }
    if (result.filter(item => item.kind === 'prop').length >= limits.props) continue
    const item = blankItem(id(), { kind: 'prop', name, description: '', quantity: 1, origin: 'detected', boxes: [box] })
    result.push(item); fillable.add(item.id)
  }
  for (const item of result) if (item.origin === 'detected') item.quantity = Math.max(item.quantity, item.boxes.length)
  return result
}

const statusKey = (phase: ItemPhase) => phase === 'reference' ? 'referenceStatus' : 'modelStatus'

export function eligible(item: WorldItem, phase: ItemPhase): boolean {
  return item.approved && (phase === 'reference' || item.referenceStatus === 'complete')
}

/** Ordered batch: environment first, then props. Failed or cancelled items re-enter only on retry. */
export function batchQueue(items: WorldItem[], phase: ItemPhase, retry = false): WorldItem[] {
  const allowed: ItemStatus[] = retry ? ['pending', 'failed', 'cancelled'] : ['pending']
  return items.filter(item => eligible(item, phase) && allowed.includes(item[statusKey(phase)]))
    .sort((a, b) => Number(b.kind === 'environment') - Number(a.kind === 'environment'))
}

export function batchSummary(items: WorldItem[], phase: ItemPhase) {
  const counts: Record<ItemStatus, number> = { pending: 0, running: 0, complete: 0, failed: 0, skipped: 0, cancelled: 0 }
  const scoped = items.filter(item => eligible(item, phase))
  for (const item of scoped) counts[item[statusKey(phase)]]++
  return { total: scoped.length, ...counts, done: counts.complete + counts.skipped }
}

/** Retry or skip one item. Completed results are only replaced by explicit retry; running items cannot change. */
export function setPhaseStatus(item: WorldItem, phase: ItemPhase, action: 'retry' | 'skip'): WorldItem {
  const key = statusKey(phase), status = item[key]
  if (status === 'running') throw new Error('This item is currently generating. Cancel the batch first.')
  if (action === 'skip') return { ...item, [key]: 'skipped', [`${phase}Message`]: 'Skipped by user.' }
  const next: WorldItem = { ...item, [key]: 'pending', [`${phase}Message`]: undefined }
  if (phase === 'reference') Object.assign(next, { referenceUrl: undefined, referenceSource: undefined, modelStatus: 'pending', modelUrl: undefined, modelMessage: undefined, modelTextured: undefined, modelSource: undefined })
  else Object.assign(next, { modelUrl: undefined, modelTextured: undefined, modelSource: undefined })
  return next
}

export function sceneReady(items: WorldItem[]): boolean {
  return items.some(item => item.approved && item.modelStatus === 'complete' && !!item.modelUrl)
}

export function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'item'
}
