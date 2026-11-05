import { app, BrowserWindow, dialog, ipcMain, nativeImage, net, protocol } from 'electron'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Box, ItemEdit, ItemPhase, WorldConfig, WorldRequest } from '../shared/world'
import type { ModelPackage } from '../shared/world-models'
import type { LayoutEntry, Settings, StudioState } from '../shared/types'
import { cropRect } from '../shared/scene'
import { validateCutout } from './image-validation'
import { errorText, settingsSchema } from './validation'
import { WorldManager, worldRequestSchema } from './world'

protocol.registerSchemesAsPrivileged([{ scheme: 'studio', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }])
let window: BrowserWindow
let worlds: WorldManager
let quitting = false
app.setName('World Studio')
app.setPath('userData', process.env.STUDIO_DATA_DIR ?? join(app.getPath('appData'), 'WorldStudio'))
const ownsWorkspace = app.requestSingleInstanceLock()
if (!ownsWorkspace) app.quit()
app.on('second-instance', () => {
  if (window && !window.isDestroyed()) {
    if (window.isMinimized()) window.restore()
    window.focus()
  }
})

const root = () => app.getPath('userData')
const localComfy = join(process.env.LOCALAPPDATA ?? join(app.getPath('home'), 'AppData', 'Local'), 'ComfyUI')
function loadSettings(): Settings {
  const file = join(root(), 'settings.json')
  const defaults = { comfyUrl: 'http://127.0.0.1:8189', comfyRoot: localComfy, comfyOutput: join(localComfy, 'output') }
  try { return settingsSchema.parse(existsSync(file) ? { ...defaults, ...JSON.parse(readFileSync(file, 'utf8')) } : defaults) }
  catch { return settingsSchema.parse(defaults) }
}
let settings: Settings
let busy = false
// One shared job slot: generation, detection, downloads and edits never overlap.
function acquire() {
  if (busy) throw new Error('Another local job is running. Wait for it to finish or cancel it first.')
  busy = true
  let released = false
  return () => { if (!released) { released = true; busy = false } }
}

async function loadImage(file: string) {
  if ((await stat(file)).size > 20 * 1024 * 1024) throw new Error('Image exceeds 20 MB.')
  const image = nativeImage.createFromBuffer(await readFile(file))
  const { width, height } = image.getSize()
  if (image.isEmpty() || !width || !height || width * height > 32_000_000) throw new Error('Image is invalid or exceeds 32 megapixels.')
  return { image, width, height }
}
const images = {
  async normalize(file: string, cutout?: boolean, squareSize?: number) {
    const { image, width, height } = await loadImage(file)
    if (cutout) validateCutout(image.toBitmap(), width, height)
    if (squareSize) {
      const inner = squareSize - Math.ceil(squareSize * 0.08)
      const scaled = image.resize(width >= height ? { width: inner, quality: 'best' } : { height: inner, quality: 'best' })
      const dimensions = scaled.getSize()
      const source = scaled.toBitmap(), canvas = Buffer.alloc(squareSize * squareSize * 4)
      const left = Math.floor((squareSize - dimensions.width) / 2), top = Math.floor((squareSize - dimensions.height) / 2)
      for (let y = 0; y < dimensions.height; y++) source.copy(canvas, ((top + y) * squareSize + left) * 4, y * dimensions.width * 4, (y + 1) * dimensions.width * 4)
      return nativeImage.createFromBitmap(canvas, { width: squareSize, height: squareSize }).toPNG()
    }
    return image.toPNG()
  },
  async crop(file: string, box: Box) {
    const { image, width, height } = await loadImage(file)
    return image.crop(cropRect(box, width, height)).toPNG()
  }
}

