import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react'
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { TransformControls } from 'three/addons/controls/TransformControls.js'
import { LoaderCircle } from 'lucide-react'
import type { Transform } from '../shared/world'
import { sceneSize } from '../shared/scene'

export interface SceneEntry { id: string; name: string; url: string; kind: 'environment' | 'prop'; transforms: Transform[] }
export interface Selection { itemId: string; index: number }
export interface SceneHandle { exportGlb(): Promise<Uint8Array> }
interface Props {
  entries: SceneEntry[]
  selected?: Selection
  onSelect: (selection?: Selection) => void
  onMove: (selection: Selection, position: [number, number, number]) => void
  ref?: Ref<SceneHandle>
}

const round = (value: number) => Math.round(value * 1000) / 1000
const loader = new GLTFLoader()
const templates = new Map<string, Promise<THREE.Object3D>>()

/** Load once per URL and normalize to unit max dimension with the base centred on y = 0. */
function template(url: string) {
  let pending = templates.get(url)
  if (!pending) {
    pending = loader.loadAsync(url).then(gltf => {
      const model = gltf.scene
      const bounds = new THREE.Box3().setFromObject(model)
      const size = bounds.getSize(new THREE.Vector3()), center = bounds.getCenter(new THREE.Vector3())
      const scale = 1 / Math.max(size.x, size.y, size.z, 1e-6)
      model.scale.setScalar(scale)
      model.position.set(-center.x * scale, -bounds.min.y * scale, -center.z * scale)
      model.traverse(object => { if (object instanceof THREE.Mesh) { object.castShadow = true; object.receiveShadow = true } })
      const root = new THREE.Group()
      root.add(model)
      return root
    })
    pending.catch(() => templates.delete(url))
    templates.set(url, pending)
  }
  return pending
}

