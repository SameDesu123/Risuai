// 빌드 결과물(dist)의 내부 링크가 모두 실제 페이지와 앵커를 가리키는지 확인한다.
// 사용법: pnpm build && pnpm check:links
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE } from '../site.config.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const base = BASE.replace(/\/+$/, '');

async function* walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) yield* walk(full);
        else yield full;
    }
}

async function exists(file) {
    try {
        return (await stat(file)).isFile();
    } catch {
        return false;
    }
}

function decodeEntities(value) {
    return value
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>');
}

function safeDecode(value) {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}

/** URL 경로를 dist 안의 파일로 바꾼다. 찾지 못하면 undefined. */
async function resolveTarget(urlPath) {
    let rel = safeDecode(urlPath);
    if (base) {
        if (rel !== base && !rel.startsWith(`${base}/`)) return { outsideBase: true };
        rel = rel.slice(base.length);
    }
    rel = rel.replace(/^\/+/, '');
    const candidates = rel === '' || rel.endsWith('/') ? [path.join(rel, 'index.html')] : [rel, path.join(rel, 'index.html')];
    for (const candidate of candidates) {
        const file = path.join(dist, candidate);
        if (await exists(file)) return { file };
    }
    return {};
}

// 실제 태그 안의 속성만 본다. 본문에 글자로 쓴 href="..."나 스크립트 속 문자열은 건너뛴다.
const TAG = /<[a-zA-Z][^\s>\/]*(?:\s+[^\s=>\/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*\s*\/?>/g;
const ATTR = /\s([^\s=>\/]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;

function* attributes(html, names) {
    const stripped = html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
    for (const [tag] of stripped.matchAll(TAG)) {
        for (const m of tag.matchAll(ATTR)) {
            const name = m[1].toLowerCase();
            if (names.includes(name)) yield [name, decodeEntities(m[2] ?? m[3] ?? m[4])];
        }
    }
}

const idCache = new Map();
async function idsOf(file) {
    if (!idCache.has(file)) {
        const html = await readFile(file, 'utf8');
        const ids = new Set();
        for (const [, id] of attributes(html, ['id', 'name'])) ids.add(id);
        idCache.set(file, ids);
    }
    return idCache.get(file);
}

const problems = [];
let checked = 0;

for await (const file of walk(dist)) {
    if (!file.endsWith('.html')) continue;
    const html = await readFile(file, 'utf8');
    const pageUrl = new URL(`https://wiki.invalid${base}/${path.relative(dist, file).split(path.sep).join('/')}`);

    for (const [, raw] of attributes(html, ['href', 'src'])) {
        if (!raw || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(raw)) continue; // 외부 링크, mailto:, data: 등

        const url = new URL(raw, pageUrl);
        checked++;
        const where = path.relative(dist, file);
        const target = await resolveTarget(url.pathname);
        if (target.outsideBase) {
            problems.push(`${where}: '${raw}'가 base(${base}) 밖을 가리킵니다.`);
            continue;
        }
        if (!target.file) {
            problems.push(`${where}: '${raw}' 대상 파일이 없습니다.`);
            continue;
        }
        const hash = safeDecode(url.hash.slice(1));
        if (hash && target.file.endsWith('.html') && !(await idsOf(target.file)).has(hash)) {
            problems.push(`${where}: '${raw}'의 앵커 #${hash}가 대상 페이지에 없습니다.`);
        }
    }
}

if (problems.length > 0) {
    console.error(`깨진 내부 링크 ${problems.length}개 (확인한 링크 ${checked}개):`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
}
console.log(`내부 링크 ${checked}개를 확인했습니다. 깨진 링크가 없습니다.`);
