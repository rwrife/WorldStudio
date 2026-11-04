import type { WorldConfig, WorldReadiness } from './world'

export interface WorldModel {
  key: keyof Pick<WorldConfig, 'checkpoint' | 'backgroundModel' | 'editModel' | 'editTextEncoder' | 'editVae' |
    'meshCheckpoint' | 'meshTextureModel' | 'meshVision' | 'meshShapeVae' | 'meshTextureVae'>
  choices: keyof Pick<WorldReadiness, 'checkpoints' | 'backgroundModels' | 'diffusionModels' | 'textEncoders' | 'vaes' | 'clipVision'>
  file: string
  folder: string
  url: string
  bytes: number
  sha256: string
  license: string
  page: string
}

function model(key: WorldModel['key'], choices: WorldModel['choices'], folder: string,
  repo: string, revision: string, path: string, bytes: number, sha256: string, license: string): WorldModel {
  return { key, choices, folder, file: path.split('/').at(-1)!, bytes, sha256, license,
    url: `https://huggingface.co/${repo}/resolve/${revision}/${path}`, page: `https://huggingface.co/${repo}` }
}

const background = model('backgroundModel', 'backgroundModels', 'background_removal',
  'Comfy-Org/BiRefNet', '884af709e9b795d89dafbf97f29c8d6a2386f5c6', 'background_removal/birefnet.safetensors',
  444473596, '9ab37426bf4de0567af6b5d21b16151357149139362e6e8992021b8ce356a154', 'MIT')
const edit = [
  model('editModel', 'diffusionModels', 'diffusion_models',
    'black-forest-labs/FLUX.2-klein-4b-fp8', '5b4408e59397a4a37ccb46afe426d8ed86379441', 'flux-2-klein-4b-fp8.safetensors',
    4070624520, '97ed34fe0567e436200f2faee3939b88f2b5d99f8af2a4dc16532c4245c0ccb6', 'Apache-2.0'),
  model('editTextEncoder', 'textEncoders', 'text_encoders',
    'Comfy-Org/z_image_turbo', '6fc90a3b1b653e935a0d175e260736de25b84df5', 'split_files/text_encoders/qwen_3_4b.safetensors',
    8044982048, '6c671498573ac2f7a5501502ccce8d2b08ea6ca2f661c458e708f36b36edfc5a', 'Apache-2.0'),
  model('editVae', 'vaes', 'vae',
    'Comfy-Org/flux2-dev', '9630c1b4b6e690497ae0c19bb6b1b35d4ebedcb7', 'split_files/vae/flux2-vae.safetensors',
    336213556, 'd64f3a68e1cc4f9f4e29b6e0da38a0204fe9a49f2d4053f0ec1fa1ca02f9c4b5', 'Apache-2.0 (autoencoder only)'),
  background
]

// Pinned public safetensors only. Renderer callers choose a package ID, never a URL or path.
export const modelPackages = {
  background: { label: 'BiRefNet background removal', models: [background] },
  edit: { label: 'Prop isolation and environment editing', models: edit },
  sd15: { label: 'SD 1.5 / DreamShaper 8', models: [
    model('checkpoint', 'checkpoints', 'checkpoints',
      'Lykon/DreamShaper', '228d79cb20811466f5c5710aa91f05dabd0b8a14', 'DreamShaper_8_pruned.safetensors',
      2132625894, '879db523c30d3b9017143d56705015e15a2cb5628762c11d086fed9538abd7fd', 'CreativeML Open RAIL-M; review model card')
  ] },
  sdxl: { label: 'SDXL base 1.0', models: [
    model('checkpoint', 'checkpoints', 'checkpoints',
      'stabilityai/stable-diffusion-xl-base-1.0', '462165984030d82259a11f4367a4eed129e94a7b', 'sd_xl_base_1.0.safetensors',
      6938078334, '31e35c80fc4829d14f90153f4c74cd59c90b779f6afe05a74cd6120b893f7e5b', 'CreativeML Open RAIL++-M')
  ] },
  hunyuan: { label: 'Hunyuan3D 2 geometry', models: [
    model('meshCheckpoint', 'checkpoints', 'checkpoints',
      'Comfy-Org/hunyuan3D_2.0_repackaged', '15c2937a842a1f8cb5cedc840790ef973b583e5f', 'split_files/hunyuan3d-dit-v2_fp16.safetensors',
      4928151562, '360bc281fc956d4acac0c3d36d5ec0ebf8cdddbf4b8892e894d12419388d479b', 'Tencent Hunyuan Community License')
  ] },
  textured: { label: 'TRELLIS.2 textured geometry', models: [
    model('meshTextureModel', 'diffusionModels', 'diffusion_models',
      'Comfy-Org/TRELLIS.2', '430a9d09b2416687018c8fe8edced2ad4858a439', 'diffusion_models/trellis_2_int8_convrot.safetensors',
      5253048192, 'd01952ad137213f6a868f86b6b877026276f84af5eec23069217475a0bad3a31', 'MIT'),
    model('meshVision', 'clipVision', 'clip_vision',
      'Comfy-Org/Pixal3D', 'f37641be376725d324c56626007cc477f1249a69', 'clip_vision/dino_v3_L_naf_fp32.safetensors',
      1215214176, '4ad2ec4e0879a5b5b04cd97325cc37da954a7b6edca5170b86510f17f2b2290f', 'Review DINOv3 and upstream third-party terms'),
    model('meshShapeVae', 'vaes', 'vae',
      'Comfy-Org/TRELLIS.2', '430a9d09b2416687018c8fe8edced2ad4858a439', 'vae/trellis_2_shape_vae_bf16.safetensors',
      1095844024, 'de0cb4949a76c59ee5c091a995a69bcc8c51d5aeda939f0c641a50d2a72341f4', 'MIT'),
    model('meshTextureVae', 'vaes', 'vae',
      'Comfy-Org/TRELLIS.2', '430a9d09b2416687018c8fe8edced2ad4858a439', 'vae/trellis_2_texture_vae_bf16.safetensors',
      948461364, '714e5ebf094a610e12a8e3b5175c18a62f37f6ea4218acb6073644456b73ab0e', 'MIT')
  ] }
} satisfies Record<string, { label: string; models: WorldModel[] }>

export type ModelPackage = keyof typeof modelPackages
export interface ModelRecovery { package?: ModelPackage }
export interface ModelDownload {
  package: ModelPackage
  status: 'running' | 'complete' | 'failed' | 'cancelled'
  message: string
  receivedBytes: number
  totalBytes: number
}

export function needsWorldModel(model: WorldModel, config: WorldConfig, ready: WorldReadiness): boolean {
  const selected = config[model.key]
  if (!selected || !ready[model.choices].includes(selected)) return true
  const filename = selected.split(/[\\/]/).at(-1)
  if (model.key === 'editModel') return !/^flux-2-klein-4b(?:-fp8)?\.safetensors$/i.test(filename!)
  // User-selected concept checkpoints and background models remain supported.
  if (model.key === 'checkpoint' || model.key === 'backgroundModel' || model.key === 'meshCheckpoint') return false
  return filename !== model.file
}
