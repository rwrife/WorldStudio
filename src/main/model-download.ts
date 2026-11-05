import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { link, lstat, mkdir, realpath, rm, stat, statfs } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { WorldModel } from '../shared/world-models'

function inside(root: string, path: string) {
  const rel = relative(root, path)
  if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel))
    throw new Error('Model destination must stay inside the saved ComfyUI folder. Check Backend connections and model-folder links.')
}

async function digest(file: string, signal: AbortSignal) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file, { signal })) hash.update(chunk)
  return hash.digest('hex')
}

async function downloadResponse(url: string, signal: AbortSignal): Promise<Response> {
  for (let redirects = 0; redirects < 8; redirects++) {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password ||
        !(parsed.hostname === 'huggingface.co' || parsed.hostname.endsWith('.huggingface.co') || parsed.hostname.endsWith('.hf.co')))
      throw new Error('Model download redirected outside the trusted HTTPS model hosts.')
    const response = await fetch(url, { redirect: 'manual', signal })
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel()
      const location = response.headers.get('location')
      if (!location) throw new Error('Model download redirect has no destination.')
      url = new URL(location, url).href
      continue
    }
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error(`Model download failed: HTTP ${response.status}. Check your connection and the model's access requirements; Studio does not collect credentials.`)
    }
    return response
  }
  throw new Error('Model download exceeded the redirect limit.')
}

async function* chunks(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader()
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) return
      yield next.value
    }
  } finally {
    await reader.cancel()
    reader.releaseLock()
  }
}

export async function installWorldModel(root: string, model: WorldModel, signal: AbortSignal,
  progress: (received: number) => void): Promise<void> {
  signal.throwIfAborted()
  const base = await realpath(root)
  if (!(await stat(join(base, 'main.py'))).isFile()) throw new Error('Select the ComfyUI backend folder containing main.py in Backend connections.')
  if (/[\\/:]/.test(model.folder) || /[\\/:]/.test(model.file)) throw new Error('Invalid model catalog path.')
  const models = join(base, 'models')
  await mkdir(models, { recursive: true })
  inside(base, await realpath(models))
  const directory = join(models, model.folder)
  await mkdir(directory, { recursive: true })
  inside(base, await realpath(directory))
  const target = join(directory, model.file)
  const existing = await lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
    return undefined
  })
  if (existing) {
    if (!existing.isFile() || existing.isSymbolicLink() || existing.size !== model.bytes || await digest(target, signal) !== model.sha256)
      throw new Error(`Existing ${model.file} does not match the verified model. It was not overwritten. Move it aside manually or choose your intended weights in model settings.`)
    progress(model.bytes)
    return
  }
  const disk = await statfs(directory)
  if (disk.bavail * disk.bsize < model.bytes + 64 * 1024 * 1024)
    throw new Error(`Not enough free disk space for ${model.file}. Free at least ${(model.bytes / 2 ** 30).toFixed(2)} GiB and retry.`)
  const partial = join(directory, `.${model.file}.${randomUUID()}.part`)
  const timedSignal = AbortSignal.any([signal, AbortSignal.timeout(2 * 60 * 60 * 1000)])
  try {
    const response = await downloadResponse(model.url, timedSignal)
    if (!response.body) throw new Error('Model server returned an empty response.')
    const size = response.headers.get('content-length')
    if (size && Number(size) !== model.bytes) {
      await response.body.cancel()
      throw new Error(`Unexpected download size for ${model.file}. No model was installed.`)
    }
    let received = 0
    const hash = createHash('sha256')
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        received += chunk.length
        if (received > model.bytes) { done(new Error(`Download exceeds the expected size for ${model.file}.`)); return }
        hash.update(chunk); progress(received); done(null, chunk)
      }
    })
    await pipeline(Readable.from(chunks(response.body)), meter, createWriteStream(partial, { flags: 'wx' }), { signal: timedSignal })
    if (received !== model.bytes || hash.digest('hex') !== model.sha256)
      throw new Error(`Verification failed for ${model.file}. The incomplete or corrupt download was not installed; retry the download.`)
    signal.throwIfAborted()
    // A hard link publishes the verified file atomically without replacing an existing file.
    try { await link(partial, target) }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EEXIST') throw new Error(`${model.file} appeared during the download and was not overwritten. Retry to verify the existing file.`)
      throw new Error(`Could not publish verified ${model.file}: ${error instanceof Error ? error.message : String(error)}. Check write permissions and use a filesystem supporting hard links (such as NTFS), or install this model manually.`)
    }
  } finally {
    await rm(partial, { force: true })
  }
}
