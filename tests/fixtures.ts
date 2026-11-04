/** Minimal valid static GLB: one untextured triangle with embedded geometry. */
export function triangleGlb(extra: Record<string, unknown> = {}): Buffer {
  const positions = Buffer.alloc(36)
  ;[0, 0, 0, 1, 0, 0, 0, 1, 0].forEach((value, index) => positions.writeFloatLE(value, index * 4))
  const gltf = {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }], buffers: [{ byteLength: 36 }], ...extra
  }
  let json = Buffer.from(JSON.stringify(gltf))
  json = Buffer.concat([json, Buffer.alloc((4 - json.length % 4) % 4, 0x20)])
  const header = Buffer.alloc(12), jsonHeader = Buffer.alloc(8), binHeader = Buffer.alloc(8)
  header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(12 + 8 + json.length + 8 + positions.length, 8)
  jsonHeader.writeUInt32LE(json.length, 0); jsonHeader.writeUInt32LE(0x4e4f534a, 4)
  binHeader.writeUInt32LE(positions.length, 0); binHeader.writeUInt32LE(0x004e4942, 4)
  return Buffer.concat([header, jsonHeader, json, binHeader, positions])
}
