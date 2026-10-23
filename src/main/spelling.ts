export function normalizeAnswer(value: string) {
  return value.normalize('NFKC').trim().toLowerCase()
    .replace(/[’‘]/g, "'").replace(/[‐‑–]/g, '-').replace(/\s+/g, ' ');
}

// 只使用明确的拼写对，不做 our/or、ise/ize 等全局字符串替换。
const pairs = [
  ['analyse', 'analyze'], ['paralyse', 'paralyze'], ['organise', 'organize'],
  ['recognise', 'recognize'], ['realise', 'realize'], ['apologise', 'apologize'],
  ['criticise', 'criticize'], ['emphasise', 'emphasize'], ['summarise', 'summarize'],
  ['memorise', 'memorize'], ['specialise', 'specialize'], ['characterise', 'characterize'],
  ['harbour', 'harbor'], ['colour', 'color'], ['favour', 'favor'],
  ['favourite', 'favorite'], ['honour', 'honor'], ['humour', 'humor'],
  ['labour', 'labor'], ['neighbour', 'neighbor'], ['behaviour', 'behavior'],
  ['flavour', 'flavor'], ['rumour', 'rumor'], ['odour', 'odor'],
  ['centre', 'center'], ['theatre', 'theater'], ['litre', 'liter'], ['fibre', 'fiber'],
  ['defence', 'defense'], ['offence', 'offense'],
  ['grey', 'gray'], ['cosy', 'cozy'], ['jewellery', 'jewelry'],
  ['traveller', 'traveler'], ['colourful', 'colorful'], ['neighbourhood', 'neighborhood'],
];
const families = new Map<string, { lemmas: string[]; forms: Map<string, string[]> }>();
function regularForms(lemma: string) {
  return [lemma, lemma + 's', lemma.endsWith('e') ? lemma + 'd' : lemma + 'ed',
    (lemma.endsWith('e') ? lemma.slice(0, -1) : lemma) + 'ing'];
}
for (const [uk, us] of pairs) {
  const forms = new Map<string, string[]>();
  const ukForms = regularForms(uk);
  const usForms = regularForms(us);
  ukForms.forEach((form, i) => {
    const variants = [form, usForms[i]];
    forms.set(form, variants);
    forms.set(usForms[i], variants);
  });
  const family = { lemmas: [uk, us], forms };
  families.set(uk, family);
  families.set(us, family);
}
const travelForms = new Map<string, string[]>();
for (const pair of [['travelled', 'traveled'], ['travelling', 'traveling']]) {
  for (const form of pair) travelForms.set(form, pair);
}
families.set('travel', { lemmas: ['travel'], forms: travelForms });

export function lemmaSpellings(lemma: string): string[] {
  const normalized = normalizeAnswer(lemma);
  return families.get(normalized)?.lemmas ?? [normalized];
}
export function equivalentSpellings(surface: string, lemma: string): string[] {
  const normalized = normalizeAnswer(surface);
  // 与目标词绑定，例如 analysis 的复数 analyses 不等同于动词 analyzes。
  return families.get(normalizeAnswer(lemma))?.forms.get(normalized) ?? [normalized];
}

export function lookupSpellings(surface: string): string[] {
  const normalized = normalizeAnswer(surface);
  const forms = new Set([normalized]);
  for (const family of families.values()) for (const form of family.forms.get(normalized) ?? []) forms.add(form);
  return [...forms];
}
