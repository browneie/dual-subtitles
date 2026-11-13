// Dual Subtitles — a Stremio addon that merges two subtitle languages into one track.
//
// This file is the whole addon, written against standard web APIs (fetch/Request/Response),
// and is run locally by server.js.

const UPSTREAM = "https://opensubtitles-v3.strem.io";
const MAX_VARIANTS = 3;
const MAX_CANDIDATES = 5; // files per language considered when pairing

// OpenSubtitles language codes, as used by the OpenSubtitles v3 addon.
export const LANGS = {
  eng: "English", zh: "Chinese (any)", chi: "Chinese (Simplified)", zht: "Chinese (Traditional)",
  zhe: "Chinese (bilingual)", jpn: "Japanese", kor: "Korean", spa: "Spanish",
  spl: "Spanish (Latin America)", fre: "French", ger: "German", ita: "Italian", por: "Portuguese",
  pob: "Portuguese (Brazil)", rus: "Russian", ara: "Arabic", hin: "Hindi", ben: "Bengali",
  urd: "Urdu", tur: "Turkish", vie: "Vietnamese", tha: "Thai", ind: "Indonesian", may: "Malay",
  tgl: "Tagalog", per: "Persian", heb: "Hebrew", ell: "Greek", nld: "Dutch", swe: "Swedish",
  nor: "Norwegian", dan: "Danish", fin: "Finnish", pol: "Polish", cze: "Czech", slo: "Slovak",
  hun: "Hungarian", ron: "Romanian", bul: "Bulgarian", hrv: "Croatian", srp: "Serbian",
  bos: "Bosnian", slv: "Slovenian", mac: "Macedonian", alb: "Albanian", ukr: "Ukrainian",
  est: "Estonian", lav: "Latvian", lit: "Lithuanian", cat: "Catalan", baq: "Basque",
  glg: "Galician", ice: "Icelandic", tam: "Tamil", tel: "Telugu", mal: "Malayalam",
};
// Some languages appear under more than one code upstream. Earlier codes are preferred.
const ALIASES = {
  zh: ["chi", "zho", "zhs", "zht", "zhe"], chi: ["chi", "zho", "zhs"],
  ell: ["ell", "gre"], ron: ["ron", "rum"], nld: ["nld", "dut"], srp: ["srp", "scc"],
};
const codesFor = (c) => ALIASES[c] || [c];

// ---------- parsing ----------

function toMs(t) {
  const m = t.trim().match(/(?:(\d+):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})/);
  if (!m) return null;
  const [, h = 0, mi, s, ms] = m;
  return ((+h * 60 + +mi) * 60 + +s) * 1000 + +ms.padEnd(3, "0");
}

function fromMs(ms) {
  ms = Math.max(0, Math.round(ms));
  const p = (n, w = 2) => String(Math.floor(n)).padStart(w, "0");
  return `${p(ms / 3600000)}:${p((ms / 60000) % 60)}:${p((ms / 1000) % 60)},${p(ms % 1000, 3)}`;
}

const stripTags = (l) => l.replace(/<[^>]+>/g, "");

function cleanLine(l) {
  return l
    .replace(/\{\\[^}]*\}/g, "") // ASS override tags like {\an8}
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .trim();
}

export function parseSubs(raw) {
  const text = raw.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const cues = [];
  for (const block of text.split(/\n\s*\n/)) {
    const lines = block.split("\n");
    const i = lines.findIndex((l) => l.includes("-->"));
    if (i < 0) continue;
    const [a, b] = lines[i].split("-->");
    const start = toMs(a), end = toMs(b);
    if (start == null || end == null || end <= start) continue;
    const body = lines.slice(i + 1).map(cleanLine)
      .filter((l) => /[\p{L}\p{N}]/u.test(stripTags(l))); // drop empty / "-" / "&nbsp;" lines
    if (body.length) cues.push({ start, end, lines: body });
  }
  return cues.sort((x, y) => x.start - y.start);
}

// ---------- scripts (to drop the duplicate language in "bilingual" files) ----------