export function SceneViewport({ entries, selected, onSelect, onMove, ref }: Props) {
  const host = useRef<HTMLDivElement>(null)
  const latest = useRef({ selected, onSelect, onMove })
  latest.current = { selected, onSelect, onMove }
  const world = useRef<THREE.Group>(undefined)
  const gizmo = useRef<TransformControls>(undefined)
  const outline = useRef<THREE.BoxHelper>(undefined)
  const [loading, setLoading] = useState(0)
  const [error, setError] = useState('')

  useImperativeHandle(ref, () => ({
    async exportGlb() {
      if (!world.current) throw new Error('The scene is not ready yet.')
      const result = await new GLTFExporter().parseAsync(world.current, { binary: true, onlyVisible: true })
      if (!(result instanceof ArrayBuffer)) throw new Error('Scene export did not produce binary GLB data.')
      return new Uint8Array(result)
    }
  }), [])

  useEffect(() => {
    if (!host.current) return
    const scene = new THREE.Scene()
    scene.background = new THREE.Color('#1a1714')
    scene.fog = new THREE.Fog('#1a1714', sceneSize * 2.2, sceneSize * 5)
    const camera = new THREE.PerspectiveCamera(40, 1, 0.05, 400)
    camera.position.set(sceneSize * 0.9, sceneSize * 0.75, sceneSize * 1.1)
    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true })
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.15
    renderer.shadowMap.enabled = true
    host.current.appendChild(renderer.domElement)
    const controls = new OrbitControls(camera, renderer.domElement)
    controls.target.set(0, 1, 0)
    controls.enableDamping = true
    controls.maxPolarAngle = Math.PI * 0.49
    controls.minDistance = 1
    controls.maxDistance = sceneSize * 6
    scene.add(new THREE.HemisphereLight('#fff1e0', '#3b2c1f', 2.2))
    const sun = new THREE.DirectionalLight('#ffe0bd', 3)
    sun.position.set(sceneSize * 0.6, sceneSize * 1.2, sceneSize * 0.4)
    sun.castShadow = true
    sun.shadow.mapSize.set(2048, 2048)
    Object.assign(sun.shadow.camera, { left: -sceneSize, right: sceneSize, top: sceneSize, bottom: -sceneSize, far: sceneSize * 4 })
    scene.add(sun)
    const grid = new THREE.GridHelper(sceneSize * 2, 40, '#6b4b2c', '#2f2822')
    grid.position.y = -0.002
    scene.add(grid)
    const content = new THREE.Group()
    content.name = 'World'
    world.current = content
    scene.add(content)
    const box = new THREE.BoxHelper(new THREE.Object3D(), '#ff9a3c')
    box.visible = false
    outline.current = box
    scene.add(box)
    const transform = new TransformControls(camera, renderer.domElement)
    transform.setSize(0.8)
    transform.showY = false
    transform.addEventListener('dragging-changed', event => { controls.enabled = !event.value })
    transform.addEventListener('objectChange', () => {
      const object = transform.object, current = latest.current.selected
      if (object && current) latest.current.onMove(current, [round(object.position.x), round(object.position.y), round(object.position.z)])
      box.update()
    })
    gizmo.current = transform
    scene.add(transform.getHelper())

    const raycaster = new THREE.Raycaster()
    let down = { x: 0, y: 0 }
    const press = (event: PointerEvent) => { down = { x: event.clientX, y: event.clientY } }
    const release = (event: PointerEvent) => {
      if (transform.dragging || Math.hypot(event.clientX - down.x, event.clientY - down.y) > 4) return
      const rect = renderer.domElement.getBoundingClientRect()
      raycaster.setFromCamera(new THREE.Vector2((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1), camera)
      const hit = raycaster.intersectObjects(content.children, true)[0]
      let object: THREE.Object3D | null = hit?.object ?? null
      while (object && !object.userData.itemId) object = object.parent
      latest.current.onSelect(object ? { itemId: object.userData.itemId, index: object.userData.index } : undefined)
    }
    renderer.domElement.addEventListener('pointerdown', press)
    renderer.domElement.addEventListener('pointerup', release)
    const resize = new ResizeObserver(([entry]) => {
      camera.aspect = entry.contentRect.width / Math.max(1, entry.contentRect.height)
      camera.updateProjectionMatrix()
      renderer.setSize(entry.contentRect.width, entry.contentRect.height)
    })
    resize.observe(host.current)
    let frame = 0
    const animate = () => {
      frame = requestAnimationFrame(animate)
      controls.update()
      renderer.render(scene, camera)
    }
    animate()
    return () => {
      cancelAnimationFrame(frame)
      resize.disconnect()
      transform.detach(); transform.dispose(); controls.dispose()
      renderer.domElement.removeEventListener('pointerdown', press)
      renderer.domElement.removeEventListener('pointerup', release)
      renderer.dispose()
      renderer.domElement.remove()
      world.current = undefined
    }
  }, [])

  const latestEntries = useRef(entries)
  latestEntries.current = entries
  function applyTransforms() {
    const content = world.current
    if (!content) return
    for (const instance of content.children) {
      const entry = latestEntries.current.find(e => e.id === instance.userData.itemId)
      const transform = entry?.transforms[instance.userData.index]
      if (!transform) continue
      instance.position.set(...transform.position)
      instance.rotation.y = transform.rotationY
      instance.scale.setScalar(transform.scale)
    }
    if (outline.current?.visible && gizmo.current?.object) outline.current.setFromObject(gizmo.current.object)
  }
  // Rebuild only when the set of models or instance counts changes; transform edits update in place so gizmo drags survive.
  const structure = entries.map(entry => `${entry.id}:${entry.url}:${entry.transforms.length}`).join('|')
  useEffect(() => {
    const content = world.current
    if (!content) return
    let stale = false
    setLoading(count => count + 1)
    const current = latestEntries.current
    Promise.allSettled(current.map(entry => template(entry.url))).then(results => {
      if (stale) return
      gizmo.current?.detach()
      content.clear()
      const failed: string[] = []
      current.forEach((entry, entryIndex) => {
        const result = results[entryIndex]
        if (result.status === 'rejected') { failed.push(entry.name); return }
        entry.transforms.forEach((_, index) => {
          const instance = result.value.clone(true)
          instance.name = entry.transforms.length > 1 ? `${entry.name} ${index + 1}` : entry.name
          instance.userData = { itemId: entry.id, index }
          content.add(instance)
        })
      })
      applyTransforms()
      setError(failed.length ? `Could not load: ${failed.join(', ')}. Re-import or regenerate these models.` : '')
      highlight()
    }).finally(() => setLoading(count => count - 1))
    return () => { stale = true }
  }, [structure])
  useEffect(applyTransforms, [entries])

  function highlight() {
    const content = world.current, transform = gizmo.current, box = outline.current
    if (!content || !transform || !box) return
    const current = latest.current.selected
    const target = current && content.children.find(child => child.userData.itemId === current.itemId && child.userData.index === current.index)
    if (target) {
      if (transform.object !== target) transform.attach(target)
      box.setFromObject(target); box.visible = true
    } else { transform.detach(); box.visible = false }
  }
  useEffect(highlight, [selected?.itemId, selected?.index])

  return <div className="scene-viewport">
    <div className="webgl" ref={host} />
    <div className="viewport-meta"><span>ASSEMBLED SCENE</span><span className="view-format">{entries.reduce((sum, entry) => sum + entry.transforms.length, 0)} INSTANCES / {sceneSize} M FOOTPRINT</span></div>
    <div className="viewport-hint">Click a model to select it, drag the arrows to move it on the ground. Orbit with left drag, pan with right drag.</div>
    {loading > 0 && <div className="viewport-notice"><LoaderCircle size={14} className="spin" /> Loading models</div>}
    {error && <div className="viewport-error" role="alert">{error}</div>}
  </div>
}
