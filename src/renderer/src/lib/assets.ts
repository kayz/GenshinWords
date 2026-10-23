const images = new Map<string, Promise<string | null>>();

export function localImage(path?: string | null): Promise<string | null> {
  if (!path) return Promise.resolve(null);
  const existing = images.get(path);
  if (existing) return existing;
  const oldest = images.keys().next().value;
  if (images.size >= 100 && oldest !== undefined) images.delete(oldest);
  const request = window.api.imageDataUrl(path).catch((error) => {
    images.delete(path);
    throw error;
  });
  images.set(path, request);
  return request;
}
