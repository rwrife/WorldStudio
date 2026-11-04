// End-to-end UI smoke for the built app (run `npm run build` first).
//
// By default this starts a FIXTURE ComfyUI on loopback that answers the real World Studio workflows with
// procedurally drawn PNGs and box/prism GLBs. It proves the UI, IPC, validation, persistence and export
// paths work; it does not run any model inference. Pass `--live` to use the ComfyUI configured in
// %APPDATA%\WorldStudio\settings.json instead (installed weights required; no fixture is started).
import { _electron as electron, expect } from '@playwright/test'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { crc32, deflateSync } from 'node:zlib'
import assert from 'node:assert/strict'

const live = process.argv.includes('--live')
const temp = await mkdtemp(join(tmpdir(), 'world-studio-smoke-'))
const data = join(temp, 'data'), comfyOutput = join(temp, 'comfy', 'output'), exportDir = join(temp, 'export')
const shots = resolve('docs', 'screenshots'), artifacts = resolve('artifacts', 'world-smoke')
await Promise.all([data, comfyOutput, exportDir, shots, artifacts].map(dir => mkdir(dir, { recursive: true })))

// ---------- procedural PNG fixtures ----------
function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4)
  const chunk = (type, body) => {
    const head = Buffer.alloc(8); head.writeUInt32BE(body.length, 0); head.write(type, 4, 'ascii')
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])))
    return Buffer.concat([head, body, crc])
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}
function canvas(size, fill) {
  const px = Buffer.alloc(size * size * 4)
  const set = (x, y, [r, g, b, a = 255]) => {
    x = Math.round(x); y = Math.round(y)
    if (x < 0 || y < 0 || x >= size || y >= size) return
    const i = (y * size + x) * 4, k = a / 255, under = px[i + 3] / 255 * (1 - k), out = k + under
    for (const [c, value] of [r, g, b].entries()) px[i + c] = Math.round((value * k + px[i + c] * under) / out)
    px[i + 3] = Math.round(out * 255)
  }
  const S = v => v * size
  const api = {
    px, size, set,
    rect(x, y, w, h, color) { for (let j = Math.floor(S(y)); j < S(y + h); j++) for (let i = Math.floor(S(x)); i < S(x + w); i++) set(i, j, typeof color === 'function' ? color(i / size, j / size) : color) },
    ellipse(cx, cy, rx, ry, color) {
      for (let j = Math.floor(S(cy - ry)); j <= S(cy + ry); j++) for (let i = Math.floor(S(cx - rx)); i <= S(cx + rx); i++) {
        const dx = (i / size - cx) / rx, dy = (j / size - cy) / ry
        if (dx * dx + dy * dy <= 1) set(i, j, typeof color === 'function' ? color(dx, dy) : color)
      }
    },
    poly(points, color) {
      const ys = points.map(p => p[1]), top = Math.floor(S(Math.min(...ys))), bottom = Math.ceil(S(Math.max(...ys)))
      for (let j = top; j <= bottom; j++) {
        const y = j / size, xs = []
        for (let k = 0; k < points.length; k++) {
          const [x1, y1] = points[k], [x2, y2] = points[(k + 1) % points.length]
          if ((y1 <= y && y < y2) || (y2 <= y && y < y1)) xs.push(x1 + (y - y1) / (y2 - y1) * (x2 - x1))
        }
        xs.sort((a, b) => a - b)
        for (let k = 0; k + 1 < xs.length; k += 2) for (let i = Math.floor(S(xs[k])); i < S(xs[k + 1]); i++) set(i, j, typeof color === 'function' ? color(i / size, y) : color)
      }
    },
    png() { return encodePng(size, size, px) }
  }
  if (fill) api.rect(0, 0, 1, 1, fill)
  return api
}
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t))
const shade = (c, f) => c.map(v => Math.max(0, Math.min(255, Math.round(v * f))))
const wood = [150, 96, 56], darkWood = [92, 56, 34], iron = [58, 54, 52], lantern = [255, 196, 92], crate = [196, 148, 86], net = [96, 140, 120]

