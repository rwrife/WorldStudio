export function validateCutout(bitmap: Uint8Array, width: number, height: number): void {
  if (width < 64 || height < 64 || bitmap.length !== width * height * 4)
    throw new Error('Cutout is invalid or too small for 3D generation.')
  let foreground = 0, transparent = 0
  const margin = Math.max(2, Math.floor(Math.min(width, height) * 0.005))
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const alpha = bitmap[(y * width + x) * 4 + 3]
    if (alpha <= 8) transparent++
    if (alpha > 16) {
      foreground++
      if (x < margin || y < margin || x >= width - margin || y >= height - margin)
        throw new Error('Cutout touches the image border. Regenerate with the entire object and a clear margin; cropped objects or retained scenery are not valid 3D inputs.')
    }
  }
  const pixels = width * height
  if (foreground < pixels * 0.01 || transparent < pixels * 0.15 || foreground > pixels * 0.8)
    throw new Error('Background removal did not produce a usable transparent cutout. Opaque backgrounds, empty masks and retained scenery are blocked.')
}
