export type ImageProfile = 'sd15' | 'sdxl'
export type MeshProfile = 'mini' | 'standard' | 'textured'
/** UI stages. Only concept, references and models submit ComfyUI work. */
export type WorldStage = 'brief' | 'concept' | 'extract' | 'batch' | 'scene'
export type WorldJob = 'concept' | 'detect' | 'references' | 'models'
export type ItemPhase = 'reference' | 'model'
export type ItemStatus = 'pending' | 'running' | 'complete' | 'failed' | 'skipped' | 'cancelled'

export interface WorldConfig {
  imageProfile: ImageProfile
  checkpoint: string
  meshProfile: MeshProfile
  meshCheckpoint: string
  visionModel: string
  backgroundModel?: string
  editModel?: string
  editTextEncoder?: string
  editVae?: string
  meshTextureModel?: string
  meshVision?: string
  meshShapeVae?: string
  meshTextureVae?: string
}
export interface PropSpec { name: string; description: string; quantity: number }
export interface WorldRequest {
  title: string
  location: string
  style: string
  props: PropSpec[]
  referenceId?: string
  seed: number
  steps: number
  referenceStrength: number
}
/** Normalized image-space rectangle: 0..1, origin top-left. */
export interface Box { x: number; y: number; w: number; h: number }
export interface Transform { position: [number, number, number]; rotationY: number; scale: number }
export interface WorldItem {
  id: string
  kind: 'environment' | 'prop'
  name: string
  description: string
  quantity: number
  /** Where the prop came from: the brief, a local vision detection, or added by hand during extraction. */
  origin: 'environment' | 'listed' | 'detected' | 'manual'
  /** Concept-image boxes; the first is used for the isolated reference crop. Empty means text-generated. */
  boxes: Box[]
  approved: boolean
  referenceStatus: ItemStatus
  referenceMessage?: string
  referenceUrl?: string
  referenceSource?: 'crop' | 'text' | 'imported'
  modelStatus: ItemStatus
  modelMessage?: string
  modelUrl?: string
  modelTextured?: boolean
  modelSource?: 'generated' | 'imported'
  /** One transform per placed instance in the assembled scene. */
  transforms: Transform[]
}
export interface WorldReference { id: string; name: string; url: string }
export interface World {
  id: string
  createdAt: string
  title: string
  request: WorldRequest
  config: WorldConfig
  status: 'idle' | 'running' | 'failed' | 'cancelled'
  job?: WorldJob
  activeItemId?: string
  message: string
  promptId?: string
  conceptUrl?: string
  conceptSource?: 'generated' | 'imported'
  detected?: boolean
  items: WorldItem[]
  recovery?: import('./world-models').ModelRecovery
}
export interface WorldSnapshot {
  config: WorldConfig
  references: WorldReference[]
  worlds: World[]
  modelDownload?: import('./world-models').ModelDownload
}
export interface WorldReadiness {
  devices: { name: string; totalGB: number; freeGB: number }[]
  checkpoints: string[]
  visionModels: string[]
  visionError?: string
  clipVision: string[]
  backgroundModels: string[]
  diffusionModels: string[]
  textEncoders: string[]
  vaes: string[]
}
export type ItemEdit = Pick<WorldItem, 'id' | 'name' | 'description' | 'quantity' | 'boxes' | 'approved'> & { kind?: WorldItem['kind'] }

// Conservative working budgets, not guaranteed minima. Runtime availability is checked per job.
export const imageProfiles = {
  sd15: { label: 'SD 1.5 / DreamShaper', gb: 4, size: 512 },
  sdxl: { label: 'SDXL', gb: 8, size: 1024 }
}
export const meshProfiles = {
  mini: { label: 'Hunyuan3D 2mini (geometry)', gb: 6, resolution: 128 },
  standard: { label: 'Hunyuan3D 2 (geometry)', gb: 10, resolution: 256 },
  textured: { label: 'TRELLIS.2 (textured)', gb: 24, resolution: 512 }
}
export const meshTextureProfile = {
  model: 'trellis_2_int8_convrot.safetensors', vision: 'dino_v3_L_naf_fp32.safetensors',
  shapeVae: 'trellis_2_shape_vae_bf16.safetensors', textureVae: 'trellis_2_texture_vae_bf16.safetensors',
  textureSize: 1024, faceCount: 50000
}
export const editProfile = {
  label: 'FLUX.2 klein 4B (image edit)', gb: 14, steps: 4,
  model: 'flux-2-klein-4b-fp8.safetensors', textEncoder: 'qwen_3_4b.safetensors', vae: 'flux2-vae.safetensors'
}
export const limits = { props: 24, quantity: 50, boxes: 16 }

const clean = (value: string) => value.replace(/\s+/g, ' ').trim()
const named = (item: Pick<WorldItem, 'name' | 'description'>) =>
  clean(item.description ? `${item.name} (${item.description})` : item.name)

export function conceptPrompt(request: WorldRequest): string {
  const props = request.props.filter(p => p.name.trim()).map(p => p.quantity > 1 ? `${p.quantity} ${named(p)}` : named(p))
  return clean(`Location: ${request.location}. ${props.length ? `Clearly visible props, separated with space around each: ${props.join(', ')}. ` : ''}` +
    `Art style: ${request.style}. Wide establishing shot of the environment, elevated three-quarter view, even lighting, ` +
    'every prop fully in frame and not overlapping, no characters, no text or lettering.')
}
export const conceptNegative = 'people, characters, crowd, cropped objects, overlapping objects, heavy fog, motion blur, watermark, lettering, text'

/** Edit-only instruction for the crop of a visible prop. The world brief is intentionally excluded. */
export function propIsolatePrompt(item: Pick<WorldItem, 'name' | 'description'>): string {
  return clean(`Isolate the ${named(item)} from this image, show the entire object, remove the background, only show this single object. ` +
    'Center it with a clear margin on every side, three-quarter front view, complete and unoccluded. ' +
    'Preserve the same shape, materials, colors and art style. Do not add other objects, people, ground or scenery.')
}
/** Text-to-image prompt for a listed prop that is not visible in the concept. */
export function propTextPrompt(item: Pick<WorldItem, 'name' | 'description'>, request: Pick<WorldRequest, 'location' | 'style'>): string {
  return clean(`A single ${named(item)}, a static prop belonging in ${request.location}. Art style: ${request.style}. ` +
    'Entire object centered with a clear margin, three-quarter front view, plain flat white background, game asset concept, no ground, no shadow, no text.')
}
/** Edit-only instruction that removes the props and isolates the location shell as a diorama base. */
export function environmentPrompt(props: Pick<WorldItem, 'name'>[]): string {
  const names = [...new Set(props.map(p => clean(p.name)).filter(Boolean))]
  return clean(`${names.length ? `Remove these objects: ${names.join(', ')}. ` : ''}Show only the empty location as one isolated diorama piece: ` +
    'the ground, terrain, floor, walls and fixed architecture, entire base visible with a clear margin, slightly elevated three-quarter view, remove the background. ' +
    'Keep the same art style, colors, materials and layout. Do not add props, people or text.')
}

export function itemLabel(item: Pick<WorldItem, 'kind' | 'name'>): string {
  return item.kind === 'environment' ? `${item.name} (environment)` : item.name
}
