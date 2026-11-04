import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

export default defineConfig({
  main: { build: { rollupOptions: { input: resolve('src/main/index.ts') } } },
  preload: { build: { rollupOptions: { input: resolve('src/preload/index.ts'), output: { format: 'cjs', entryFileNames: 'index.cjs' } } } },
  renderer: {
    root: 'src/renderer',
    plugins: [react()],
    build: { rollupOptions: { input: resolve('src/renderer/index.html') } },
    server: { host: '127.0.0.1' }
  }
})