const SCRIPTS = [
  ["cjk", /[぀-ヿ㐀-鿿가-힯豈-﫿]/],
  ["cyrillic", /[Ѐ-ӿ]/], ["arabic", /[؀-ۿ]/], ["hebrew", /[֐-׿]/],
  ["greek", /[Ͱ-Ͽ]/], ["thai", /[฀-๿]/], ["indic", /[ऀ-෿]/],
  ["latin", /[A-Za-zÀ-ɏ]/],
];
const scriptOf = (l) => (SCRIPTS.find(([, re]) => re.test(stripTags(l))) || [null])[0];

function scriptShares(cues) {
  const n = {}; let total = 0;
  for (const c of cues) for (const l of c.lines) { const s = scriptOf(l); if (s) { n[s] = (n[s] || 0) + 1; total++; } }
  for (const k in n) n[k] /= total || 1;
  return n;
}
const dominant = (shares) => Object.entries(shares).sort((a, b) => b[1] - a[1])[0]?.[0];

// If the bottom file is written in another script but also contains lines in the top
// file's script (e.g. a Chinese+English "bilingual" file under English), drop those lines.
function dropForeignDuplicates(primary, secondary) {
  const pMain = dominant(scriptShares(primary));
  const sShares = scriptShares(secondary);
  const otherScript = Object.entries(sShares).some(([s, v]) => s !== pMain && v >= 0.2);
  if (!pMain || !otherScript) return secondary;
  return secondary
    .map((c) => ({ ...c, lines: c.lines.filter((l) => scriptOf(l) !== pMain) }))
    .filter((c) => c.lines.length);
}

// ---------- timing alignment ----------

// Subtitle files made for different releases of a video are often shifted (by up to a minute
// or more), or stretched by the 23.976 vs 25 fps difference. Find the shift/stretch that makes
// the bottom file's line starts line up with the top file's, and apply it.
const RANGE = 150000, BIN = 100, TOL = 250;

// For every pair of (top start, bottom start) within RANGE, vote for their difference.
// The true offset collects far more votes than any other.
function bestOffset(pStarts, sStarts) {
  const NB = (2 * RANGE) / BIN + 1, hist = new Uint16Array(NB);
  let lo = 0;
  for (const t of sStarts) {
    while (lo < pStarts.length && pStarts[lo] < t - RANGE) lo++;
    for (let k = lo; k < pStarts.length && pStarts[k] <= t + RANGE; k++) hist[Math.round((pStarts[k] - t + RANGE) / BIN)]++;
  }
  let peak = 1;
  for (let i = 2; i < NB - 2; i++) {
    if (hist[i - 1] + hist[i] + hist[i + 1] > hist[peak - 1] + hist[peak] + hist[peak + 1]) peak = i;
  }
  const w = hist[peak - 1] + hist[peak] + hist[peak + 1];
  const center = w ? ((peak - 1) * hist[peak - 1] + peak * hist[peak] + (peak + 1) * hist[peak + 1]) / w : peak;
  return center * BIN - RANGE;
}

function matchCount(pStarts, sStarts, f) {
  let n = 0, k = 0;
  for (const s of sStarts) {
    const t = f(s);
    while (k < pStarts.length && pStarts[k] < t - TOL) k++;
    if (k < pStarts.length && Math.abs(pStarts[k] - t) <= TOL) n++;
  }
  return n;
}

export function alignTo(primary, secondary) {
  if (primary.length < 30 || secondary.length < 30) return secondary;
  const P = primary.map((c) => c.start), S = secondary.map((c) => c.start);
  const half = S.length >> 1, S1 = S.slice(0, half), S2 = S.slice(half);
  const t1 = S1[S1.length >> 1], t2 = S2[S2.length >> 1];
  const identity = (t) => t;
  let best = { f: identity, score: matchCount(P, S, identity) };
  const consider = (f) => { const score = matchCount(P, S, f); if (score > best.score) best = { f, score }; };
  for (const scale of [1, 25 / 23.976, 23.976 / 25, 24 / 23.976, 23.976 / 24]) {
    const scaled = (arr) => arr.map((t) => t * scale);
    const o = bestOffset(P, scaled(S));
    consider((t) => t * scale + o);
    // Separate offsets for each half: also corrects slow drift.
    const o1 = bestOffset(P, scaled(S1)), o2 = bestOffset(P, scaled(S2));
    const u1 = t1 * scale, u2 = t2 * scale;
    if (u2 > u1) consider((t) => { const u = t * scale; return u + o1 + ((u - u1) * (o2 - o1)) / (u2 - u1); });
  }
  // Only re-time if it's clearly better than leaving the file as it is.
  const base = matchCount(P, S, identity);
  if (best.f === identity || best.score < base * 1.2 + 10) return secondary;
  return secondary.map((c) => ({ ...c, start: best.f(c.start), end: best.f(c.end) }));
}