function barrel(c, x, y, w, h) {
  c.rect(x, y, w, h, (u) => shade(wood, 0.75 + 0.45 * Math.sin(Math.PI * (u - x) / w)))
  c.ellipse(x + w / 2, y, w / 2, h * 0.08, shade(wood, 1.2))
  c.ellipse(x + w / 2, y, w / 2.6, h * 0.05, darkWood)
  for (const t of [0.18, 0.8]) c.rect(x, y + h * t, w, h * 0.06, iron)
}
function lanternPost(c, x, y, w, h) {
  c.rect(x + w * 0.42, y + h * 0.18, w * 0.16, h * 0.82, darkWood)
  c.rect(x + w * 0.1, y + h * 0.16, w * 0.8, h * 0.04, darkWood)
  c.ellipse(x + w * 0.5, y + h * 0.08, w * 0.5, h * 0.09, (dx, dy) => [255, 214 - 50 * Math.hypot(dx, dy), 120, 255])
  c.rect(x + w * 0.3, y, w * 0.4, h * 0.16, (u, v) => mix(lantern, [255, 240, 190], 1 - Math.abs(u - x - w / 2) / w))
  c.rect(x + w * 0.25, y - h * 0.02, w * 0.5, h * 0.03, iron)
}
function crateBox(c, x, y, w, h) {
  c.rect(x, y, w, h, crate)
  c.poly([[x, y], [x + w, y], [x + w * 0.85, y - h * 0.18], [x + w * 0.15, y - h * 0.18]], shade(crate, 1.18))
  for (const t of [0, 0.92]) { c.rect(x, y + h * t, w, h * 0.08, shade(crate, 0.7)); c.rect(x + w * t, y, w * 0.08, h, shade(crate, 0.7)) }
  c.poly([[x, y + h * 0.08], [x + w * 0.1, y + h * 0.08], [x + w, y + h * 0.92], [x + w * 0.9, y + h * 0.92]], shade(crate, 0.78))
}
function fishingNet(c, x, y, w, h) {
  c.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, (dx, dy) => (Math.abs(Math.sin(dx * 18)) < 0.25 || Math.abs(Math.sin(dy * 18)) < 0.25) ? shade(net, 0.7) : [...net, 210])
}
function pier(c, x, y, w, h) {
  c.poly([[x + w * 0.2, y], [x + w * 0.8, y], [x + w, y + h], [x, y + h]], (u, v) => shade(wood, 0.8 + 0.3 * Math.abs(Math.sin(u * 60))))
  c.rect(x, y + h, w, h * 0.12, darkWood)
  for (const t of [0.05, 0.3, 0.68, 0.92]) c.rect(x + w * t, y + h, w * 0.04, h * 0.3, darkWood)
}

