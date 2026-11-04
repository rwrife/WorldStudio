import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowDownToLine, ArrowRight, Box as BoxIcon, Check, CircleAlert, Eraser, FolderOutput, ImagePlus, Layers, LoaderCircle, Mountain, Plus,
  RefreshCw, RotateCcw, Save, ScanSearch, ShieldCheck, SkipForward, Sparkles, Trash2, X
} from 'lucide-react'
import type { StudioState } from '../shared/types'
import type { Box, ItemEdit, ItemPhase, ItemStatus, PropSpec, Transform, World, WorldConfig, WorldItem, WorldReadiness, WorldRequest } from '../shared/world'
import { editProfile, environmentPrompt, imageProfiles, limits, meshProfiles, meshTextureProfile, propIsolatePrompt } from '../shared/world'
import { batchSummary, clampBox, placeItem, sceneReady } from '../shared/scene'
import { modelPackages, type ModelPackage } from '../shared/world-models'
import { SceneViewport, type SceneHandle, type Selection } from './SceneViewport'
import { explain } from './App'
import './world.css'

type Stage = 'concept' | 'extract' | 'batch' | 'scene'
type Draft = ItemEdit & { kind: WorldItem['kind'] }
const initial: WorldRequest = { title: '', location: '', style: '', props: [{ name: '', description: '', quantity: 1 }], seed: 42, steps: 30, referenceStrength: 0.3 }
const configKeys = ['imageProfile', 'checkpoint', 'meshProfile', 'meshCheckpoint', 'visionModel', 'backgroundModel', 'editModel', 'editTextEncoder', 'editVae',
  'meshTextureModel', 'meshVision', 'meshShapeVae', 'meshTextureVae'] as const
const statusLabel: Record<ItemStatus, string> = { pending: 'Waiting', running: 'Generating', complete: 'Ready', failed: 'Failed', skipped: 'Skipped', cancelled: 'Cancelled' }
const toDraft = (item: WorldItem): Draft => ({ id: item.id, kind: item.kind, name: item.name, description: item.description, quantity: item.quantity, boxes: item.boxes.map(b => ({ ...b })), approved: item.approved })
const layoutOf = (items: WorldItem[]) => Object.fromEntries(items.map(item => [item.id, item.transforms.map(t => structuredClone(t))])) as Record<string, Transform[]>
const percent = (value: number) => `${(value * 100).toFixed(2)}%`

function StatusChip({ status, phase }: { status: ItemStatus; phase: ItemPhase }) {
  return <span className={`status-chip ${status}`}>{status === 'running' && <LoaderCircle size={10} className="spin" />}{phase === 'reference' ? 'Cutout' : '3D'} / {statusLabel[status]}</span>
}

function ExtractCanvas({ url, items, selectedId, disabled, onSelect, onDraw, onRemoveBox }: {
  url: string; items: Draft[]; selectedId?: string; disabled: boolean
  onSelect: (id: string) => void; onDraw: (box: Box) => void; onRemoveBox: (id: string, index: number) => void
}) {
  const frame = useRef<HTMLDivElement>(null)
  const [ratio, setRatio] = useState(1)
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number }>()
  const selected = items.find(item => item.id === selectedId)
  const canDraw = !disabled && selected?.kind === 'prop' && selected.boxes.length < limits.boxes
  const point = (event: React.PointerEvent) => {
    const rect = frame.current!.getBoundingClientRect()
    return { x: Math.min(Math.max((event.clientX - rect.left) / rect.width, 0), 1), y: Math.min(Math.max((event.clientY - rect.top) / rect.height, 0), 1) }
  }
  const normalized = (d: NonNullable<typeof drag>): Box => ({ x: Math.min(d.x0, d.x1), y: Math.min(d.y0, d.y1), w: Math.abs(d.x1 - d.x0), h: Math.abs(d.y1 - d.y0) })
  const style = (b: Box) => ({ left: percent(b.x), top: percent(b.y), width: percent(b.w), height: percent(b.h) })
  return <div className={`extract-frame ${canDraw ? 'drawing' : ''}`} ref={frame} style={{ aspectRatio: ratio, width: `min(100%, ${Math.round(470 * ratio)}px)` }}
    onPointerDown={event => {
      if (!canDraw || event.button !== 0 || (event.target as HTMLElement).closest('button')) return
      event.currentTarget.setPointerCapture(event.pointerId)
      const p = point(event)
      setDrag({ x0: p.x, y0: p.y, x1: p.x, y1: p.y })
    }}
    onPointerMove={event => { if (drag) { const p = point(event); setDrag({ ...drag, x1: p.x, y1: p.y }) } }}
    onPointerUp={() => {
      if (!drag) return
      const box = normalized(drag)
      setDrag(undefined)
      if (box.w > 0.015 && box.h > 0.015) onDraw(clampBox(box))
    }}>
    <img src={url} alt="World concept with prop boxes" draggable={false} onLoad={event => setRatio(event.currentTarget.naturalWidth / Math.max(1, event.currentTarget.naturalHeight))} />
    {items.filter(item => item.approved).flatMap(item => item.boxes.map((box, index) =>
      <div key={`${item.id}-${index}`} className={`extract-box ${item.id === selectedId ? 'selected' : ''}`} style={style(box)}>
        <span className="extract-tag">
          <button disabled={disabled} onClick={() => onSelect(item.id)}>{item.name}{item.boxes.length > 1 ? ` ${index + 1}` : ''}</button>
          {item.id === selectedId && !disabled && <button aria-label={`Remove box ${index + 1} from ${item.name}`} onClick={() => onRemoveBox(item.id, index)}><X size={10} /></button>}
        </span>
      </div>))}
    {drag && <div className="extract-box selected pending" style={style(normalized(drag))} />}
  </div>
}

