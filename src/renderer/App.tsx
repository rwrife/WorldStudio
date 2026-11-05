import { useEffect, useState } from 'react'
import { ArrowRight, Check as CheckIcon, CircleAlert, LoaderCircle, RefreshCw, Settings2, ShieldCheck, X } from 'lucide-react'
import type { Settings, StudioState } from '../shared/types'
import type { WorldReadiness } from '../shared/world'
import { WorldPanel } from './WorldPanel'

export const explain = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': Error: /, '')

/** Isometric terrain block with a peak and a tree: the World Studio mark. */
export function BrandMark({ size = 26 }: { size?: number }) {
  return <svg viewBox="0 0 64 64" width={size} height={size} aria-hidden="true">
    <path d="M32 6 58 20v24L32 58 6 44V20Z" fill="currentColor" opacity=".22" />
    <path d="M6 20 32 34v24L6 44Z" fill="currentColor" opacity=".55" />
    <path d="M58 20 32 34v24l26-14Z" fill="currentColor" opacity=".8" />
    <path d="M6 20 32 6l26 14-26 14Z" fill="currentColor" opacity=".35" />
    <path d="m14 24 10-12 7 8 4-4 13 10-16 8Z" fill="currentColor" />
    <circle cx="44" cy="15" r="3.4" fill="currentColor" />
  </svg>
}

export function App() {
  const [state, setState] = useState<StudioState>()
  const [ready, setReady] = useState<WorldReadiness>()
  const [readyError, setReadyError] = useState('')
  const [checking, setChecking] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settings, setSettings] = useState<Settings>()
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  async function refresh() {
    setChecking(true)
    try { setReady(await window.studio.readiness()); setReadyError('') }
    catch (e) { setReady(undefined); setReadyError(explain(e)) }
    finally { setChecking(false) }
  }
  useEffect(() => {
    void window.studio.state().then(value => { setState(value); setSettings(value.settings) }).catch(e => setError(explain(e)))
    void refresh()
    return window.studio.onUpdate(setState)
  }, [])

  const running = state?.world.worlds.some(world => world.status === 'running') || state?.world.modelDownload?.status === 'running'
  return <div className="app">
    <header className="topbar">
      <div className="brand"><span className="brand-mark"><BrandMark /></span><div className="brand-name"><strong>world<span>studio</span></strong><span className="version">powered by ComfyUI</span></div></div>
      <nav className="workspace-tabs" aria-label="World workspace"><button className="active" aria-current="page">World Builder</button><span>STATIC SCENES</span></nav>
      <button aria-label="Backend connections" className={`connection ${readyError ? 'warning' : ''}`} onClick={() => { setSettings(state?.settings); setSettingsOpen(true) }}>
        <span className="tiny-dot" />{checking ? 'Checking backends' : readyError ? 'ComfyUI offline' : ready ? 'Local backends ready' : 'Backend settings'}<Settings2 size={14} />
      </button>
    </header>
    {state ? <WorldPanel state={state} ready={ready} readyError={readyError} checking={checking} onRefresh={refresh} onSettings={() => { setSettings(state.settings); setSettingsOpen(true) }} /> :
      <div className="designer-layout loading">{error ? <div className="banner error" role="alert"><CircleAlert size={17} /><span>{error}</span></div> : <LoaderCircle className="spin" />}</div>}
    <footer><span><ShieldCheck size={12} /> LOCAL PIPELINE</span><span>World brief <ArrowRight size={10} /> Concept art <ArrowRight size={10} /> Extract props <ArrowRight size={10} /> Batch 3D <ArrowRight size={10} /> Scene assembly</span><span>STATIC MESHES / NO RIGGING{state ? ` / ${state.arch.toUpperCase()}` : ''}</span></footer>
    {settingsOpen && settings && <div className="modal-backdrop"><section className="settings-modal" role="dialog" aria-modal="true" aria-label="Local backend settings">
      <div className="modal-heading"><div><span className="section-kicker">LOCAL INFRASTRUCTURE</span><h2>Backend connections</h2></div><button aria-label="Close settings" onClick={() => setSettingsOpen(false)}><X size={20} /></button></div>
      <p className="panel-description">World Studio only talks to a ComfyUI server on this machine (loopback). Generated files are read from the ComfyUI output folder and copied into your local World Studio workspace.</p>
      <label className="field-label" htmlFor="comfyUrl">ComfyUI URL <span>loopback only</span></label>
      <input id="comfyUrl" value={settings.comfyUrl} onChange={e => setSettings({ ...settings, comfyUrl: e.target.value })} />
      <label className="field-label" htmlFor="comfyRoot">ComfyUI backend folder <span>models are installed here</span></label>
      <input id="comfyRoot" value={settings.comfyRoot} onChange={e => setSettings({ ...settings, comfyRoot: e.target.value })} />
      <label className="field-label" htmlFor="comfyOutput">ComfyUI output folder</label>
      <input id="comfyOutput" value={settings.comfyOutput} onChange={e => setSettings({ ...settings, comfyOutput: e.target.value })} />
      <div className="settings-actions">
        <button className="primary" disabled={running} onClick={() => void (async () => {
          setError(''); setNotice('')
          try { setSettings(await window.studio.saveSettings(settings)); setNotice('Backend settings saved.'); await refresh() } catch (e) { setError(explain(e)) }
        })()}><CheckIcon size={15} /> Save settings</button>
      </div>
      {error && <div className="banner error" role="alert"><CircleAlert size={16} /><span>{error}</span></div>}
      {notice && <div className="banner success" role="status"><CheckIcon size={16} /><span>{notice}</span></div>}
      <div className="section-heading" style={{ marginTop: 22 }}><span className="section-kicker">READINESS CHECKS</span><button className="text-button" disabled={checking} onClick={() => void refresh()}><RefreshCw size={13} className={checking ? 'spin' : ''} /> Refresh</button></div>
      <div className="checks">
        <div className={`check ${readyError ? 'blocked' : ''}`}>{readyError ? <CircleAlert size={16} /> : <CheckIcon size={16} />}<div><strong>ComfyUI</strong><p>{readyError || (ready ? `Connected. ${ready.devices.length} GPU device(s), ${ready.checkpoints.length} checkpoint(s) visible.` : 'Not checked yet.')}</p></div></div>
        <div className={`check ${ready?.visionError ? 'blocked' : ''}`}>{ready?.visionError ? <CircleAlert size={16} /> : <CheckIcon size={16} />}<div><strong>Ollama vision (optional)</strong><p>{ready?.visionError ?? (ready ? `${ready.visionModels.length} local model(s) found. Prop boxes can always be drawn by hand.` : 'Checked together with ComfyUI.')}</p></div></div>
      </div>
      {state && <p className="fine-print">World Studio {state.version} / {state.platform}-{state.arch}. Workspace data stays on this machine.</p>}
    </section></div>}
  </div>
}
