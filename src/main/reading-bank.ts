import { activeReadingUnits, activeLegacyReadingUnits, ensureReadingPackages } from './reading-package-store';
import type { ReadingDefinition } from './reading-bank-types';
export type { ReadingDefinition, BankQuestion } from './reading-bank-types';

/** Stable, lazy array facades keep historical callers compatible without touching app paths at import. */
function catalog(source: ReadingDefinition[]): ReadingDefinition[] {
  return new Proxy(source, {
    get(target, property, receiver) {
      ensureReadingPackages();
      return Reflect.get(target, property, receiver);
    },
    ownKeys(target) { ensureReadingPackages(); return Reflect.ownKeys(target); },
  });
}
export const READING_BANK = catalog(activeReadingUnits);
export const LEGACY_READING_BANK = catalog(activeLegacyReadingUnits);