export function WorldPanel({ state, ready, readyError, checking, onRefresh, onSettings }: {
  state: StudioState; ready?: WorldReadiness; readyError: string; checking: boolean; onRefresh: () => Promise<void>; onSettings: () => void
}) {
  const data = state.world
  const [request, setRequest] = useState<WorldRequest>(initial)
  const [input, setInput] = useState<'text' | 'image'>('text')
  const [id, setId] = useState(data.worlds[0]?.id ?? '')
  const [stage, setStage] = useState<Stage>('concept')
  const [config, setConfig] = useState<WorldConfig>(data.config)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [draft, setDraft] = useState<Draft[]>([])
  const [draftDirty, setDraftDirty] = useState(false)
  const [selectedItem, setSelectedItem] = useState<string>()
  const [layout, setLayout] = useState<Record<string, Transform[]>>({})
  const [layoutDirty, setLayoutDirty] = useState(false)
  const [selection, setSelection] = useState<Selection>()
  const viewport = useRef<SceneHandle>(null)

  const world: World | undefined = data.worlds.find(w => w.id === id)
  const active = data.worlds.find(w => w.status === 'running')
  const download = data.modelDownload
  const downloading = download?.status === 'running'
  const locked = busy || !!active || downloading
  const settingsDirty = configKeys.some(key => (config[key] ?? '') !== (data.config[key] ?? ''))
  const recovery = world?.status === 'failed' ? world.recovery : undefined
  const recovered = download?.status === 'complete' && download.package === recovery?.package
  const reference = data.references.find(r => r.id === request.referenceId)
  const free = Math.max(0, ...(ready?.devices.map(d => d.freeGB) ?? []))
  const references = world ? batchSummary(world.items, 'reference') : undefined
  const models = world ? batchSummary(world.items, 'model') : undefined

  useEffect(() => { setDraftDirty(false); setLayoutDirty(false); setSelection(undefined); setSelectedItem(undefined) }, [id])
  useEffect(() => { if (world && !draftDirty) setDraft(world.items.map(toDraft)) }, [world?.id, world?.items, draftDirty])
  useEffect(() => { if (world && !layoutDirty) setLayout(layoutOf(world.items)) }, [world?.id, world?.items, layoutDirty])

  async function perform(action: () => Promise<void>) {
    setBusy(true); setError(''); setNotice('')
    try { await action() } catch (e) { setError(explain(e)) } finally { setBusy(false) }
  }
  async function installModels(packageId: ModelPackage) {
    await perform(async () => {
      const installed = await window.studio.installModels(packageId)
      if (installed) { setConfig(installed); await onRefresh(); setNotice('Required models verified and selected. Retry the stage when ready.') }
    })
  }
  async function saveDraft() {
    if (!world || !draftDirty) return
    await window.studio.updateItems(world.id, draft.map(({ id, kind, name, description, quantity, boxes, approved }) => ({ id, kind, name: name.trim(), description: description.trim(), quantity, boxes, approved })))
    setDraftDirty(false)
  }
  function editDraft(itemId: string, change: Partial<Draft>) {
    setDraft(items => items.map(item => item.id === itemId ? { ...item, ...change } : item)); setDraftDirty(true)
  }
  async function runBatch(phase: ItemPhase, retry = false) {
    if (!world) return
    await perform(async () => { await saveDraft(); await window.studio.runBatch(world.id, phase, retry) })
  }
  async function itemAction(itemId: string, phase: ItemPhase, action: 'retry' | 'skip') {
    if (!world) return
    await perform(async () => { await saveDraft(); await window.studio.setItemPhase(world.id, itemId, phase, action) })
  }
  async function importItem(itemId: string, phase: ItemPhase) {
    if (!world) return
    await perform(async () => { await saveDraft(); if (await window.studio.importItem(world.id, itemId, phase)) setNotice('External file validated and imported for this item.') })
  }

  const stages: { key: Stage; label: string; detail: string; complete: boolean }[] = [
    { key: 'concept', label: 'World concept', detail: 'Location, props and art style', complete: !!world?.conceptUrl },
    { key: 'extract', label: 'Extract parts', detail: 'Mark props, isolate cutouts', complete: !!references?.total && references.done === references.total && references.complete > 0 },
    { key: 'batch', label: 'Batch 3D', detail: 'Static GLB per part', complete: !!models?.total && models.done === models.total && models.complete > 0 },
    { key: 'scene', label: 'Scene assembly', detail: 'Place, review and export', complete: !!world && sceneReady(world.items) }
  ]
  const entries = useMemo(() => (world?.items ?? []).filter(item => item.approved && item.modelStatus === 'complete' && item.modelUrl)
    .map(item => ({ id: item.id, name: item.name, url: item.modelUrl!, kind: item.kind, transforms: layout[item.id]?.length ? layout[item.id] : placeItem(item, world!.items.indexOf(item)) })), [world, layout])
  const selectedEntry = selection && entries.find(entry => entry.id === selection.itemId)
  const selectedTransform = selectedEntry?.transforms[selection!.index]
  function setTransform(target: Selection, change: Partial<Transform>) {
    setLayout(old => {
      const entry = entries.find(e => e.id === target.itemId)
      const transforms = (old[target.itemId]?.length ? old[target.itemId] : entry?.transforms ?? []).map(t => structuredClone(t))
      if (!transforms[target.index]) return old
      transforms[target.index] = { ...transforms[target.index], ...change }
      return { ...old, [target.itemId]: transforms }
    })
    setLayoutDirty(true)
  }
  async function saveLayout() {
    if (!world) return
    await window.studio.saveLayout(world.id, entries.map(entry => ({ itemId: entry.id, transforms: entry.transforms })))
    setLayoutDirty(false)
  }

  const selectedDraft = draft.find(item => item.id === selectedItem)
  const environment = draft.find(item => item.kind === 'environment')
  const propsDraft = draft.filter(item => item.kind === 'prop')
  const queueRefs = world ? world.items.filter(item => item.approved && ['pending', 'failed', 'cancelled'].includes(item.referenceStatus)).length : 0
  const queueModels = world ? world.items.filter(item => item.approved && item.referenceStatus === 'complete' && item.modelStatus === 'pending').length : 0
  const activeSummary = active?.job === 'references' ? batchSummary(active.items, 'reference') : active?.job === 'models' ? batchSummary(active.items, 'model') : undefined
  const displayError = error || (!recovered && world?.status === 'failed' ? world.message : '')
  const validBrief = request.location.trim().length >= 3 && request.style.trim().length >= 3 && request.props.every(p => p.name.trim() || !p.description.trim())
  const cleanRequest = (): WorldRequest => ({ ...request, props: request.props.filter(p => p.name.trim()).map(p => ({ ...p, name: p.name.trim(), description: p.description.trim() })), referenceId: input === 'image' ? request.referenceId : undefined })

  return <div id="world-panel" className="designer-layout">
    <aside className="design-brief">
      <div className="section-kicker">01 / DESCRIBE A WORLD</div>
      <h1>World builder</h1>
      <p className="panel-description">Describe a location and the props in it. Review the concept, extract every part, then batch-build static 3D models.</p>
      <div className="view-tabs design-input-tabs" role="group" aria-label="World input">
        <button aria-pressed={input === 'text'} disabled={locked} className={input === 'text' ? 'active' : ''} onClick={() => setInput('text')}>Text description</button>
        <button aria-pressed={input === 'image'} disabled={locked} className={input === 'image' ? 'active' : ''} onClick={() => setInput('image')}>Reference image</button>
      </div>
      {input === 'image' && <div className="design-reference">
        {reference && <img src={reference.url} alt={`Input reference: ${reference.name}`} />}
        <button className="secondary full" disabled={locked} onClick={() => void perform(async () => {
          const image = await window.studio.addReference()
          if (image) setRequest(old => ({ ...old, referenceId: image.id }))
        })}><ImagePlus size={16} /> {reference ? 'Replace local image' : 'Choose local image'}</button>
        <p className="fine-print">PNG, JPEG or WebP, up to 20 MB. Copied locally; sent only to your loopback ComfyUI. The image guides a newly generated concept.</p>
      </div>}
      <label className="field-label" htmlFor="world-title">World title <span>optional</span></label>
      <input id="world-title" disabled={locked} maxLength={100} placeholder="Harbor Market" value={request.title} onChange={e => setRequest({ ...request, title: e.target.value })} />
      <label className="field-label" htmlFor="world-location">World or location</label>
      <textarea id="world-location" disabled={locked} maxLength={2000} rows={4} placeholder="A sunny fishing harbor market on a wooden pier, stalls along the water, nets drying in the sea breeze..." value={request.location} onChange={e => setRequest({ ...request, location: e.target.value })} />
      <div className="field-label"><span className="props-label">Props in the scene</span><span>{request.props.filter(p => p.name.trim()).length} / {limits.props}</span></div>
      <div className="prop-rows">
        {request.props.map((prop, index) => <div className="prop-row" key={index}>
          <input aria-label={`Prop ${index + 1} name`} disabled={locked} maxLength={80} placeholder={['Wooden barrel', 'Fish stall', 'Lantern post'][index % 3]} value={prop.name}
            onChange={e => setRequest({ ...request, props: request.props.map((p, i) => i === index ? { ...p, name: e.target.value } : p) })} />
          <input aria-label={`Prop ${index + 1} quantity`} className="qty" disabled={locked} type="number" min={1} max={limits.quantity} value={prop.quantity}
            onChange={e => setRequest({ ...request, props: request.props.map((p, i) => i === index ? { ...p, quantity: Math.min(Math.max(Math.round(Number(e.target.value) || 1), 1), limits.quantity) } : p) })} />
          <button aria-label={`Remove prop ${index + 1}`} disabled={locked} onClick={() => setRequest({ ...request, props: request.props.filter((_, i) => i !== index) })}><X size={13} /></button>
          <input aria-label={`Prop ${index + 1} details`} className="details" disabled={locked} maxLength={300} placeholder="Details (optional): weathered oak, iron bands" value={prop.description}
            onChange={e => setRequest({ ...request, props: request.props.map((p, i) => i === index ? { ...p, description: e.target.value } : p) })} />
        </div>)}
      </div>
      <button className="text-button add-prop" disabled={locked || request.props.length >= limits.props} onClick={() => setRequest({ ...request, props: [...request.props, { name: '', description: '', quantity: 1 } satisfies PropSpec] })}><Plus size={14} /> Add prop</button>
      <label className="field-label" htmlFor="world-style">Art style</label>
      <textarea id="world-style" disabled={locked} maxLength={1000} rows={3} placeholder="Stylized low-poly game art, warm hand-painted textures, soft afternoon light..." value={request.style} onChange={e => setRequest({ ...request, style: e.target.value })} />
      <div className="two-fields design-sampling">
        <label>Seed<input aria-label="World seed" disabled={locked} type="number" min={0} max={4294967295} value={request.seed} onChange={e => setRequest({ ...request, seed: Number(e.target.value) })} /></label>
        <label>Image / 3D steps<input aria-label="World steps" disabled={locked} type="number" min={10} max={100} value={request.steps} onChange={e => setRequest({ ...request, steps: Number(e.target.value) })} /></label>
      </div>
      {input === 'image' && <>
        <label className="field-label" htmlFor="world-strength">Reference influence <span>{Math.round(request.referenceStrength * 100)}%</span></label>
        <input id="world-strength" type="range" min={0.1} max={0.6} step={0.05} disabled={locked} value={request.referenceStrength} onChange={e => setRequest({ ...request, referenceStrength: Number(e.target.value) })} />
      </>}
      <button className="primary full" disabled={locked || settingsDirty || !validBrief || input === 'image' && !reference} onClick={() => void perform(async () => {
        const created = await window.studio.create(cleanRequest())
        setId(created); setStage('concept')
        await window.studio.runConcept(created)
      })}><Sparkles size={16} /> Create world concept <ArrowRight size={16} /></button>
      <p className="fine-print">Each world keeps its own brief, seed, model settings, workflow files and per-item results. Completed items are never overwritten without an explicit retry.</p>
      <div className="design-entry brief-import">
        <span className="design-entry-label">Already have concept art?</span>
        <div className="design-entry-controls">
          <button className="secondary" disabled={locked} onClick={() => void perform(async () => {
            const imported = await window.studio.importConcept(cleanRequest())
            if (imported) { setId(imported); setStage('extract') }
          })}><ImagePlus size={15} /> Import concept image</button>
        </div>
        <p className="fine-print">Creates a new world from this brief using your image as the concept; generation is skipped.</p>
      </div>
      <div className="section-heading"><span className="section-kicker">SAVED WORLDS</span><span className="count">{data.worlds.length}</span></div>
      <div className="design-list">
        {data.worlds.map(item => {
          const s = batchSummary(item.items, 'model')
          return <button key={item.id} className={`asset ${item.id === id ? 'active' : ''}`} disabled={locked && item.id !== active?.id} onClick={() => {
            setId(item.id); setError(''); setNotice('')
            setStage(sceneReady(item.items) ? 'scene' : item.items.some(i => i.referenceStatus !== 'pending') ? 'batch' : item.conceptUrl ? 'extract' : 'concept')
          }}>
            <Mountain size={16} /><span><strong>{item.title || 'Untitled world'}</strong><small>{item.status === 'running' ? 'Generating' : item.status === 'failed' || item.status === 'cancelled' ? item.status :
              s.complete ? `${s.complete} of ${s.total} models ready` : item.conceptUrl ? `${item.items.length - 1} props / concept ready` : 'Concept not generated'}</small></span>
          </button>
        })}
        {!data.worlds.length && <p className="fine-print">Your worlds will appear here.</p>}
      </div>
    </aside>

    <main className="design-workspace">
      <div className="scene-heading"><div><span className="section-kicker">WORLD CANVAS</span><h2>{world?.title || 'A world waiting to happen'}</h2></div><Mountain size={21} /></div>
      <div className="design-stages">
        {stages.map((item, index) => <button key={item.key} className={`${stage === item.key ? 'selected' : ''} ${item.complete ? 'ready' : ''}`} onClick={() => { setStage(item.key); setError('') }} aria-pressed={stage === item.key}>
          <span className="step-number">{item.complete ? <Check size={13} /> : index + 1}</span><span><strong>{item.label}</strong><small>{item.detail}</small></span>
        </button>)}
      </div>

      {stage === 'concept' && <>
        {world?.conceptUrl && <p className="design-source">{world.conceptSource === 'imported' ? 'Imported concept image.' : 'Generated concept in your art style.'} {world.items.length - 1} listed props.</p>}
        <div className="design-canvas">
          {world?.conceptUrl ? <img src={world.conceptUrl} alt="World concept for review" /> :
            <div className="design-empty"><div className="design-empty-icon"><Mountain size={42} strokeWidth={1} /></div>
              <h2>Start with a place worth exploring.</h2>
              <p>Describe the location, list its props and pick an art style.<br />The concept shows everything together before it is taken apart.</p>
              <span>LOCAL MODELS / YOUR MACHINE</span>
            </div>}
        </div>
      </>}

      {stage === 'extract' && <>
        {!world?.conceptUrl ? <div className="design-canvas"><div className="design-empty"><div className="design-empty-icon"><ScanSearch size={42} strokeWidth={1} /></div>
          <h2>Every prop, on its own.</h2><p>Generate or import a concept first. Then mark each prop, or detect them with a local vision model, and extract isolated cutouts.</p><span>ANALYSIS / EXTRACTION</span></div></div> :
          <div className="extract-layout">
            <div className="extract-canvas">
              <ExtractCanvas url={world.conceptUrl} items={draft} selectedId={selectedItem} disabled={locked}
                onSelect={setSelectedItem}
                onDraw={box => selectedDraft && editDraft(selectedDraft.id, { boxes: [...selectedDraft.boxes, box], quantity: Math.max(selectedDraft.quantity, selectedDraft.boxes.length + 1) })}
                onRemoveBox={(itemId, index) => { const item = draft.find(i => i.id === itemId); if (item) editDraft(itemId, { boxes: item.boxes.filter((_, i) => i !== index) }) }} />
              <p className="fine-print">{selectedDraft?.kind === 'prop' ? `Drag on the concept to mark "${selectedDraft.name}". The first box is cropped and isolated; extra boxes place more instances.` :
                'Select a prop in the list, then drag a box around it. Props without a box are generated from text in the same art style.'}</p>
              <div className="design-actions">
                <button className="secondary" disabled={locked} onClick={() => void perform(async () => { await saveDraft(); await window.studio.detect(world.id) })}><ScanSearch size={15} /> Detect props (local vision)</button>
                <button className="secondary" disabled={locked || !draftDirty} onClick={() => void perform(async () => { await saveDraft(); setNotice('Extraction list saved.') })}><Save size={15} /> Save extraction list</button>
                {draftDirty && <button className="text-button" disabled={locked} onClick={() => { setDraftDirty(false); setDraft(world.items.map(toDraft)) }}><RotateCcw size={14} /> Discard edits</button>}
              </div>
              {ready?.visionError && <p className="fine-print">{ready.visionError}</p>}
              <details className="design-edit-instruction"><summary>Extraction instructions sent to the edit model</summary>
                <p><strong>Prop crop:</strong> {propIsolatePrompt(selectedDraft?.kind === 'prop' ? selectedDraft : { name: '<prop name>', description: '' })}</p>
                <p><strong>Environment base:</strong> {environmentPrompt(propsDraft.filter(p => p.approved))}</p>
                <p>The world brief is not resent for crops. Every output passes BiRefNet background removal and a transparency check before 3D.</p>
              </details>
            </div>
            <div className="item-list" aria-label="Extraction list">
              <div className="section-heading"><span className="section-kicker">PARTS TO EXTRACT</span><span className="count">{draft.filter(i => i.approved).length} approved</span></div>
              {[...(environment ? [environment] : []), ...propsDraft].map(item => {
                const saved = world.items.find(i => i.id === item.id)
                return <div key={item.id} className={`world-item ${item.id === selectedItem ? 'selected' : ''} ${item.approved ? '' : 'rejected'}`} onClick={() => setSelectedItem(item.id)}>
                  <div className="world-item-head">
                    {saved?.referenceUrl ? <img className="thumb cutout" src={saved.referenceUrl} alt={`${item.name} cutout`} /> : <span className="thumb">{item.kind === 'environment' ? <Layers size={16} /> : <BoxIcon size={16} />}</span>}
                    <div>
                      <input aria-label={`${item.kind === 'environment' ? 'Environment' : 'Prop'} name`} disabled={locked} maxLength={80} value={item.name} onChange={e => editDraft(item.id, { name: e.target.value })} />
                      <small>{item.kind === 'environment' ? 'Environment base: props removed' : `${saved?.origin ?? 'manual'} / ${item.boxes.length ? `${item.boxes.length} box${item.boxes.length > 1 ? 'es' : ''}` : 'text only'}`}</small>
                    </div>
                    {item.kind === 'prop' && <input aria-label={`${item.name} quantity`} className="qty" disabled={locked} type="number" min={1} max={limits.quantity} value={item.quantity}
                      onChange={e => editDraft(item.id, { quantity: Math.min(Math.max(Math.round(Number(e.target.value) || 1), 1), limits.quantity) })} />}
                  </div>
                  {saved && <div className="world-item-status"><StatusChip status={saved.referenceStatus} phase="reference" />{saved.referenceMessage && <small>{saved.referenceMessage}</small>}</div>}
                  <div className="world-item-actions">
                    <label className="include"><input type="checkbox" disabled={locked} checked={item.approved} onChange={e => editDraft(item.id, { approved: e.target.checked })} /> Include</label>
                    {item.kind === 'prop' && item.boxes.length > 0 && <button className="text-button" disabled={locked} onClick={() => editDraft(item.id, { boxes: [] })}><Eraser size={12} /> Clear boxes</button>}
                    {saved && ['failed', 'cancelled', 'complete'].includes(saved.referenceStatus) && <button className="text-button" disabled={locked} onClick={() => void itemAction(item.id, 'reference', 'retry')}><RefreshCw size={12} /> Retry</button>}
                    {saved && ['failed', 'cancelled', 'pending'].includes(saved.referenceStatus) && <button className="text-button" disabled={locked} onClick={() => void itemAction(item.id, 'reference', 'skip')}><SkipForward size={12} /> Skip</button>}
                    {saved && <button className="text-button" disabled={locked} onClick={() => void importItem(item.id, 'reference')}><ImagePlus size={12} /> Import cutout</button>}
                    {item.kind === 'prop' && <button className="text-button danger" aria-label={`Remove ${item.name}`} disabled={locked} onClick={() => { setDraft(items => items.filter(i => i.id !== item.id)); setDraftDirty(true) }}><Trash2 size={12} /></button>}
                  </div>
                </div>
              })}
              <button className="secondary full" disabled={locked || propsDraft.length >= limits.props} onClick={() => {
                const next: Draft = { id: `new-${crypto.randomUUID()}`, kind: 'prop', name: 'New prop', description: '', quantity: 1, boxes: [], approved: true }
                setDraft(items => [...items, next]); setDraftDirty(true); setSelectedItem(next.id)
              }}><Plus size={14} /> Add prop</button>
            </div>
          </div>}
      </>}

      {stage === 'batch' && <>
        {!world || !world.items.some(item => item.referenceStatus === 'complete') ? <div className="design-canvas"><div className="design-empty"><div className="design-empty-icon"><BoxIcon size={42} strokeWidth={1} /></div>
          <h2>From cutouts to dimension.</h2><p>Approve the extracted cutouts, then generate one static GLB per part in a single sequential batch.</p><span>NO RIGGING / NO ANIMATION</span></div></div> :
          <div className="batch-grid" aria-label="3D batch queue">
            {world.items.filter(item => item.approved).map(item => <div key={item.id} className={`batch-tile ${item.modelStatus} ${world.activeItemId === item.id ? 'active' : ''}`}>
              {item.referenceUrl ? <img className="cutout" src={item.referenceUrl} alt={`${item.name} reference`} /> : <span className="tile-empty"><ImagePlus size={20} /></span>}
              <div className="batch-tile-body">
                <strong>{item.name}{item.kind === 'environment' && <span> environment</span>}{item.quantity > 1 && <span> x{item.quantity}</span>}</strong>
                {item.referenceStatus !== 'complete' ? <StatusChip status={item.referenceStatus} phase="reference" /> : <StatusChip status={item.modelStatus} phase="model" />}
                <small>{item.referenceStatus !== 'complete' ? 'Needs an approved cutout first.' : item.modelMessage ?? (item.modelTextured ? 'Textured' : '')}</small>
                <div className="world-item-actions">
                  {item.referenceStatus === 'complete' && ['failed', 'cancelled', 'complete'].includes(item.modelStatus) && <button className="text-button" disabled={locked} onClick={() => void itemAction(item.id, 'model', 'retry')}><RefreshCw size={12} /> Retry</button>}
                  {item.referenceStatus === 'complete' && ['failed', 'cancelled', 'pending'].includes(item.modelStatus) && <button className="text-button" disabled={locked} onClick={() => void itemAction(item.id, 'model', 'skip')}><SkipForward size={12} /> Skip</button>}
                  <button className="text-button" disabled={locked} onClick={() => void importItem(item.id, 'model')}><BoxIcon size={12} /> Import GLB</button>
                </div>
              </div>
            </div>)}
          </div>}
      </>}

      {stage === 'scene' && <>
        {world && entries.length ? <div className="scene-layout">
          <div className="design-canvas mesh"><SceneViewport ref={viewport} entries={entries} selected={selection} onSelect={setSelection} onMove={(target, position) => setTransform(target, { position })} /></div>
          <div className="scene-inspector">
            <div className="section-heading"><span className="section-kicker">SCENE OBJECTS</span><span className="count">{entries.reduce((s, e) => s + e.transforms.length, 0)}</span></div>
            <div className="instance-list">
              {entries.flatMap(entry => entry.transforms.map((_, index) => <button key={`${entry.id}-${index}`} className={`asset ${selection?.itemId === entry.id && selection.index === index ? 'active' : ''}`} onClick={() => setSelection({ itemId: entry.id, index })}>
                {entry.kind === 'environment' ? <Layers size={14} /> : <BoxIcon size={14} />}<span><strong>{entry.name}{entry.transforms.length > 1 ? ` ${index + 1}` : ''}</strong></span>
              </button>))}
            </div>
            {selection && selectedTransform ? <>
              <div className="three-fields">
                {(['X', 'Y', 'Z'] as const).map((axis, i) => <label key={axis}>{axis} (m)<input type="number" step={0.1} value={selectedTransform.position[i]} onChange={e => {
                  const position = [...selectedTransform.position] as Transform['position']; position[i] = Number(e.target.value) || 0; setTransform(selection, { position })
                }} /></label>)}
              </div>
              <div className="two-fields">
                <label>Rotation (deg)<input type="number" step={5} value={Math.round(selectedTransform.rotationY * 180 / Math.PI)} onChange={e => setTransform(selection, { rotationY: (Number(e.target.value) || 0) * Math.PI / 180 })} /></label>
                <label>Size (m)<input type="number" step={0.1} min={0.01} value={selectedTransform.scale} onChange={e => setTransform(selection, { scale: Math.max(0.01, Number(e.target.value) || 0.01) })} /></label>
              </div>
            </> : <p className="fine-print">Select an object in the viewport or list to move, rotate or resize it. Positions start from each prop's box in the concept.</p>}
          </div>
        </div> : <div className="design-canvas"><div className="design-empty"><div className="design-empty-icon"><Layers size={42} strokeWidth={1} /></div>
          <h2>Put the world back together.</h2><p>Completed models appear here, placed approximately where they stood in the concept. Adjust them, then export the scene.</p><span>GLB / JSON MANIFEST</span></div></div>}
      </>}

      {active && <div className="job-progress" role="status"><LoaderCircle size={18} className="spin" /><div>
        <strong>{active.job === 'references' ? 'EXTRACTING PARTS' : active.job === 'models' ? 'BATCH 3D' : active.job === 'detect' ? 'DETECTING PROPS' : 'WORLD CONCEPT'}{active.id !== world?.id ? ` / ${active.title}` : ''}</strong>
        <p>{active.message}</p>
        {activeSummary && <div className="progress-track"><span style={{ width: `${activeSummary.total ? (activeSummary.done + activeSummary.failed) / activeSummary.total * 100 : 0}%` }} /></div>}
      </div><button onClick={() => void window.studio.cancel().catch(e => setError(explain(e)))}>Cancel job</button></div>}
      {displayError && <div className="banner error design-recovery" role="alert"><CircleAlert size={17} /><div>
        <p>{displayError}</p>
        <div className="design-recovery-actions">
          {recovery?.package && !recovered && <button className="secondary" disabled={locked || settingsDirty} onClick={() => void installModels(recovery.package!)}><ArrowDownToLine size={15} /> Download required models</button>}
          <button className="secondary" disabled={locked} onClick={() => document.getElementById('image-profile')?.focus()}>Review model settings</button>
          <button className="text-button" onClick={onSettings}>Backend connections</button>
        </div>
        {recovery?.package && !recovered && <p className="fine-print">{modelPackages[recovery.package].label}. Review the download size and model terms before approving. {settingsDirty && 'Save model choices first.'}</p>}
      </div></div>}
      {download && <div className={`banner ${download.status === 'failed' ? 'error' : download.status === 'complete' ? 'success' : ''} design-download`} role="status">
        {downloading ? <LoaderCircle size={17} className="spin" /> : <ArrowDownToLine size={17} />}
        <div><p>{download.message}</p>
          {downloading && download.totalBytes > 0 && <><progress aria-label="Model download progress" value={download.receivedBytes} max={download.totalBytes} /><span>{(download.receivedBytes / 2 ** 30).toFixed(2)} / {(download.totalBytes / 2 ** 30).toFixed(2)} GiB</span></>}
          {downloading && <button className="secondary" onClick={() => void window.studio.cancel().catch(e => setError(explain(e)))}>Cancel download</button>}
        </div>
      </div>}
      {notice && <div className="banner success" role="status"><Check size={17} /><span>{notice}</span></div>}
      {world && world.status !== 'running' && world.status !== 'failed' && world.message !== notice && <p className="design-status">{world.message}</p>}

      {world && <div className="design-actions">
        {stage === 'concept' && !world.conceptUrl && <button className="primary" disabled={locked || settingsDirty} onClick={() => void perform(() => window.studio.runConcept(world.id))}><RefreshCw size={15} /> Generate concept</button>}
        {stage === 'concept' && world.conceptUrl && <button className="primary" disabled={locked} onClick={() => setStage('extract')}><Check size={15} /> Use concept & extract parts <ArrowRight size={15} /></button>}
        {stage === 'extract' && world.conceptUrl && <button className="primary" disabled={locked || settingsDirty || (!queueRefs && !draftDirty)} onClick={() => void runBatch('reference')}>
          <ScanSearch size={15} /> Extract {queueRefs || ''} {queueRefs === 1 ? 'part' : 'parts'} <ArrowRight size={15} /></button>}
        {stage === 'extract' && !!references?.failed && <button className="secondary" disabled={locked || settingsDirty} onClick={() => void runBatch('reference', true)}><RefreshCw size={15} /> Retry failed</button>}
        {stage === 'extract' && !!references?.complete && <button className="secondary" disabled={locked} onClick={() => setStage('batch')}>Review cutouts in Batch 3D <ArrowRight size={15} /></button>}
        {stage === 'batch' && <button className="primary" disabled={locked || settingsDirty || !queueModels} onClick={() => void runBatch('model')}><BoxIcon size={15} /> Generate {queueModels || ''} {queueModels === 1 ? 'model' : 'models'} <ArrowRight size={15} /></button>}
        {stage === 'batch' && !!(models?.failed || models?.cancelled) && <button className="secondary" disabled={locked || settingsDirty} onClick={() => void runBatch('model', true)}><RefreshCw size={15} /> Retry failed</button>}
        {stage === 'batch' && sceneReady(world.items) && <button className="secondary" disabled={locked} onClick={() => setStage('scene')}>Assemble scene <ArrowRight size={15} /></button>}
        {stage === 'scene' && entries.length > 0 && <>
          <button className="primary" disabled={locked} onClick={() => void perform(async () => {
            if (layoutDirty) await saveLayout()
            const glb = await viewport.current?.exportGlb()
            const path = await window.studio.exportBundle(world.id, glb)
            if (path) setNotice(`Exported scene.glb, every model, cutouts and world.json to ${path}`)
          })}><FolderOutput size={15} /> Export scene bundle</button>
          <button className="secondary" disabled={locked || !layoutDirty} onClick={() => void perform(async () => { await saveLayout(); setNotice('Scene layout saved.') })}><Save size={15} /> Save layout</button>
          <button className="text-button" disabled={locked} onClick={() => {
            setLayout(Object.fromEntries(world.items.map((item, index) => [item.id, placeItem(item, index)]))); setLayoutDirty(true)
          }}><RotateCcw size={14} /> Reset placement</button>
        </>}
        <button className="text-button" disabled={locked} onClick={() => {
          setRequest({ ...world.request, title: world.title, props: world.items.filter(i => i.kind === 'prop').map(i => ({ name: i.name, description: i.description.slice(0, 300), quantity: i.quantity })) })
          setInput(world.request.referenceId ? 'image' : 'text'); setNotice('Brief copied, including the extraction list. Change the seed or descriptions, then create a new world.'); setError('')
        }}><Plus size={14} /> Use brief for variation</button>
        <button className="text-button danger" disabled={locked} onClick={() => {
          if (confirm(`Delete "${world.title}" and all of its generated files?`)) void perform(async () => { await window.studio.remove(world.id); setId('') })
        }}><Trash2 size={14} /> Delete world</button>
      </div>}
      <div className="design-limits"><ShieldCheck size={17} /><p>Review each stage before continuing. 3D uses only validated transparent cutouts, never the full concept. Each prop and the environment base become separate <strong>static</strong> meshes: no rigging, skinning or animation. Generated models are approximations; review unseen sides, scale and placement before export.</p></div>
    </main>

    <aside className="design-models">
      <div className="section-heading"><span className="section-kicker">LOCAL MODEL PROFILES</span><button aria-label="Refresh local models" disabled={checking || locked} onClick={() => void onRefresh()}><RefreshCw size={14} className={checking ? 'spin' : ''} /></button></div>
      <h2>Built around your GPU</h2>
      <div className="design-hardware">
        {ready?.devices.map(device => <div key={device.name}><strong>{device.freeGB.toFixed(1)} GB available</strong><p>{device.totalGB.toFixed(1)} GB reported total</p><small>{device.name}</small></div>)}
        {!ready && <p>{checking ? 'Reading local ComfyUI hardware...' : readyError ? `ComfyUI is not reachable. ${readyError}` : 'Start local ComfyUI, then refresh models.'}</p>}
        {ready && !ready.devices.length && <p>No supported GPU reported. CPU-only generation is not supported.</p>}
      </div>
      <label className="field-label" htmlFor="image-profile">Image model family</label>
      <select id="image-profile" disabled={locked} value={config.imageProfile} onChange={e => setConfig({ ...config, imageProfile: e.target.value as WorldConfig['imageProfile'], checkpoint: '' })}>
        {Object.entries(imageProfiles).map(([key, profile]) => <option key={key} value={key}>{profile.label} / ~{profile.gb} GB{ready && free < profile.gb ? ' / low memory' : ''}</option>)}
      </select>
      <p className="fine-print">{imageProfiles[config.imageProfile].size}px concepts and text-only props. {config.imageProfile === 'sd15' ? 'Lower-memory option; use an SD 1.5 checkpoint such as DreamShaper 8.' : 'Higher-resolution option; requires an SDXL checkpoint.'}</p>
      <label className="field-label" htmlFor="image-checkpoint">Installed image checkpoint</label>
      <select id="image-checkpoint" disabled={locked} value={config.checkpoint} onChange={e => setConfig({ ...config, checkpoint: e.target.value })}>
        <option value="">Select compatible local weights</option>
        {config.checkpoint && !ready?.checkpoints.includes(config.checkpoint) && <option value={config.checkpoint}>{config.checkpoint} (unavailable)</option>}
        {ready?.checkpoints.filter(name => !/hunyuan|flux|sd3/i.test(name)).map(name => <option key={name}>{name}</option>)}
      </select>
      <div className="panel-rule" />
      <h2>Part extraction</h2>
      <p className="fine-print">{editProfile.label}. Isolates each marked prop from its crop and removes props from the environment base. About {editProfile.gb + 2} GB GPU memory including background removal; {editProfile.steps} distilled steps.</p>
      {([
        { key: 'editModel', label: 'Edit model', names: ready?.diffusionModels ?? [] },
        { key: 'editTextEncoder', label: 'Edit text encoder', names: ready?.textEncoders ?? [] },
        { key: 'editVae', label: 'Edit autoencoder', names: ready?.vaes ?? [] }
      ] as const).map(({ key, label, names }) => <div key={key}>
        <label className="field-label" htmlFor={`world-${key}`}>{label}</label>
        <select id={`world-${key}`} disabled={locked} value={config[key] ?? ''} onChange={e => setConfig({ ...config, [key]: e.target.value })}>
          <option value="">Select installed local weights</option>
          {config[key] && !names.includes(config[key]) && <option value={config[key]}>{config[key]} (unavailable)</option>}
          {names.map(name => <option key={name}>{name}</option>)}
        </select>
      </div>)}
      <label className="field-label" htmlFor="world-background">Background removal <span>required</span></label>
      <select id="world-background" disabled={locked} value={config.backgroundModel ?? ''} onChange={e => setConfig({ ...config, backgroundModel: e.target.value })}>
        <option value="">Select local BiRefNet weights</option>
        {config.backgroundModel && !ready?.backgroundModels.includes(config.backgroundModel) && <option value={config.backgroundModel}>{config.backgroundModel} (unavailable)</option>}
        {ready?.backgroundModels.map(name => <option key={name}>{name}</option>)}
      </select>
      <label className="field-label" htmlFor="world-vision">Prop detection <span>optional / Ollama</span></label>
      <select id="world-vision" disabled={locked} value={config.visionModel} onChange={e => setConfig({ ...config, visionModel: e.target.value })}>
        <option value="">Draw prop boxes by hand</option>
        {config.visionModel && !ready?.visionModels.includes(config.visionModel) && <option value={config.visionModel}>{config.visionModel} (unavailable)</option>}
        {ready?.visionModels.map(name => <option key={name}>{name}</option>)}
      </select>
      <p className="fine-print">Optional local vision model on 127.0.0.1:11434 (for example Qwen 2.5 VL) proposes prop boxes. Cloud and remote models are rejected. Boxes are always reviewable.</p>
      <div className="panel-rule" />
      <label className="field-label" htmlFor="mesh-profile">3D model profile</label>
      <select id="mesh-profile" disabled={locked} value={config.meshProfile} onChange={e => setConfig({ ...config, meshProfile: e.target.value as WorldConfig['meshProfile'] })}>
        {Object.entries(meshProfiles).map(([key, profile]) => <option key={key} value={key}>{profile.label} / ~{profile.gb} GB{ready && free < profile.gb ? ' / low memory' : ''}</option>)}
      </select>
      {config.meshProfile === 'textured' ? <>
        <p className="fine-print">New textured mesh per part: {meshTextureProfile.textureSize}px material atlas, target {meshTextureProfile.faceCount.toLocaleString()} faces. Missing weights or textures are errors, not geometry-only fallbacks.</p>
        {([
          { key: 'meshTextureModel', label: 'Textured 3D model', names: ready?.diffusionModels ?? [] },
          { key: 'meshVision', label: '3D vision encoder', names: ready?.clipVision ?? [] },
          { key: 'meshShapeVae', label: '3D shape decoder', names: ready?.vaes ?? [] },
          { key: 'meshTextureVae', label: '3D texture decoder', names: ready?.vaes ?? [] }
        ] as const).map(({ key, label, names }) => <div key={key}>
          <label className="field-label" htmlFor={`world-${key}`}>{label}</label>
          <select id={`world-${key}`} disabled={locked} value={config[key] ?? ''} onChange={e => setConfig({ ...config, [key]: e.target.value })}>
            <option value="">Select installed local weights</option>
            {config[key] && !names.includes(config[key]) && <option value={config[key]}>{config[key]} (unavailable)</option>}
            {names.map(name => <option key={name}>{name}</option>)}
          </select>
        </div>)}
      </> : <>
        <label className="field-label" htmlFor="mesh-checkpoint">Installed 3D checkpoint</label>
        <select id="mesh-checkpoint" disabled={locked} value={config.meshCheckpoint} onChange={e => setConfig({ ...config, meshCheckpoint: e.target.value })}>
          <option value="">Select single-view Hunyuan3D 2 weights</option>
          {config.meshCheckpoint && !ready?.checkpoints.includes(config.meshCheckpoint) && <option value={config.meshCheckpoint}>{config.meshCheckpoint} (unavailable)</option>}
          {ready?.checkpoints.filter(name => /hunyuan/i.test(name)).map(name => <option key={name}>{name}</option>)}
        </select>
        <p className="fine-print">Geometry only, untextured. Every approved part is generated one after another in the shared job slot.</p>
      </>}
      <button className="secondary full" disabled={locked || !settingsDirty} onClick={() => void perform(async () => { await window.studio.saveConfig(config); setNotice('Local model choices saved.') })}><Check size={15} /> Save model choices</button>
      {settingsDirty && <p className="fine-print">Save model choices before generating.</p>}
      <details className="design-setup"><summary>Model setup & offline requirements</summary>
        <p>Missing-model errors offer Download required models for BiRefNet, FLUX.2 klein editing, DreamShaper 8 / SDXL, Hunyuan3D 2 and TRELLIS.2. Approve the size and source, then World Studio verifies the pinned hashes and selects the files. Retry generation yourself after setup. No Python packages are changed.</p>
        <p>Concept checkpoints go in models\checkpoints. Part extraction uses {editProfile.model} in models\diffusion_models, {editProfile.textEncoder} in models\text_encoders, {editProfile.vae} in models\vae, and BiRefNet in models\background_removal.</p>
        <p>Memory budgets are conservative estimates, not compatibility guarantees. Batches run sequentially, one ComfyUI prompt at a time.</p>
      </details>
      <button className="text-button full" onClick={onSettings}>Backend connections</button>
    </aside>
  </div>
}
