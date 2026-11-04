import { z } from 'zod'

export function localUrl(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Use a local ComfyUI URL such as http://127.0.0.1:8189. Remote world uploads are disabled.')
  }
  return url.origin
}

export const settingsSchema = z.object({
  comfyUrl: z.string().transform(localUrl),
  comfyRoot: z.string().min(1).max(1024),
  comfyOutput: z.string().min(1).max(1024)
}).strict()

export function errorText(error: unknown): string {
  if (error instanceof z.ZodError) return error.issues.map(i => i.message).join(' ')
  return error instanceof Error ? error.message : String(error)
}
