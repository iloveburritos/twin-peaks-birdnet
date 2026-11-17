// Species descriptions from Wikipedia, shaped into a short field-guide card.
//
// A JavaScript port of Avian Visitors' wiki.php by Teddy Warner
// (CC BY-NC-SA 4.0): the same requests, sentence selection and length
// budgets. Only complete source sentences are ever used - nothing is clipped
// or rewritten. Wikipedia text is CC BY-SA 4.0, so every response carries its
// source link for attribution.

const UA = 'BirdsOfTwinPeaks/1.0 (+https://github.com/iloveburritos/twin-peaks-birdnet)';
const API = 'https://en.wikipedia.org/w/api.php?';

const BODY_LINE_MEASURE = 50;
const MARK_LINE_MEASURE = 54;
const MAX_ESTIMATED_LINES = 17;
const MAX_MAIN_CHARS = 575;

const len = (s) => [...s].length;

function cleanLead(value) {
  return String(value)
    .replace(/\(\s*\)/gu, '')
    .replace(/[\t  ]+/gu, ' ')
    .replace(/ *(?:\r\n|\r|\n)+ */gu, '\n')
    .trim();
}

function sentences(value) {
  const flat = String(value).trim().replace(/(?:\r\n|\r|\n)+/gu, ' ');
  if (!flat) return [];
  return flat
    .split(/(?:(?<=[.!?])|(?<=[.!?]["”’')\]]))\s+(?=["“‘'(]?[A-Z0-9])/u)
    .map((p) => p.trim())
    .filter(Boolean);
}

function isComplete(value) {
  if (/(?:\.{3}|…)\s*["”’')\]]*$/u.test(value)) return false;
  return /[.!?]\s*["”’')\]]*$/u.test(value);
}

function supplement(expanded, lead) {
  expanded = cleanLead(expanded);
  lead = cleanLead(lead);
  if (!expanded || !lead || !expanded.startsWith(lead)) return '';
  const remainder = expanded.slice(lead.length).trim();
  if (!remainder) return '';
  const body = remainder.split(/(?:\r\n|\r|\n)+/u).map((l) => l.trim()).filter((line) =>
    line && !(len(line) <= 80 && !/[.!?]["”’')\]]*$/u.test(line)));
  return sentences(body.join(' ')).filter(isComplete).join(' ');
}

function decodeEntities(s) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—' };
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return named[e.toLowerCase()] ?? m;
  });
}

async function getJson(url) {
  const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' } });
  if (!res.ok) throw new Error(`wikipedia ${res.status}`);
  return res.json();
}

function query(params) {
  return API + new URLSearchParams({ format: 'json', formatversion: '2', redirects: '1', ...params });
}

async function descriptionSection(title) {
  const sj = await getJson(query({ action: 'parse', prop: 'sections', page: title })).catch(() => null);
  const list = sj?.parse?.sections;
  if (!Array.isArray(list)) return '';
  let index = null;
  for (const heading of ['description', 'identification', 'appearance']) {
    const hit = list.find((s) => decodeEntities(String(s.line || '').replace(/<[^>]*>/g, '')).trim().toLowerCase() === heading);
    if (hit) { index = String(hit.index || ''); break; }
  }
  if (!index) return '';
  const tj = await getJson(query({
    action: 'parse', prop: 'text', page: title, section: index, disableeditsection: '1', disabletoc: '1',
  })).catch(() => null);
  let html = tj?.parse?.text;
  if (html && typeof html === 'object') html = html['*'];
  if (typeof html !== 'string' || !html) return '';
  for (const tag of ['sup', 'style', 'script', 'table', 'figure']) {
    html = html.replace(new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}>`, 'gi'), '');
  }
  const paragraphs = [];
  for (const m of html.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)) {
    let text = decodeEntities(m[1].replace(/<[^>]*>/g, ''));
    text = cleanLead(text.replace(/\[\s*\d+(?:\s*[-,]\s*\d+)*\s*\]/gu, ''));
    if (text) paragraphs.push(text);
  }
  return paragraphs.join('\n');
}

function fieldGuideParagraphs(lead, excluded = []) {
  lead = cleanLead(lead);
  const skip = new Set(excluded);
  const all = sentences(lead).filter((s) => !skip.has(s));
  const count = all.length;
  if (count <= 1) return all;

  const sourceParagraphs = lead.split(/(?:\r\n|\r|\n)+/u).filter(Boolean);
  const firstSourceIsIntro = sourceParagraphs.length > 1 && sentences(sourceParagraphs[0]).length === 1;

  const intro = [all[0]];
  let cursor = 1;
  let introLength = len(all[0]);
  if (!firstSourceIsIntro && count > 2 && introLength < 150) {
    const withSecond = introLength + 1 + len(all[1]);
    if (withSecond <= 285) { intro.push(all[1]); introLength = withSecond; cursor = 2; }
  }

  const detail = [];
  let detailLength = 0;
  let skippedMinorVagrancy = false;
  for (; cursor < count; cursor++) {
    const sentence = all[cursor];
    const minorVagrancy = len(sentence) <= 140 &&
      /(?:\b(?:rare|occasional(?:ly)?)\b[^.!?]{0,90}\bvagrant\b|\bvagrant\b[^.!?]{0,90}\b(?:rare|occasional(?:ly)?)\b)/iu.test(sentence);
    if (minorVagrancy && count - cursor - 1 >= 2) { skippedMinorVagrancy = true; continue; }
    if (skippedMinorVagrancy && detail.length >= 2) break;
    const nextDetailLength = detailLength + (detail.length ? 1 : 0) + len(sentence);
    const nextTotalLength = introLength + 2 + nextDetailLength;
    if (detail.length >= 2 && nextDetailLength > 380) break;
    if (detail.length >= 2 && nextTotalLength > 700 && introLength + 2 + detailLength >= 430) break;
    detail.push(sentence);
    detailLength = nextDetailLength;
    if (detail.length >= 2 && detailLength >= 360 && introLength + 2 + detailLength >= 430) break;
  }
  if (!detail.length && cursor < count) detail.push(all[cursor]);
  return [intro.join(' '), detail.join(' ')];
}

function fitCard(paragraphs, distinctive) {
  const groups = paragraphs.slice(0, 2).map((p) => sentences(p).filter(isComplete));
  while (groups.length < 2) groups.push([]);
  const marks = distinctive.filter(isComplete);
  const values = () => groups.map((g) => g.join(' '));
  const mainLength = () => len(values().filter(Boolean).join(' '));
  const lines = () => {
    let n = 0;
    for (const p of values()) if (p) n += Math.ceil(len(p) / BODY_LINE_MEASURE);
    const m = marks.join(' ');
    if (m) n += Math.ceil(len(m) / MARK_LINE_MEASURE);
    return n;
  };
  while (mainLength() > MAX_MAIN_CHARS || lines() > MAX_ESTIMATED_LINES) {
    if (groups[0].length > 1) { groups[0].pop(); continue; }
    if (mainLength() > MAX_MAIN_CHARS && groups[1].length > 1) { groups[1].pop(); continue; }
    if (marks.length > 1) { marks.pop(); continue; }
    if (groups[1].length > 1) { groups[1].pop(); continue; }
    break;
  }
  return { paragraphs: values().filter(Boolean), distinctive: marks };
}

const COMPARISON = /\b(?:males?|females?|adults?|juveniles?|immatures?|both sexes|in flight)\b/iu;

function fieldMarks(source) {
  const list = sentences(cleanLead(source)).filter(isComplete);
  const count = (re, s) => (s.match(re) || []).length;
  const candidates = [];
  list.forEach((sentence, index) => {
    const anatomy = count(/\b(?:plumage|underparts?|upperparts?|breasts?|bell(?:y|ies)|throats?|crowns?|caps?|foreheads?|napes?|heads?|necks?|shoulders?|faces?|cheeks?|masks?|eyes?|eye[ -]?rings?|bills?|beaks?|tails?|wings?|wingbars?|feathers?|crests?|backs?|flanks?|legs?|feet|patch(?:es)?|markings?)\b/giu, sentence);
    const appearance = count(/\b(?:black|white|gr[ae]y|brown|reddish|red|orange|yellow|golden|olive|blue|green|buff|rufous|pink|purple|pale|dark|bright|glossy|iridescent|streaked|striped|barred|spotted|mottled|long|short|slender|stocky)\b/giu, sentence);
    const recognition = count(/\b(?:distinguish(?:ed|able)?|identif(?:ied|iable)|recogniz(?:ed|able)|characteri[sz]ed|distinctive|prominent|noticeable|field mark)\b/giu, sentence);
    if (!anatomy || (!appearance && !recognition)) return;
    let score = Math.min(4, anatomy) * 3 + Math.min(4, appearance) + Math.min(2, recognition) * 3;
    if (/\b(?:males?|females?|adults?|juveniles?|immatures?|in flight)\b/iu.test(sentence)) score += 2;
    if (len(sentence) <= 330) score += 1;
    candidates.push({ index, score, sentence });
  });
  if (!candidates.length) return [];
  candidates.sort((a, b) => b.score - a.score || a.index - b.index);
  const chosen = [candidates[0]];
  if (list.length <= 3) return [candidates[0].sentence];
  const remaining = candidates.slice(1);
  outer: for (const comparisonPass of [true, false]) {
    for (const c of remaining) {
      if (c.score < 6) continue;
      if (len(chosen[0].sentence) + 1 + len(c.sentence) > 440) continue;
      const adds = COMPARISON.test(c.sentence);
      if (comparisonPass !== adds) continue;
      if (!adds && Math.abs(c.index - chosen[0].index) > 1) continue;
      chosen.push(c);
      break outer;
    }
  }
  chosen.sort((a, b) => a.index - b.index);
  return chosen.map((c) => c.sentence);
}

export async function speciesAbout(sci) {
  const j = await getJson(query({
    action: 'query', prop: 'extracts', exintro: '1', explaintext: '1', titles: sci,
  }));
  const page = j?.query?.pages?.[0];
  if (!page || page.missing) return { paragraphs: [], distinctive: null, source: null };
  const extract = typeof page.extract === 'string' ? cleanLead(page.extract) : null;
  const title = typeof page.title === 'string' ? page.title : null;
  let about = extract || '';
  const initialLength = len(about ? fieldGuideParagraphs(about).join(' ') : '');

  if (title && extract && initialLength < 360) {
    const ej = await getJson(query({
      action: 'query', prop: 'extracts', explaintext: '1', exsectionformat: 'plain', exchars: '1200', titles: title,
    })).catch(() => null);
    const more = supplement(ej?.query?.pages?.[0]?.extract || '', extract);
    if (more) about += '\n' + more;
  }
  if (title && about && !fieldMarks(about).length) {
    const section = await descriptionSection(title);
    if (section) about += '\n' + section;
  }

  let marks = about ? fieldMarks(about) : [];
  let paragraphs = about ? fieldGuideParagraphs(about, marks) : [];
  if (paragraphs.filter(Boolean).length < 2) {
    marks = [];
    paragraphs = about ? fieldGuideParagraphs(about) : [];
  }
  const fitted = fitCard(paragraphs, marks);
  return {
    paragraphs: fitted.paragraphs,
    distinctive: fitted.distinctive.length ? fitted.distinctive.join(' ') : null,
    source: title ? {
      name: 'Wikipedia',
      url: 'https://en.wikipedia.org/wiki/' + encodeURIComponent(title.replace(/ /g, '_')).replace(/%2F/g, '/'),
      license: 'CC BY-SA 4.0',
    } : null,
  };
}
