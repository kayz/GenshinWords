import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { Chapter } from '../shared/models';
import { getContentDbPath, getImagePath } from './paths';

interface ScopedArtwork {
  avatar: string; subject: string; file_path: string; source_page: string;
  character_metadata: string | null;
}
let cachedKey = '';
let cachedArtwork = new Map<string, ScopedArtwork[]>();
// This reclining pose places the face below the usual upper-body focus.
const characterFocus: Record<string, { x: number; y: number }> = {
  '10000140': { x: .8, y: .55 },
};
export function clearVoiceArtworkCache(): void { cachedKey = ''; cachedArtwork = new Map(); }
function tableExists(db: Database.Database, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}
function scopedArtwork(): Map<string, ScopedArtwork[]> {
  const file = path.join(path.dirname(getContentDbPath()), 'materials.db');
  if (!fs.existsSync(file)) return new Map();
  const stat = fs.statSync(file), key = file + ':' + stat.size + ':' + stat.mtimeMs;
  if (cachedKey === key) return cachedArtwork;
  const result = new Map<string, ScopedArtwork[]>();
  let db: Database.Database | undefined;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true });
    db.pragma('query_only = ON');
    if (tableExists(db, 'artwork') && tableExists(db, 'artwork_scopes')) {
      const withCharacters = tableExists(db, 'collections');
      const rows = db.prepare(
        "SELECT s.scope_id AS avatar,a.subject,a.file_path,a.source_page," +
        (withCharacters ? 'c.metadata_json' : 'NULL') + " AS character_metadata FROM artwork a " +
        "JOIN artwork_scopes s ON s.artwork_id=a.id " +
        (withCharacters ? "LEFT JOIN collections c ON c.id='character:'||s.scope_id " : '') +
        "WHERE s.scope_kind='character' AND a.kind='official_character_desktop' " +
        "AND a.width>=a.height AND a.width>=1024 ORDER BY a.id"
      ).all() as ScopedArtwork[];
      for (const row of rows) { const list = result.get(row.avatar) || []; list.push(row); result.set(row.avatar, list); }
    }
  } catch { /* Older or unavailable optional artwork metadata falls back to the same character's portrait. */ }
  finally { db?.close(); }
  cachedKey = key; cachedArtwork = result; return result;
}
function nameKey(value: string): string { return value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, ''); }
function sameCharacter(chapter: Chapter, artwork: ScopedArtwork): boolean {
  const name = nameKey(chapter.title_en || '');
  if (!name) return false;
  const alias = artwork.avatar === '10000125' ? ['columbina', 'columbinahyposelenia'] : [];
  const subject = nameKey(artwork.subject);
  if (subject !== name && !(alias.includes(name) && alias.includes(subject))) return false;
  if (artwork.character_metadata) {
    try { const character = JSON.parse(artwork.character_metadata); if (nameKey(character.name || '') !== name) return false; }
    catch { return false; }
  }
  return true;
}
function localImage(relativePath: string): boolean {
  try { return fs.statSync(getImagePath(relativePath)).isFile(); } catch { return false; }
}
/** View-layer replacement only: chapter IDs and source records are never changed.
 * The 122 bundled voice chapters were checked against avatar metadata: -id is the
 * matching avatar ID. Fixed Aether/Lumine chapters keep their own portraits. */
export function voiceChapterArtwork(chapter: Chapter, content: Database.Database | null): Chapter {
  if (chapter.type !== 'voice') return chapter;
  if (Number.isSafeInteger(chapter.id) && chapter.id < 0) {
    for (const artwork of scopedArtwork().get(String(-chapter.id)) || []) {
      if (!sameCharacter(chapter, artwork) || !artwork.file_path.startsWith('images/') ||
        !/^https:\/\/genshin\.hoyoverse\.com\//i.test(artwork.source_page)) continue;
      const relativePath = artwork.file_path.slice('images/'.length);
      if (localImage(relativePath)) return { ...chapter, cover_path: relativePath,
        cover_match: 'official_character_desktop_verified', cover_source_url: artwork.source_page,
        cover_focus: characterFocus[artwork.avatar] ?? { x: .5, y: .35 } };
    }
  }
  if (content && tableExists(content, 'speakers')) {
    const columns = new Set((content.prepare('PRAGMA table_info(speakers)').all() as Array<{ name: string }>).map(row => row.name));
    if (columns.has('image_kind') && columns.has('image_path')) {
      const source = columns.has('image_source_url') ? 'image_source_url' : 'NULL AS image_source_url';
      const portrait = content.prepare("SELECT image_path," + source + " FROM speakers WHERE name IN (?,?) " +
        "AND image_kind='portrait' AND image_path IS NOT NULL ORDER BY CASE WHEN name=? THEN 0 ELSE 1 END LIMIT 1")
        .get(chapter.title_en, chapter.title_chs, chapter.title_en) as { image_path: string; image_source_url: string | null } | undefined;
      if (portrait?.image_path && localImage(portrait.image_path)) return { ...chapter,
        cover_path: portrait.image_path, cover_match: 'same_character_portrait_fallback',
        cover_source_url: portrait.image_source_url, cover_focus: { x: .5, y: .3 } };
    }
  }
  return { ...chapter, cover_path: null, cover_match: null, cover_source_url: null, cover_focus: undefined };
}
