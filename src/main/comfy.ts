import { randomUUID } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, relative, sep } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import type { WorldReadiness } from '../shared/world'
import { errorText, localUrl } from './validation'
import type { Workflow } from './workflows'

export type NodeInfo = { input: { required?: Record<string, unknown[]> }; api_node?: boolean }
export type NodeCatalog = Record<string, NodeInfo>
interface History {
  status: { completed: boolean; status_str: string; messages: [string, Record<string, unknown>][] }
  outputs: Record<string, Record<string, unknown>>
}
const fileResultSchema = z.object({ filename: z.string().min(1), subfolder: z.string(), type: z.literal('output') })
export type FileResult = z.infer<typeof fileResultSchema>

export async function api<T>(base: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const timeout = AbortSignal.timeout(15_000)
  const response = await fetch(localUrl(base) + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    redirect: 'error'
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`ComfyUI ${path}: HTTP ${response.status}. ${text.slice(0, 1500)}`)
  return (text ? JSON.parse(text) : {}) as T
}

export async function cancelPrompt(base: string, promptId: string): Promise<void> {
  // Do not use the global /interrupt endpoint: other local ComfyUI users may have jobs.
  await api(base, `/api/jobs/${promptId}/cancel`, {})
}

export function checkBudget(readiness: Pick<WorldReadiness, 'devices'>, gb: number) {
  if (!readiness.devices.some(device => device.freeGB >= gb))
    throw new Error(`This job needs an estimated ${gb} GB of currently available GPU memory. Choose a smaller profile or free GPU memory; CPU-only image/3D generation is not supported.`)
}

export async function outputPath(root: string, value: unknown, extension: string): Promise<string> {
  const result = fileResultSchema.parse(value)
  if (basename(result.filename) !== result.filename || /[\\/:]/.test(result.filename) ||
      extname(result.filename).toLowerCase() !== extension || isAbsolute(result.subfolder) || result.subfolder.includes(':'))
    throw new Error('ComfyUI returned an invalid output path.')
  const base = await realpath(root)
  const file = await realpath(join(base, result.subfolder, result.filename))
  const rel = relative(base, file)
  if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel))
    throw new Error('ComfyUI output is outside the configured local output folder.')
  const size = (await stat(file)).size
  if (!size || size > 500 * 1024 * 1024) throw new Error('ComfyUI output is empty or exceeds 500 MB.')
  return file
}

export async function runWorkflow(base: string, workflow: Workflow, node: string, field: 'images' | '3d',
  signal: AbortSignal, submitted: (id: string) => void, update: (message: string) => void): Promise<FileResult> {
  const id = randomUUID()
  submitted(id)
  const response = await api<{ prompt_id: string }>(base, '/prompt', { prompt: workflow, prompt_id: id, client_id: randomUUID() }, signal)
  if (response.prompt_id !== id) throw new Error('ComfyUI must preserve the submitted prompt ID. Update ComfyUI before retrying.')
  const deadline = Date.now() + 60 * 60 * 1000
  update('Queued in local ComfyUI. Loading local weights and generating; first load can take several minutes.')
  while (Date.now() < deadline) {
    signal.throwIfAborted()
    const history = await api<Record<string, History>>(base, `/history/${id}`, undefined, signal)
    const item = history[id]
    if (item?.status.status_str === 'error') {
      const error = item.status.messages.find(([type]) => ['execution_error', 'execution_interrupted'].includes(type))
      throw new Error(error ? `${error[1].node_type ?? 'ComfyUI'}: ${error[1].exception_message ?? 'Generation interrupted'}` : 'Local generation failed. Inspect the ComfyUI log.')
    }
    if (item?.status.completed) {
      const outputs = item.outputs[node]?.[field]
      if (!Array.isArray(outputs) || outputs.length !== 1) throw new Error(`ComfyUI completed without exactly one required ${field} output.`)
      return fileResultSchema.parse(outputs[0])
    }
    await delay(1500, undefined, { signal })
  }
  throw new Error('Generation exceeded one hour. Inspect ComfyUI before retrying.')
}

export async function upload(file: string, base: string, signal: AbortSignal): Promise<string> {
  const id = randomUUID()
  const form = new FormData()
  form.append('image', new Blob([new Uint8Array(await readFile(file))], { type: 'image/png' }), `${id}.png`)
  form.append('overwrite', 'false')
  const response = await fetch(localUrl(base) + '/upload/image', { method: 'POST', body: form, redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) })
  if (!response.ok) throw new Error(`Local ComfyUI image import failed: HTTP ${response.status}.`)
  const result = z.object({ name: z.string(), subfolder: z.string(), type: z.literal('input') }).parse(await response.json())
  if (result.name !== `${id}.png` || result.subfolder) throw new Error('ComfyUI returned an unexpected input image location.')
  return result.name
}

export async function requireNativeNodes(base: string, workflow: Workflow, signal?: AbortSignal) {
  const nodes = await api<NodeCatalog>(base, '/object_info', undefined, signal)
  for (const node of Object.values(workflow)) {
    if (!nodes[node.class_type] || nodes[node.class_type].api_node)
      throw new Error(`Required native offline node unavailable: ${node.class_type}. No cloud/API nodes are used.`)
  }
}

/** Ollama is restricted to the loopback default port. Remote/cloud models are rejected before use. */
export const ollamaBase = 'http://127.0.0.1:11434'
export async function ollama(path: string, body?: unknown, signal?: AbortSignal, base = ollamaBase): Promise<unknown> {
  const response = await fetch(localUrl(base) + path, {
    method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined, redirect: 'error',
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(300_000)]) : AbortSignal.timeout(3000)
  })
  if (!response.ok) throw new Error(`Local Ollama ${path}: HTTP ${response.status}.`)
  return response.json()
}

export async function readiness(comfyUrl: string, ollamaUrl = ollamaBase): Promise<WorldReadiness> {
  const [stats, nodes] = await Promise.all([
    api<{ devices: { name: string; type: string; vram_total: number; vram_free: number }[] }>(comfyUrl, '/system_stats'),
    api<NodeCatalog>(comfyUrl, '/object_info')
  ])
  const choices = (node: string, field: string) => {
    const spec = nodes[node]?.input.required?.[field]
    const combo = spec?.[1]
    const options = Array.isArray(spec?.[0]) ? spec[0] : combo && typeof combo === 'object' && 'options' in combo ? combo.options : undefined
    return Array.isArray(options) ? options.filter((name): name is string => typeof name === 'string') : []
  }
  let visionModels: string[] = [], visionError: string | undefined
  try {
    const tags = z.object({ models: z.array(z.object({ name: z.string() })) }).parse(await ollama('/api/tags', undefined, undefined, ollamaUrl))
    visionModels = tags.models.map(model => model.name).filter(name => !/cloud/i.test(name))
  } catch (error) { visionError = `Local prop detection unavailable: ${errorText(error)}. Draw prop boxes by hand, or start Ollama with an installed vision model.` }
  return {
    devices: stats.devices.filter(d => d.type !== 'cpu').map(d => ({ name: d.name, totalGB: d.vram_total / 2 ** 30, freeGB: d.vram_free / 2 ** 30 })),
    checkpoints: choices('CheckpointLoaderSimple', 'ckpt_name'), visionModels, visionError,
    clipVision: choices('CLIPVisionLoader', 'clip_name'), backgroundModels: choices('LoadBackgroundRemovalModel', 'bg_removal_name'),
    diffusionModels: choices('UNETLoader', 'unet_name'), textEncoders: choices('CLIPLoader', 'clip_name'), vaes: choices('VAELoader', 'vae_name')
  }
}