if (ownsWorkspace) app.whenReady().then(async () => {
  settings = loadSettings()
  const assets = new Map<string, string>()
  const state = (): StudioState => ({ settings, world: worlds.snapshot(), version: app.getVersion(), platform: process.platform, arch: process.arch })
  worlds = new WorldManager(root(), assets, () => settings, acquire, () => {
    if (window && !window.isDestroyed()) window.webContents.send('studio:update', state())
  }, images)
  protocol.handle('studio', async request => {
    const url = new URL(request.url)
    const file = url.hostname === 'asset' ? assets.get(decodeURIComponent(url.pathname.slice(1))) : undefined
    if (!file) return new Response('Unknown local asset', { status: 404 })
    return net.fetch(pathToFileURL(file).toString())
  })
  window = new BrowserWindow({
    title: 'World Studio', width: 1440, height: 960, minWidth: 1100, minHeight: 760,
    icon: join(import.meta.dirname, '../renderer/icon.png'),
    backgroundColor: '#111313', autoHideMenuBar: true,
    webPreferences: { preload: join(import.meta.dirname, '../preload/index.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== window.webContents.getURL()) event.preventDefault()
  })
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  const allowedRenderer = process.env.ELECTRON_RENDERER_URL
  function handle(channel: string, callback: (...args: never[]) => unknown) {
    ipcMain.handle(`studio:${channel}`, (event, ...args) => {
      const url = event.senderFrame?.url
      if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame ||
          !(allowedRenderer ? url?.startsWith(allowedRenderer + '/') || url === allowedRenderer : url === pathToFileURL(join(import.meta.dirname, '../renderer/index.html')).toString()))
        throw new Error('Untrusted desktop IPC caller.')
      return callback(...args as never[])
    })
  }
  const imageFilter = [{ name: 'Image', extensions: ['png', 'jpg', 'jpeg', 'webp'] }]
  handle('state', () => state())
  handle('readiness', () => worlds.readiness())
  handle('saveSettings', (value: Settings) => {
    const release = acquire()
    try {
      settings = settingsSchema.parse(value)
      const file = join(root(), 'settings.json')
      writeFileSync(file + '.tmp', JSON.stringify(settings, null, 2)); renameSync(file + '.tmp', file)
      window.webContents.send('studio:update', state())
      return settings
    } finally { release() }
  })
  handle('saveConfig', (config: WorldConfig) => worlds.saveConfig(config))
  handle('installModels', (id: ModelPackage) => worlds.installModels(id, async (label, models, modelRoot) => {
    const choice = await dialog.showMessageBox(window, {
      type: 'question', title: 'Download required models', message: label,
      detail: `Download and select up to ${(models.reduce((sum, model) => sum + model.bytes, 0) / 2 ** 30).toFixed(2)} GiB from Hugging Face into:\n${join(modelRoot, 'models')}\n\n` +
        models.map(model => `${model.file} (${(model.bytes / 2 ** 30).toFixed(2)} GiB)\n${model.license}\n${model.page}`).join('\n\n') +
        '\n\nReview the upstream model terms before use. Matching verified files are reused; other existing files are never overwritten. No world assets or credentials are uploaded. No Python packages are installed. Generation will not restart automatically.',
      buttons: ['Cancel', 'Download & select'], defaultId: 0, cancelId: 0, noLink: true
    })
    return choice.response === 1
  }))
  handle('cancel', () => worlds.cancel())
  handle('addReference', async () => {
    const result = await dialog.showOpenDialog(window, { title: 'Choose a local world reference image', properties: ['openFile'], filters: imageFilter })
    return result.canceled ? null : worlds.addReference(result.filePaths[0])
  })
  handle('create', (request: WorldRequest) => worlds.create(request))
  handle('remove', (id: string) => worlds.remove(String(id)))
  handle('importConcept', async (brief: WorldRequest) => {
    worldRequestSchema.partial().parse(brief)
    const result = await dialog.showOpenDialog(window, { title: 'Use an existing concept image', properties: ['openFile'], filters: imageFilter })
    return result.canceled ? null : worlds.importConcept(result.filePaths[0], brief)
  })
  handle('importItem', async (id: string, itemId: string, phase: ItemPhase) => {
    const model = phase === 'model'
    const result = await dialog.showOpenDialog(window, {
      title: model ? 'Use an existing static GLB' : 'Use an existing transparent cutout', properties: ['openFile'],
      filters: model ? [{ name: 'Embedded GLB mesh', extensions: ['glb'] }] : [{ name: 'Transparent image', extensions: ['png', 'webp'] }]
    })
    if (result.canceled) return false
    await worlds.importItem(String(id), String(itemId), phase, result.filePaths[0])
    return true
  })
  handle('runConcept', (id: string) => worlds.runConcept(String(id)))
  handle('detect', (id: string) => worlds.detect(String(id)))
  handle('runBatch', (id: string, phase: ItemPhase, retry: boolean) => worlds.runBatch(String(id), phase, retry === true))
  handle('updateItems', (id: string, items: ItemEdit[]) => worlds.updateItems(String(id), items))
  handle('setItemPhase', (id: string, itemId: string, phase: ItemPhase, action: 'retry' | 'skip') => worlds.setItemPhase(String(id), String(itemId), phase, action))
  handle('saveLayout', (id: string, layout: LayoutEntry[]) => worlds.saveLayout(String(id), layout))
  handle('exportBundle', async (id: string, scene?: Uint8Array) => {
    if (scene !== undefined && !(scene instanceof Uint8Array)) throw new Error('Assembled scene must be binary GLB data.')
    const result = await dialog.showOpenDialog(window, { title: 'Choose an export folder', properties: ['openDirectory', 'createDirectory'] })
    return result.canceled ? null : worlds.exportBundle(String(id), result.filePaths[0], scene)
  })
  if (allowedRenderer) await window.loadURL(allowedRenderer)
  else await window.loadFile(join(import.meta.dirname, '../renderer/index.html'))
}).catch(error => { dialog.showErrorBox('World Studio failed to start', errorText(error)); app.quit() })

app.on('before-quit', event => {
  if (!quitting && worlds) {
    event.preventDefault()
    quitting = true
    worlds.cancel().catch(error => dialog.showErrorBox('Backend shutdown needs attention', errorText(error))).finally(() => app.quit())
  }
})
app.on('window-all-closed', () => app.quit())
