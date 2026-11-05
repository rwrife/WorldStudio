import type { Box, ItemEdit, ItemPhase, Transform, WorldConfig, WorldReadiness, WorldReference, WorldRequest, WorldSnapshot } from './world'
import type { ModelPackage } from './world-models'

export interface Settings { comfyUrl: string; comfyRoot: string; comfyOutput: string }
export interface StudioState { settings: Settings; world: WorldSnapshot; version: string; platform: string; arch: string }
export interface LayoutEntry { itemId: string; transforms: Transform[] }
export type { Box }

/** Narrow preload bridge. Every argument is validated again in the main process. */
export interface StudioApi {
  state(): Promise<StudioState>
  readiness(): Promise<WorldReadiness>
  saveSettings(settings: Settings): Promise<Settings>
  saveConfig(config: WorldConfig): Promise<void>
  installModels(pkg: ModelPackage): Promise<WorldConfig | null>
  cancel(): Promise<void>
  addReference(): Promise<WorldReference | null>
  create(request: WorldRequest): Promise<string>
  remove(id: string): Promise<void>
  importConcept(brief: WorldRequest): Promise<string | null>
  importItem(id: string, itemId: string, phase: ItemPhase): Promise<boolean>
  runConcept(id: string): Promise<void>
  detect(id: string): Promise<void>
  runBatch(id: string, phase: ItemPhase, retry: boolean): Promise<void>
  updateItems(id: string, items: ItemEdit[]): Promise<void>
  setItemPhase(id: string, itemId: string, phase: ItemPhase, action: 'retry' | 'skip'): Promise<void>
  saveLayout(id: string, layout: LayoutEntry[]): Promise<void>
  exportBundle(id: string, sceneGlb?: Uint8Array): Promise<string | null>
  onUpdate(callback: (state: StudioState) => void): () => void
}
