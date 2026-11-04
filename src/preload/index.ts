import { contextBridge, ipcRenderer } from 'electron'
import type { StudioApi, StudioState } from '../shared/types'

const invoke = (channel: string) => (...args: unknown[]) => ipcRenderer.invoke(`studio:${channel}`, ...args)
const api: StudioApi = {
  state: invoke('state') as StudioApi['state'],
  readiness: invoke('readiness') as StudioApi['readiness'],
  saveSettings: invoke('saveSettings') as StudioApi['saveSettings'],
  saveConfig: invoke('saveConfig') as StudioApi['saveConfig'],
  installModels: invoke('installModels') as StudioApi['installModels'],
  cancel: invoke('cancel') as StudioApi['cancel'],
  addReference: invoke('addReference') as StudioApi['addReference'],
  create: invoke('create') as StudioApi['create'],
  remove: invoke('remove') as StudioApi['remove'],
  importConcept: invoke('importConcept') as StudioApi['importConcept'],
  importItem: invoke('importItem') as StudioApi['importItem'],
  runConcept: invoke('runConcept') as StudioApi['runConcept'],
  detect: invoke('detect') as StudioApi['detect'],
  runBatch: invoke('runBatch') as StudioApi['runBatch'],
  updateItems: invoke('updateItems') as StudioApi['updateItems'],
  setItemPhase: invoke('setItemPhase') as StudioApi['setItemPhase'],
  saveLayout: invoke('saveLayout') as StudioApi['saveLayout'],
  exportBundle: invoke('exportBundle') as StudioApi['exportBundle'],
  onUpdate(callback) {
    const listener = (_: unknown, state: StudioState) => callback(state)
    ipcRenderer.on('studio:update', listener)
    return () => { ipcRenderer.removeListener('studio:update', listener) }
  }
}
contextBridge.exposeInMainWorld('studio', api)