// Boxes are normalised concept coordinates; the smoke draws exactly these in the UI.
const layout = {
  barrels: [{ x: 0.08, y: 0.56, w: 0.15, h: 0.22 }, { x: 0.26, y: 0.6, w: 0.14, h: 0.21 }],
  lantern: { x: 0.56, y: 0.26, w: 0.12, h: 0.5 },
  crate: { x: 0.74, y: 0.62, w: 0.17, h: 0.2 }
}
function conceptPng(size) {
  const c = canvas(size)
  c.rect(0, 0, 1, 0.42, (u, v) => mix([74, 52, 96], [255, 156, 84], v / 0.42))
  c.ellipse(0.78, 0.3, 0.07, 0.07, [255, 214, 140])
  c.rect(0, 0.36, 1, 0.2, (u, v) => mix([44, 92, 120], [24, 52, 76], (v - 0.36) / 0.2))
  for (let i = 0; i < 9; i++) c.rect(0.05 + i * 0.11, 0.4 + (i % 3) * 0.04, 0.05, 0.004, [255, 190, 130])
  c.poly([[0.2, 0.46], [0.8, 0.46], [1.05, 1], [-0.05, 1]], (u, v) => shade(wood, 0.72 + 0.28 * Math.abs(Math.sin((u - 0.5) / (v + 0.2) * 40))))
  for (const b of layout.barrels) barrel(c, b.x + 0.01, b.y + 0.02, b.w - 0.02, b.h - 0.03)
  lanternPost(c, layout.lantern.x, layout.lantern.y + 0.02, layout.lantern.w, layout.lantern.h - 0.02)
  crateBox(c, layout.crate.x + 0.01, layout.crate.y + 0.04, layout.crate.w - 0.02, layout.crate.h - 0.05)
  return c.png()
}
function cutoutPng(kind, size = 512) {
  const c = canvas(size)
  if (kind === 'barrel') barrel(c, 0.3, 0.24, 0.4, 0.56)
  else if (kind === 'lantern') lanternPost(c, 0.32, 0.14, 0.36, 0.72)
  else if (kind === 'crate') crateBox(c, 0.25, 0.34, 0.5, 0.44)
  else if (kind === 'net') fishingNet(c, 0.22, 0.28, 0.56, 0.44)
  else pier(c, 0.12, 0.3, 0.76, 0.36)
  return c.png()
}

