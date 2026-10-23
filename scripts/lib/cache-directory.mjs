import fs from 'node:fs/promises';
import path from 'node:path';
// Raw snapshots contain thousands of small files; keep them outside the synced repository.
export async function externalCacheDirectory(value, project) {
    if (!path.isAbsolute(value)) throw Error('The cache directory must be an absolute path outside the repository');
    await fs.mkdir(value, { recursive: true });
    const canonical = await fs.realpath(value);
    const base = await fs.realpath(project);
    const relative = path.relative(base, canonical);
    if (!relative || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep))) {
        throw Error('Keep acquisition caches outside the project repository');
    }
    return canonical;
}
