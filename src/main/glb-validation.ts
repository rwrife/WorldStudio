import { readFile } from 'node:fs/promises'
import { crc32, inflateSync } from 'node:zlib'

interface TextureReference { index: number; texCoord?: number }
interface Gltf {
  asset?: { version?: string }
  buffers?: { uri?: string; byteLength: number }[]
  images?: { uri?: string; bufferView?: number; mimeType?: string }[]
  textures?: { source?: number }[]
  materials?: { pbrMetallicRoughness?: { baseColorTexture?: TextureReference; metallicRoughnessTexture?: TextureReference } }[]
  bufferViews?: { buffer: number; byteOffset?: number; byteLength: number; byteStride?: number }[]
  accessors?: { bufferView?: number; byteOffset?: number; componentType: number; count: number; type: string; normalized?: boolean }[]
  nodes?: { mesh?: number }[]
  meshes?: { primitives: { attributes: Record<string, number>; material?: number }[] }[]
}

function parseGlb(bytes: Buffer) {
  if (bytes.length < 20 || bytes.readUInt32LE(0) !== 0x46546c67 || bytes.readUInt32LE(4) !== 2 ||
      bytes.readUInt32LE(8) !== bytes.length || bytes.readUInt32LE(16) !== 0x4e4f534a)
    throw new Error('Model is not a complete binary glTF 2 file.')
  const length = bytes.readUInt32LE(12)
  if (length > bytes.length - 20) throw new Error('Truncated GLB JSON chunk.')
  return { gltf: JSON.parse(bytes.subarray(20, 20 + length).toString()) as Gltf, bytes, binaryOffset: 20 + length }
}

function validateAtlas(bytes: Buffer, size: number) {
  const fail = () => new Error(`Textured generation requires a complete embedded ${size}x${size} PNG atlas.`)
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
      bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR' ||
      bytes.readUInt32BE(16) !== size || bytes.readUInt32BE(20) !== size ||
      bytes[24] !== 8 || bytes[26] !== 0 || bytes[27] !== 0 || bytes[28] !== 0)
    throw fail()
  const channels = ({ 0: 1, 2: 3, 4: 2, 6: 4 } as Record<number, number | undefined>)[bytes[25]]
  if (!channels) throw fail()
  const data: Buffer[] = []
  let offset = 8, ended = false
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset)
    if (length > bytes.length - offset - 12) throw fail()
    const type = bytes.toString('ascii', offset + 4, offset + 8)
    if (crc32(bytes.subarray(offset + 4, offset + 8 + length)) !== bytes.readUInt32BE(offset + 8 + length)) throw fail()
    if (type === 'IDAT') data.push(bytes.subarray(offset + 8, offset + 8 + length))
    offset += length + 12
    if (type === 'IEND') { ended = length === 0 && offset === bytes.length; break }
  }
  if (!ended || !data.length) throw fail()
  const stride = size * channels + 1, expected = size * stride
  const pixels = inflateSync(Buffer.concat(data), { maxOutputLength: expected })
  if (pixels.length !== expected) throw fail()
  for (let y = 0; y < size; y++) if (pixels[y * stride] > 4) throw fail()
}

export async function validateModelGlb(path: string, requiredTextureSize?: number): Promise<boolean> {
  return validateGlbBytes(await readFile(path), requiredTextureSize)
}