// ---------- procedural static GLB fixtures (flat-shaded prisms, untextured materials) ----------
function prism(sides, radius, height, y0 = 0, rotate = Math.PI / sides) {
  const tris = [], ring = y => Array.from({ length: sides }, (_, i) => [Math.cos(rotate + i * 2 * Math.PI / sides) * radius, y, Math.sin(rotate + i * 2 * Math.PI / sides) * radius])
  const bottom = ring(y0), top = ring(y0 + height)
  for (let i = 0; i < sides; i++) {
    const j = (i + 1) % sides
    tris.push([bottom[i], top[i], top[j]], [bottom[i], top[j], bottom[j]], [[0, y0 + height, 0], top[j], top[i]], [[0, y0, 0], bottom[i], bottom[j]])
  }
  return tris
}
const box = (w, h, d, y0 = 0) => prism(4, Math.SQRT1_2, 1, 0, Math.PI / 4).map(t => t.map(([x, y, z]) => [x * w, y0 + y * h, z * d]))
function glb(parts) {
  const chunks = [], accessors = [], views = [], meshes = [], materials = []
  let offset = 0
  for (const [index, { tris, color }] of parts.entries()) {
    const pos = Buffer.alloc(tris.length * 36), nor = Buffer.alloc(tris.length * 36)
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity]
    tris.forEach(([a, b, c], t) => {
      const u = b.map((v, i) => v - a[i]), v = c.map((x, i) => x - a[i])
      let n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]
      const l = Math.hypot(...n) || 1; n = n.map(x => x / l)
      ;[a, b, c].forEach((p, k) => p.forEach((value, i) => {
        pos.writeFloatLE(value, t * 36 + k * 12 + i * 4); nor.writeFloatLE(n[i], t * 36 + k * 12 + i * 4)
        min[i] = Math.min(min[i], value); max[i] = Math.max(max[i], value)
      }))
    })
    for (const [buffer, extra] of [[pos, { min, max }], [nor, {}]]) {
      views.push({ buffer: 0, byteOffset: offset, byteLength: buffer.length }); chunks.push(buffer); offset += buffer.length
      accessors.push({ bufferView: views.length - 1, componentType: 5126, count: tris.length * 3, type: 'VEC3', ...extra })
    }
    materials.push({ pbrMetallicRoughness: { baseColorFactor: [...color.map(v => (v / 255) ** 2.2), 1], metallicFactor: 0, roughnessFactor: 0.85 } })
    meshes.push({ attributes: { POSITION: index * 2, NORMAL: index * 2 + 1 }, material: index })
  }
  const bin = Buffer.concat(chunks)
  const gltf = {
    asset: { version: '2.0', generator: 'World Studio smoke fixture' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: meshes }], materials, accessors, bufferViews: views, buffers: [{ byteLength: bin.length }]
  }
  let json = Buffer.from(JSON.stringify(gltf)); json = Buffer.concat([json, Buffer.alloc((4 - json.length % 4) % 4, 0x20)])
  const header = Buffer.alloc(12), jh = Buffer.alloc(8), bh = Buffer.alloc(8)
  header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(28 + json.length + bin.length, 8)
  jh.writeUInt32LE(json.length, 0); jh.writeUInt32LE(0x4e4f534a, 4); bh.writeUInt32LE(bin.length, 0); bh.writeUInt32LE(0x004e4942, 4)
  return Buffer.concat([header, jh, json, bh, bin])
}
const models = {
  barrel: () => glb([{ tris: prism(14, 0.3, 0.8), color: wood }, { tris: prism(14, 0.31, 0.06, 0.12), color: iron }, { tris: prism(14, 0.31, 0.06, 0.62), color: iron }]),
  lantern: () => glb([{ tris: box(0.08, 1.6, 0.08), color: darkWood }, { tris: box(0.26, 0.3, 0.26, 1.5), color: lantern }, { tris: box(0.32, 0.04, 0.32, 1.8), color: iron }]),
  crate: () => glb([{ tris: box(0.7, 0.6, 0.7), color: crate }, { tris: box(0.74, 0.08, 0.74, 0.52), color: shade(crate, 0.7) }]),
  net: () => glb([{ tris: box(0.9, 0.05, 0.6), color: net }]),
  environment: () => glb([{ tris: box(1, 0.06, 0.62), color: wood }, { tris: box(1.3, 0.02, 0.9, -0.01), color: [44, 92, 120] }, ...[-0.45, 0.45].flatMap(x => [-0.28, 0.28].map(z => ({ tris: box(0.05, 0.16, 0.05, 0.06).map(t => t.map(([a, b, c]) => [a + x, b, c + z])), color: darkWood })))])
}
// Classify by the earliest prop keyword in the positive prompt (the brief's location text may mention others).
const kindOf = text => {
  if (/Remove these objects|empty location/i.test(text)) return 'environment'
  const hits = [['barrel', /barrel/i], ['lantern', /lantern/i], ['crate', /crate/i], ['net', /fishing net/i]]
    .map(([kind, re]) => [kind, text.search(re)]).filter(([, at]) => at >= 0).sort((a, b) => a[1] - b[1])
  return hits[0]?.[0] ?? 'environment'
}
const positive = prompt => Object.values(prompt).filter(n => n.class_type === 'CLIPTextEncode').map(n => String(n.inputs.text)).find(t => !/watermark/.test(t)) ?? ''