// ---------- merging ----------

const norm = (l) => stripTags(l).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

// Attach each bottom-language line to the top-language line it overlaps the most.
// Bottom lines that overlap nothing are shown on their own.
export function mergeSubs(primary, secondary) {
  secondary = alignTo(primary, dropForeignDuplicates(primary, secondary));
  const out = primary.map((c) => ({ start: c.start, end: c.end, top: c.lines, bottom: [] }));
  const orphans = [];
  let j = 0;
  for (const s of secondary) {
    while (j < out.length && out[j].end <= s.start) j++;
    let best = null, bestOverlap = 0;
    for (let k = j; k < out.length && out[k].start < s.end; k++) {
      const ov = Math.min(out[k].end, s.end) - Math.max(out[k].start, s.start);
      if (ov > bestOverlap) { bestOverlap = ov; best = out[k]; }
    }
    // Needs to overlap a meaningful part of the bottom line, otherwise show it on its own.
    if (best && bestOverlap >= 0.3 * (s.end - s.start)) best.bottom.push(...s.lines);
    else orphans.push({ start: s.start, end: s.end, top: [], bottom: s.lines });
  }
  const all = out.concat(orphans).sort((a, b) => a.start - b.start);
  // Never let two cues be on screen at once (that's what shows up as "doubled" text):
  // cues that start almost together become one; otherwise the earlier one ends early.
  const cues = [];
  for (const c of all) {
    const prev = cues[cues.length - 1];
    if (prev && c.start - prev.start < 400) {
      prev.top.push(...c.top); prev.bottom.push(...c.bottom); prev.end = Math.max(prev.end, c.end);
    } else {
      if (prev && prev.end > c.start) prev.end = c.start;
      cues.push(c);
    }
  }
  return cues.map((c, n) => {
    const seen = new Set();
    const lines = [...c.top, ...c.bottom].filter((l) => {
      const k = norm(l);
      if (!k || seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    return `${n + 1}\n${fromMs(c.start)} --> ${fromMs(c.end)}\n${lines.join("\n")}\n`;
  }).join("\n");
}

// ---------- pairing files ----------

// Files made for the same release (same group, BluRay vs WEB, etc.) are usually in sync,
// so pair top/bottom files whose names look alike.
const tokens = (s) => new Set(String(s.subtitleFileName || s.movieReleaseName || "")
  .toLowerCase().replace(/\.(srt|vtt|sub|ass)$/, "").split(/[^a-z0-9]+/)
  .filter((t) => t.length > 1 && !/^(eng|english|chi|chinese|en|zh|subs?|srt)$/.test(t)));
function similarity(a, b) {
  const A = tokens(a), B = tokens(b);
  let shared = 0;
  for (const t of A) if (B.has(t)) shared++;
  const partial = (s) => /\bcd\s*\d\b|\bpart\s*\d\b/i.test(s.subtitleFileName || "") ? 1 : 0; // one half of a movie
  return shared / (Math.max(A.size, B.size) || 1)
    + (a.releaseGroup && a.releaseGroup === b.releaseGroup ? 1 : 0)
    - 2 * (partial(a) + partial(b));
}

function pairUp(A, B) {
  const pairs = [];
  A.forEach((a, i) => B.forEach((b, j) => pairs.push({ a, b, score: similarity(a, b), rank: i + j })));
  pairs.sort((x, y) => y.score - x.score || x.rank - y.rank);
  const out = [], usedA = new Map();
  for (const p of pairs) {
    if (out.length >= MAX_VARIANTS) break;
    if ((usedA.get(p.a.id) || 0) >= 2) continue; // keep variants varied
    usedA.set(p.a.id, (usedA.get(p.a.id) || 0) + 1);
    out.push(p);
  }
  return out;
}

// ---------- helpers ----------

const b64 = (s) => btoa(String.fromCharCode(...new TextEncoder().encode(s)))
  .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64 = (s) => new TextDecoder().decode(
  Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)));

// Only ever fetch subtitle files from Stremio's own subtitle hosts.
function allowedSubUrl(u) {
  try {
    const url = new URL(u);
    return url.protocol === "https:" && (url.hostname === "strem.io" || url.hostname.endsWith(".strem.io"));
  } catch { return false; }
}

const memo = new Map();
function remember(key, value) {
  memo.set(key, value);
  if (memo.size > 200) memo.delete(memo.keys().next().value);
  return value;
}

async function fetchText(url) {
  const r = await fetch(url, { headers: { "User-Agent": "dual-subtitles-addon" } });
  if (!r.ok) throw new Error(`${r.status} fetching ${url}`);
  return r.text();
}

// One retry, then give up with "" so the other language can still be shown.
async function fetchSub(url) {
  for (let i = 0; i < 2; i++) {
    try { return await fetchText(url); } catch (e) { console.warn(e.message); }
  }
  return "";
}

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*" };
const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json; charset=utf-8", ...extra } });

function parseConfig(cfg) {
  const [a, b] = decodeURIComponent(cfg).split("-");
  return LANGS[a] && LANGS[b] && a !== b ? { a, b } : null;
}

function manifest(cfg) {
  return {
    id: "community.dualsubtitles" + (cfg ? `.${cfg.a}.${cfg.b}` : ""),
    version: "1.1.0",
    name: cfg ? `Dual Subs: ${LANGS[cfg.a]} + ${LANGS[cfg.b]}` : "Dual Subtitles",
    description: "Shows two subtitle languages at once (e.g. English + Chinese) by merging OpenSubtitles tracks.",
    resources: ["subtitles"],
    types: ["movie", "series"],
    idPrefixes: ["tt"],
    catalogs: [],
    behaviorHints: { configurable: true, configurationRequired: !cfg },
  };
}

// ---------- routes ----------

async function subtitlesRoute(origin, cfg, rest) {
  // rest = "<type>/<id>[/<extra>].json", forwarded as-is to OpenSubtitles v3
  const key = `list:${rest}`;
  let list = memo.get(key);
  if (!list) {
    const data = JSON.parse(await fetchText(`${UPSTREAM}/subtitles/${rest}`));
    list = remember(key, data.subtitles || []);
  }
  const pick = (code) => codesFor(code)
    .flatMap((c) => list.filter((s) => s.lang === c)).slice(0, MAX_CANDIDATES);
  const label = `${LANGS[cfg.a]} + ${LANGS[cfg.b]}`;
  const subtitles = pairUp(pick(cfg.a), pick(cfg.b)).map(({ a, b }) => ({
    id: `dual-${a.id}-${b.id}`,
    url: `${origin}/merge/${b64(a.url)}/${b64(b.url)}.srt`,
    lang: label,
  }));
  return json({ subtitles, cacheMaxAge: 3600 }, 200, { "Cache-Control": "public, max-age=3600" });
}

async function mergeRoute(request, aEnc, bEnc, ctx) {
  const cache = globalThis.caches?.default; // available on Cloudflare
  if (cache) {
    const hit = await cache.match(request);
    if (hit) return hit;
  }
  const key = `merge:${aEnc}:${bEnc}`;
  let srt = memo.get(key);
  let complete = true;
  if (!srt) {
    const ua = unb64(aEnc), ub = unb64(bEnc);
    if (!allowedSubUrl(ua) || !allowedSubUrl(ub)) return json({ error: "subtitle host not allowed" }, 400);
    const [ra, rb] = await Promise.all([fetchSub(ua), fetchSub(ub)]);
    if (!ra && !rb) return json({ error: "both subtitle files failed to download" }, 502);
    complete = Boolean(ra && rb);
    srt = mergeSubs(parseSubs(ra), parseSubs(rb));
    if (complete) remember(key, srt); // don't keep a half-failed merge
  }
  const res = new Response(srt, {
    headers: {
      ...CORS,
      "Content-Type": "application/x-subrip; charset=utf-8",
      "Cache-Control": complete ? "public, max-age=86400" : "no-store",
    },
  });
  if (cache && complete) {
    const put = cache.put(request, res.clone());
    ctx?.waitUntil ? ctx.waitUntil(put) : await put;
  }
  return res;
}

function configurePage(origin) {
  const opts = Object.entries(LANGS).map(([c, n]) => `<option value="${c}">${n}</option>`).join("");
  const canDeepLink = origin.startsWith("https://");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Dual Subtitles</title>
<style>
 body{font-family:system-ui,sans-serif;background:#141225;color:#eee;display:flex;justify-content:center;padding:60px 20px;margin:0}
 .card{background:#1e1b33;padding:32px;border-radius:14px;max-width:460px;width:100%}
 h1{margin-top:0;font-size:22px} label{display:block;margin:16px 0 6px;color:#aaa;font-size:14px}
 select{width:100%;padding:10px;border-radius:8px;background:#2a2645;color:#eee;border:0;font-size:15px}
 .btn{display:block;width:100%;box-sizing:border-box;text-align:center;margin-top:16px;padding:12px;border-radius:8px;border:0;background:#7b5bf5;color:#fff;text-decoration:none;font-weight:600;font-size:15px;cursor:pointer}
 .btn.alt{background:#2a2645}
 code{display:block;margin-top:12px;padding:10px;background:#2a2645;border-radius:8px;font-size:12px;word-break:break-all;color:#ccc}
 p{color:#999;font-size:13px}
</style></head><body><div class="card">
<h1>Dual Subtitles</h1>
<p>Pick two languages. They'll show as one subtitle track, with the top language above the bottom one.</p>
<label>Top language</label><select id="a">${opts}</select>
<label>Bottom language</label><select id="b">${opts}</select>
${canDeepLink ? '<a class="btn" id="install" href="#">Install in Stremio</a>' : ""}
<button class="btn ${canDeepLink ? "alt" : ""}" id="copy">Copy addon URL</button>
<p>Or in Stremio go to <b>Addons</b> → <b>+ Add addon</b> and paste:</p><code id="url"></code>
</div><script>
 const a=document.getElementById('a'), b=document.getElementById('b'), copy=document.getElementById('copy');
 const install=document.getElementById('install');
 a.value='eng'; b.value='zh';
 const path=()=>'/'+a.value+'-'+b.value+'/manifest.json';
 const url=()=>'${origin}'+path();
 function upd(){document.getElementById('url').textContent=url(); copy.textContent='Copy addon URL';
  if(install) install.href='stremio://${origin.replace(/^https?:\/\//, "")}'+path();}
 copy.onclick=async()=>{try{await navigator.clipboard.writeText(url());copy.textContent='Copied!';}
  catch{copy.textContent='Copy failed: select the URL below';}};
 a.onchange=b.onchange=upd; upd();
</script></body></html>`;
}

export async function handle(request, env, ctx) {
  try {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    const url = new URL(request.url);
    const path = url.pathname;
    let m;
    if (path === "/" || path === "/configure" || /^\/[^/]+\/configure$/.test(path))
      return new Response(configurePage(url.origin), { headers: { "Content-Type": "text/html; charset=utf-8" } });
    if (path === "/manifest.json") return json(manifest(null));
    if ((m = path.match(/^\/merge\/([\w-]+)\/([\w-]+)\.srt$/))) return await mergeRoute(request, m[1], m[2], ctx);
    if ((m = path.match(/^\/([^/]+)\/(.+)$/))) {
      const cfg = parseConfig(m[1]);
      if (!cfg) return json({ error: "bad language config" }, 400);
      if (m[2] === "manifest.json") return json(manifest(cfg));
      const s = m[2].match(/^subtitles\/(.+\.json)$/);
      if (s) return await subtitlesRoute(url.origin, cfg, s[1]);
    }
    return json({ error: "not found" }, 404);
  } catch (e) {
    console.error(e);
    return json({ error: String(e?.message || e) }, 500);
  }
}

export default { fetch: handle };
