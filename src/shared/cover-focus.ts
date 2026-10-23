/** Source focal coordinates and CSS object-position use different coordinate systems. */
export function coverObjectPosition(width: number, height: number, focus: { x: number; y: number }, ratio = 4): { x: number; y: number } {
  const clamp = (value: number) => Math.max(0, Math.min(1, Number.isFinite(value) ? value : .5));
  if (!(width > 0 && height > 0 && ratio > 0)) return { x: .5, y: .5 };
  const cropHeight = Math.min(height, width / ratio), cropWidth = cropHeight * ratio;
  const position = (length: number, crop: number, value: number) => length <= crop ? .5
    : clamp((length * clamp(value) - crop / 2) / (length - crop));
  return { x: position(width, cropWidth, focus.x), y: position(height, cropHeight, focus.y) };
}