// ---------- fixture ComfyUI (loopback only) ----------
const checkpoints = ['DreamShaper_8_pruned.safetensors', 'hunyuan3d-dit-v2-mini_fp16.safetensors']
const edit = { model: 'flux-2-klein-4b-fp8.safetensors', textEncoder: 'qwen_3_4b.safetensors', vae: 'flux2-vae.safetensors' }
let nodeInfo
const outputs = new Map(), prompts = []
const read = async request => { const parts = []; for await (const part of request) parts.push(part); return Buffer.concat(parts) }
const server = createServer(async (request, response) => {
  const send = (value, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)) }
  const url = request.url ?? '/'
  if (url === '/system_stats') return send({ devices: [{ name: 'cuda:0 Smoke fixture GPU (no inference)', type: 'cuda', vram_total: 24 * 2 ** 30, vram_free: 22 * 2 ** 30 }] })
  if (url === '/object_info') return send(nodeInfo)
  if (url === '/upload/image') return send({ name: /filename="([^"]+)"/.exec((await read(request)).toString('latin1'))?.[1], subfolder: '', type: 'input' })
  if (url.startsWith('/api/jobs/')) return send({})
  if (url === '/prompt') {
    const { prompt, prompt_id: id } = JSON.parse((await read(request)).toString())
    prompts.push(prompt)
    const [node, save] = Object.entries(prompt).find(([, n]) => n.class_type === 'SaveImage' || n.class_type === 'SaveGLB')
    const prefix = String(save.inputs.filename_prefix), mesh = save.class_type === 'SaveGLB'
    const filename = `${prefix}_00001_.${mesh ? 'glb' : 'png'}`
    let bytes, kind
    if (mesh) bytes = models[[...outputs.values()].findLast(o => o.prefix.replace('_ref_', '_mesh_') === prefix)?.kind ?? 'environment']()
    else if (/_concept$/.test(prefix)) bytes = conceptPng(512)
    else bytes = cutoutPng(kind = kindOf(positive(prompt)))
    await writeFile(join(comfyOutput, filename), bytes)
    outputs.set(id, { node, field: mesh ? '3d' : 'images', filename, prefix, kind })
    setTimeout(() => outputs.get(id).ready = true, 250)
    return send({ prompt_id: id, number: prompts.length })
  }
  if (url.startsWith('/history/')) {
    const id = url.slice('/history/'.length), result = outputs.get(id)
    if (!result?.ready) return send({})
    return send({ [id]: { outputs: { [result.node]: { [result.field]: [{ filename: result.filename, subfolder: '', type: 'output' }] } }, status: { completed: true, status_str: 'success', messages: [] } } })
  }
  send({ error: 'not found' }, 404)
})