/** Validates a static, embedded GLB. Returns whether every primitive carries a base-color texture. */
export function validateGlbBytes(bytes: Buffer, requiredTextureSize?: number): boolean {
  const { gltf, binaryOffset } = parseGlb(bytes)
  if (gltf.asset?.version !== '2.0' || gltf.buffers?.length !== 1 || gltf.buffers[0].uri ||
      gltf.images?.some(image => image.uri) || binaryOffset + 8 > bytes.length ||
      bytes.readUInt32LE(binaryOffset + 4) !== 0x004e4942 ||
      binaryOffset + 8 + bytes.readUInt32LE(binaryOffset) !== bytes.length ||
      gltf.buffers[0].byteLength > bytes.readUInt32LE(binaryOffset))
    throw new Error('GLB must contain complete embedded geometry without external resources.')
  const nodes = gltf.nodes?.filter(node => node.mesh !== undefined) ?? []
  if (!nodes.length) throw new Error('Model contains no mesh geometry.')
  let textured = true
  for (const node of nodes) {
    const primitives = gltf.meshes?.[node.mesh!]?.primitives
    if (!primitives?.length) throw new Error('Model has no mesh primitives.')
    for (const primitive of primitives) {
      const position = gltf.accessors?.[primitive.attributes.POSITION]
      const view = position?.bufferView === undefined ? undefined : gltf.bufferViews?.[position.bufferView]
      const stride = view?.byteStride ?? 12
      const offset = (view?.byteOffset ?? 0) + (position?.byteOffset ?? 0)
      if (!position || position.type !== 'VEC3' || position.componentType !== 5126 || !Number.isSafeInteger(position.count) || position.count < 3 ||
          !view || view.buffer !== 0 || !Number.isSafeInteger(offset) || offset < 0 || stride < 12 ||
          (position.byteOffset ?? 0) + (position.count - 1) * stride + 12 > view.byteLength ||
          (view.byteOffset ?? 0) + view.byteLength > gltf.buffers[0].byteLength)
        throw new Error('Model has incomplete vertex geometry.')
      const material = primitive.material === undefined ? undefined : gltf.materials?.[primitive.material]?.pbrMetallicRoughness
      if (!material?.baseColorTexture) {
        textured = false
        if (requiredTextureSize) throw new Error('Textured generation completed without base-color textures. A plain mesh is not a completed textured result.')
        continue
      }
      if (requiredTextureSize && !material.metallicRoughnessTexture) throw new Error('Textured generation completed without its metallic/roughness material map.')
      for (const texture of [material.baseColorTexture, material.metallicRoughnessTexture]) {
        if (!texture) continue
        const uv = gltf.accessors?.[primitive.attributes[`TEXCOORD_${texture.texCoord ?? 0}`]]
        const uvView = uv?.bufferView === undefined ? undefined : gltf.bufferViews?.[uv.bufferView]
        const componentSize = uv?.componentType === 5126 ? 4 : uv?.normalized && uv.componentType === 5123 ? 2 : uv?.normalized && uv.componentType === 5121 ? 1 : 0
        const uvStride = uvView?.byteStride ?? componentSize * 2
        if (!uv || uv.type !== 'VEC2' || uv.count !== position.count || !componentSize || !uvView ||
            uvView.buffer !== 0 || !Number.isSafeInteger(uvView.byteOffset ?? 0) || (uvView.byteOffset ?? 0) < 0 ||
            !Number.isSafeInteger(uv.byteOffset ?? 0) || (uv.byteOffset ?? 0) < 0 ||
            !Number.isSafeInteger(uvStride) || uvStride < componentSize * 2 ||
            (uv.byteOffset ?? 0) + (uv.count - 1) * uvStride + componentSize * 2 > uvView.byteLength ||
            (uvView.byteOffset ?? 0) + uvView.byteLength > gltf.buffers[0].byteLength)
          throw new Error('Textured model has missing or incomplete UV coordinates.')
        const imageId = gltf.textures?.[texture.index]?.source
        const image = imageId === undefined ? undefined : gltf.images?.[imageId]
        const imageView = image?.bufferView === undefined ? undefined : gltf.bufferViews?.[image.bufferView]
        const imageOffset = imageView?.byteOffset ?? 0
        if (!image || !imageView || imageView.buffer !== 0 || !Number.isSafeInteger(imageOffset) || imageOffset < 0 ||
            !Number.isSafeInteger(imageView.byteLength) || imageView.byteLength < 24 ||
            imageOffset + imageView.byteLength > gltf.buffers[0].byteLength)
          throw new Error('Textured model has no complete embedded material image.')
        if (requiredTextureSize) {
          const encoded = bytes.subarray(binaryOffset + 8 + imageOffset, binaryOffset + 8 + imageOffset + imageView.byteLength)
          if (image.mimeType !== 'image/png') throw new Error('Generated texture atlas must be an embedded PNG.')
          validateAtlas(encoded, requiredTextureSize)
        }
      }
    }
  }
  return textured
}