let comfyUrl
if (!live) {
  nodeInfo = Object.fromEntries([
    'CLIPTextEncode', 'EmptyLatentImage', 'KSampler', 'VAEDecode', 'SaveImage', 'LoadImage', 'ImageScale', 'VAEEncode', 'ImageScaleToTotalPixels',
    'ConditioningZeroOut', 'ReferenceLatent', 'CFGGuider', 'EmptyFlux2LatentImage', 'Flux2Scheduler', 'GetImageSize', 'KSamplerSelect', 'RandomNoise',
    'SamplerCustomAdvanced', 'RemoveBackground', 'InvertMask', 'JoinImageWithAlpha', 'ImageOnlyCheckpointLoader', 'CLIPVisionEncode',
    'Hunyuan3Dv2Conditioning', 'EmptyLatentHunyuan3Dv2', 'VAEDecodeHunyuan3D', 'VoxelToMesh', 'SaveGLB', 'ModelSamplingAuraFlow', 'EmptyImage', 'ImageCompositeMasked'
  ].map(name => [name, { input: { required: {} } }]))
  const combo = (key, values) => ({ input: { required: { [key]: [values] } } })
  Object.assign(nodeInfo, {
    CheckpointLoaderSimple: combo('ckpt_name', checkpoints),
    LoadBackgroundRemovalModel: combo('bg_removal_name', ['birefnet.safetensors']),
    UNETLoader: combo('unet_name', [edit.model]),
    CLIPLoader: combo('clip_name', [edit.textEncoder]),
    VAELoader: combo('vae_name', [edit.vae]),
    CLIPVisionLoader: combo('clip_name', [])
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  comfyUrl = `http://127.0.0.1:${server.address().port}`
  console.log(`Fixture ComfyUI (procedural outputs, no inference) on ${comfyUrl}`)
}

const app = await electron.launch({ args: ['.'], env: { ...process.env, ...(live ? {} : { STUDIO_DATA_DIR: data }) }, timeout: 60000 })
const errors = []
const tidy = () => app.windows()[0].evaluate(() => document.querySelectorAll('.design-brief,.design-models,.design-workspace,.item-list').forEach(e => { e.scrollTop = 0 }))
try {
  const page = await app.firstWindow()
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
  await expect(page).toHaveTitle('World Studio')
  await expect(page.locator('.brand')).toContainText(/world\s*studio/i)
  await expect(page.getByRole('heading', { name: 'World builder' })).toBeVisible()
  const accent = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim())
  assert.equal(accent, '#ff9a3c', 'orange accent theme is applied')
  const primary = await page.getByRole('button', { name: /Create world concept/ }).evaluate(el => getComputedStyle(el).backgroundColor)
  assert.match(primary, /rgb\(255, 154, 60\)/, 'primary buttons use the orange accent')
  await page.screenshot({ path: join(artifacts, '01-start.png') })

  if (!live) {
    // The UI is wired to the backend in Backend connections; model combos come from the fixture object_info.
    await page.locator('.connection').click()
    const dialog = page.getByRole('dialog', { name: 'Local backend settings' })
    await dialog.locator('#comfyUrl').fill(comfyUrl)
    await dialog.locator('#comfyRoot').fill(join(temp, 'comfy'))
    await dialog.locator('#comfyOutput').fill(comfyOutput)
    await dialog.getByRole('button', { name: 'Save settings' }).click()
    await expect(dialog.getByText('Backend settings saved.')).toBeVisible()
    await expect(dialog.getByText(/Connected\. 1 GPU device/)).toBeVisible()
    await dialog.getByRole('button', { name: 'Close settings' }).click()
  }
  await expect(page.getByText(/GB available/).first()).toBeVisible({ timeout: 20000 })

  if (!live) {
    await page.locator('#image-checkpoint').selectOption(checkpoints[0])
    for (const [key, value] of Object.entries({ editModel: edit.model, editTextEncoder: edit.textEncoder, editVae: edit.vae })) await page.locator(`#world-${key}`).selectOption(value)
    await page.locator('#world-background').selectOption('birefnet.safetensors')
    await page.locator('#mesh-checkpoint').selectOption(checkpoints[1])
    await page.getByRole('button', { name: 'Save model choices' }).click()
    await expect(page.getByText('Local model choices saved.')).toBeVisible()
  }

  await page.locator('#world-title').fill('Harbor Market')
  await page.locator('#world-location').fill('A small fishing harbor market on a wooden pier at dusk, calm water behind it, warm lantern light.')
  const props = [['Barrel', 2, 'oak with iron bands'], ['Lantern post', 1, 'wrought iron, warm glow'], ['Crate', 1, 'weathered pine'], ['Fishing net', 1, 'green rope, folded']]
  for (const [index, [name, quantity, details]] of props.entries()) {
    if (index) await page.locator('.add-prop').click()
    await page.getByLabel(`Prop ${index + 1} name`).fill(name)
    await page.getByLabel(`Prop ${index + 1} quantity`).fill(String(quantity))
    await page.getByLabel(`Prop ${index + 1} details`).fill(details)
  }
  await page.locator('#world-style').fill('Stylized hand-painted low-poly game art, warm dusk palette, soft rim light')
  await page.getByLabel('World seed').fill('1234')
  await page.getByLabel('World steps').fill('24')
  await tidy(); await page.screenshot({ path: join(shots, 'world-studio-brief.png') })

  await page.getByRole('button', { name: /Create world concept/ }).click()
  await expect(page.getByAltText('World concept for review')).toBeVisible({ timeout: 120000 })
  await page.getByRole('button', { name: /Use concept & extract parts/ }).click()
  await expect(page.getByAltText('World concept with prop boxes')).toBeVisible()

  const frame = page.locator('.extract-frame')
  const items = page.getByLabel('Extraction list').locator('.world-item')
  await expect(items).toHaveCount(5)
  const draw = async (row, b) => {
    await items.nth(row).locator('small').first().click()
    const r = await frame.boundingBox()
    await page.mouse.move(r.x + b.x * r.width, r.y + b.y * r.height)
    await page.mouse.down()
    await page.mouse.move(r.x + (b.x + b.w / 2) * r.width, r.y + (b.y + b.h / 2) * r.height, { steps: 4 })
    await page.mouse.move(r.x + (b.x + b.w) * r.width, r.y + (b.y + b.h) * r.height, { steps: 4 })
    await page.mouse.up()
  }
  for (const b of layout.barrels) await draw(1, b)
  await draw(2, layout.lantern)
  await draw(3, layout.crate)
  await expect(page.locator('.extract-box')).toHaveCount(4)
  await expect(items.nth(4)).toContainText('text only')
  await page.getByRole('button', { name: /^Extract 5 parts/ }).click()
  await expect(page.getByRole('button', { name: /Review cutouts in Batch 3D/ })).toBeVisible({ timeout: 120000 })
  await expect(page.getByLabel('Extraction list').locator('.status-chip.complete')).toHaveCount(5, { timeout: 120000 })
    .catch(async error => { console.error(await items.allInnerTexts(), await page.locator('[role=alert]').allInnerTexts()); throw error })
  await expect(page.locator('.job-progress')).toHaveCount(0)
  await items.nth(2).locator('small').first().click()
  await tidy(); await page.screenshot({ path: join(shots, 'world-studio.png') })

  await page.getByRole('button', { name: /Review cutouts in Batch 3D/ }).click()
  await page.getByRole('button', { name: /^Generate 5 models/ }).click()
  await expect(page.getByRole('button', { name: /Assemble scene/ })).toBeVisible({ timeout: 180000 })
  await expect(page.getByLabel('3D batch queue').locator('.status-chip.complete')).toHaveCount(5, { timeout: 120000 })
  await expect(page.locator('.job-progress')).toHaveCount(0)
  await tidy(); await page.screenshot({ path: join(shots, 'world-studio-batch.png') })

  await page.getByRole('button', { name: /Assemble scene/ }).click()
  await expect(page.locator('.scene-inspector .asset')).toHaveCount(6)
  await page.waitForTimeout(1500)
  await page.locator('.scene-inspector .asset', { hasText: 'Lantern post' }).click()
  await page.getByLabel('Rotation (deg)').fill('15')
  await page.getByRole('button', { name: 'Save layout' }).click()
  await expect(page.getByRole('status').getByText('Scene layout saved.')).toBeVisible()
  await page.waitForTimeout(500)
  await tidy(); await page.screenshot({ path: join(shots, 'world-studio-scene.png') })

  await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }) }, exportDir)
  await page.getByRole('button', { name: /Export scene bundle/ }).click()
  await expect(page.getByRole('status').getByText(/Exported scene\.glb/)).toBeVisible({ timeout: 30000 })
  const [bundle] = await readdir(exportDir)
  const exported = (await readdir(join(exportDir, bundle), { recursive: true })).map(f => f.replaceAll('\\', '/')).sort()
  for (const file of ['scene.glb', 'world.json', 'models/barrel.glb', 'models/lantern-post.glb', 'models/crate.glb', 'models/fishing-net.glb', 'references/harbor-market.png'])
    assert.ok(exported.includes(file), `export contains ${file}: ${exported.join(', ')}`)

  // Minimum window size keeps every panel reachable without horizontal page overflow.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1100, 760))
  await page.waitForTimeout(400)
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  assert.ok(overflow <= 0, `no horizontal overflow at minimum size (${overflow}px)`)
  await page.screenshot({ path: join(artifacts, '02-minimum-size.png') })

  assert.deepEqual(errors, [], 'no renderer errors')
  console.log(`World Studio smoke passed${live ? ' (live backend)' : ' (fixture backend: procedural images and meshes, no model inference)'}.`)
  console.log(`${prompts.length} workflows submitted. Export: ${exported.length} files. Screenshots: ${shots}`)
} finally {
  await app.close().catch(() => {})
  server.close()
  await rm(temp, { recursive: true, force: true }).catch(() => {})
}
