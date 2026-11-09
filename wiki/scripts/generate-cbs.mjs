#!/usr/bin/env node
// RisuAI 소스 코드에서 CBS 레퍼런스 페이지를 만든다.
//
// 원본 위치는 환경 변수로 바꿀 수 있다.
//   RISUAI_SOURCE_DIR  로컬 RisuAI 체크아웃 경로. 있으면 네트워크를 쓰지 않는다.
//   RISUAI_REPO        클론할 저장소 (기본값: https://github.com/kwaroran/RisuAI)
//   RISUAI_REF         클론할 브랜치나 태그 (기본값: main)
//
// 결과물(아래 OUTPUTS)은 .gitignore에 들어 있다. 빌드할 때마다 새로 만든다.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { categories, uncategorized } from './cbs-categories.mjs';
import { extractCbs } from './lib/extract-cbs.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_REPO = 'https://github.com/kwaroran/RisuAI';
const OUTPUTS = {
    ko: join(ROOT, 'src/content/docs/cbs/reference.md'),
    en: join(ROOT, 'src/content/docs/en/cbs/reference.md'),
};
const TRANSLATIONS = { ko: join(ROOT, 'data/cbs-translations/ko.json') };

// ---------------------------------------------------------------------------
// 원본 읽기

function git(args, opts = {}) {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
}

function loadSource() {
    const repo = (process.env.RISUAI_REPO || DEFAULT_REPO).replace(/\.git$/, '').replace(/\/$/, '');
    const localDir = process.env.RISUAI_SOURCE_DIR;

    if (localDir) {
        const dir = resolve(localDir);
        let commit = null;
        try {
            commit = git(['-C', dir, 'rev-parse', 'HEAD']);
        } catch {}
        return {
            repo,
            commit,
            cbs: readFileSync(join(dir, 'src/ts/cbs.ts'), 'utf8'),
            version: JSON.parse(readFileSync(join(dir, 'version.json'), 'utf8')).version,
            origin: dir,
        };
    }

    const ref = process.env.RISUAI_REF || 'main';
    const cache = join(ROOT, '.cache/risuai');
    rmSync(cache, { recursive: true, force: true });
    mkdirSync(dirname(cache), { recursive: true });
    console.log(`[cbs] ${repo} (${ref}) 가져오는 중...`);
    try {
        git(['clone', '--depth', '1', '--filter=blob:none', '--no-checkout', '--branch', ref, `${repo}.git`, cache]);
    } catch (err) {
        throw new Error(
            `RisuAI 저장소를 가져오지 못했습니다: ${err.stderr || err.message}\n` +
                '오프라인이라면 RISUAI_SOURCE_DIR에 로컬 체크아웃 경로를 지정하세요.',
        );
    }
    return {
        repo,
        commit: git(['-C', cache, 'rev-parse', 'HEAD']),
        cbs: git(['-C', cache, 'show', 'HEAD:src/ts/cbs.ts']),
        version: JSON.parse(git(['-C', cache, 'show', 'HEAD:version.json'])).version,
        origin: `${repo}@${ref}`,
    };
}

// ---------------------------------------------------------------------------
// Markdown 변환

export function hashDescription(text) {
    return createHash('sha256').update(text).digest('hex').slice(0, 10);
}

/** 이름을 HTML id로 바꾼다. '#when' → 'cbs-block-when', '//' → 'cbs-slash-slash' */
function idFor(name) {
    const body = name
        .toLowerCase()
        .replace(/#/g, 'block-')
        .replace(/:/g, 'colon-')
        .replace(/\//g, 'slash-')
        .replace(/\?/g, 'question-')
        .replace(/[^a-z0-9_-]/g, (c) => `x${c.codePointAt(0).toString(16)}-`)
        .replace(/-+$/, '');
    return `cbs-${body}`;
}

function codeSpan(text) {
    const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((m) => m.length));
    const fence = '`'.repeat(longest + 1);
    const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
    return `${fence}${pad}${text}${pad}${fence}`;
}

/** 코드 밖의 평문에서 Markdown/HTML로 해석될 수 있는 문자를 막는다. */
function escapeProse(text) {
    return text.replace(/[\\`*_[\]<>|~&]/g, (c) => `\\${c}`);
}

/** 중첩을 고려해 {{...}} 구간을 찾는다. 짝이 맞지 않으면 그 부분은 평문으로 둔다. */
function findCbsSpans(text) {
    const spans = [];
    let i = 0;
    while (i < text.length) {
        const start = text.indexOf('{{', i);
        if (start === -1) break;
        let depth = 0;
        let j = start;
        let end = -1;
        while (j < text.length - 1) {
            if (text[j] === '{' && text[j + 1] === '{') {
                depth++;
                j += 2;
            } else if (text[j] === '}' && text[j + 1] === '}') {
                depth--;
                j += 2;
                if (depth === 0) {
                    end = j;
                    break;
                }
            } else {
                j++;
            }
        }
        if (end === -1) break;
        spans.push([start, end]);
        i = end;
    }
    // `{{#each A}} ... {{/each}}`처럼 말줄임표나 공백으로만 이어진 구간은 하나로 묶는다.
    const merged = [];
    for (const span of spans) {
        const prev = merged.at(-1);
        if (prev && /^\s*(\.\.\.|…)?\s*$/.test(text.slice(prev[1], span[0]))) prev[1] = span[1];
        else merged.push([...span]);
    }
    return merged;
}

/** 한 줄의 평문을 Markdown으로: CBS 구간은 코드로, 나머지는 이스케이프. */
function formatInline(text) {
    let out = '';
    let last = 0;
    for (const [s, e] of findCbsSpans(text)) {
        out += escapeProse(text.slice(last, s)) + codeSpan(text.slice(s, e));
        last = e;
    }
    return out + escapeProse(text.slice(last));
}

/** 설명문을 본문과 사용법으로 나눈다. 앱의 관례상 마지막 'Usage::' 뒤가 사용 예시다. */
function splitUsage(description) {
    const idx = description.lastIndexOf('Usage::');
    if (idx === -1) return { body: description.trim(), usage: '' };
    return { body: description.slice(0, idx).trim(), usage: description.slice(idx + 'Usage::'.length).trim() };
}

/** 여러 줄 본문을 Markdown 블록으로. '{{'로 시작하는 줄은 목록으로 만든다. */
function formatBody(body) {
    const blocks = [];
    let list = [];
    let para = [];
    const flushList = () => list.length && (blocks.push(list.join('\n')), (list = []));
    const flushPara = () => para.length && (blocks.push(para.join('\n')), (para = []));
    for (const raw of body.split('\n')) {
        const line = raw.trim();
        if (!line) {
            flushList();
            flushPara();
        } else if (line.startsWith('{{')) {
            flushPara();
            list.push(`- ${formatInline(line)}`);
        } else {
            flushList();
            // 줄 맨 앞의 목록/제목 기호가 Markdown 문법으로 읽히지 않게 막는다.
            para.push(formatInline(line).replace(/^([#+-]|\d+\.)/, '\\$1'));
        }
    }
    flushList();
    flushPara();
    return blocks.join('\n\n');
}

// ---------------------------------------------------------------------------
// 페이지 조립

const STRINGS = {
    ko: {
        title: 'CBS 레퍼런스',
        description: 'RisuAI의 모든 CBS 함수 목록. RisuAI 소스 코드에서 자동으로 만든다.',
        generatedTitle: '자동 생성 문서',
        generated: (src) =>
            `이 페이지는 RisuAI 소스 코드의 ${codeSpan('src/ts/cbs.ts')}에서 자동으로 만들어집니다. ` +
            `직접 고쳐도 다음 빌드 때 덮어씌워집니다. 분류는 ${codeSpan('scripts/cbs-categories.mjs')}, ` +
            `한국어 설명은 ${codeSpan('data/cbs-translations/ko.json')}에서 고치세요.\n\n` +
            `기준: RisuAI ${codeSpan(src.version)}${src.commitLink ? ` · 커밋 ${src.commitLink}` : ''}`,
        intro: `CBS가 처음이라면 [CBS 기초](/cbs/basics/)부터 읽어 보세요. 함수 이름은 대소문자를 가리지 않고, ${codeSpan('_')}, ${codeSpan('-')}, 공백도 무시됩니다. 예를 들어 ${codeSpan('{{Get_Var::hp}}')}는 ${codeSpan('{{getvar::hp}}')}와 같습니다.`,
        stats: (total, translated) =>
            `모두 ${total}개 가운데 ${translated}개의 설명을 한국어로 옮겼습니다. 번역이 없는 항목은 영어 원문을 그대로 보여 줍니다.`,
        overview: '한눈에 보기',
        category: '분류',
        functions: '함수',
        aliases: '별칭',
        usage: '사용법',
        source: '소스 보기',
        deprecated: '사용 중단',
        useInstead: (link) => `대신 ${link}을(를) 쓰세요.`,
        staleTitle: '원문이 바뀌었습니다',
        stale: '번역한 뒤에 영어 원문이 수정되었습니다. 아래 원문과 비교해 번역을 고쳐 주세요.',
        original: '영어 원문',
        docOnly: '이 항목은 일반 함수가 아니라 파서나 에셋 처리 단계에서 따로 처리됩니다.',
    },
    en: {
        title: 'CBS reference',
        description: 'Every CBS function in RisuAI, generated from the RisuAI source code.',
        generatedTitle: 'Generated page',
        generated: (src) =>
            `This page is generated from ${codeSpan('src/ts/cbs.ts')} in the RisuAI source code. ` +
            `Manual edits are overwritten on the next build. Categories live in ${codeSpan('scripts/cbs-categories.mjs')}.\n\n` +
            `Based on RisuAI ${codeSpan(src.version)}${src.commitLink ? ` · commit ${src.commitLink}` : ''}`,
        intro: `New to CBS? Start with [CBS basics](/en/cbs/basics/). Function names are case-insensitive, and ${codeSpan('_')}, ${codeSpan('-')} and spaces are ignored, so ${codeSpan('{{Get_Var::hp}}')} is the same as ${codeSpan('{{getvar::hp}}')}.`,
        stats: (total) => `${total} functions in total.`,
        overview: 'Overview',
        category: 'Category',
        functions: 'Functions',
        aliases: 'Aliases',
        usage: 'Usage',
        source: 'View source',
        deprecated: 'Deprecated',
        useInstead: (link) => `Use ${link} instead.`,
        staleTitle: '',
        stale: '',
        original: '',
        docOnly: 'This is not a regular function: the parser or the asset renderer handles it separately.',
    },
};

function groupEntries(entries, warnings) {
    const byName = new Map(entries.map((e) => [e.name, e]));
    const used = new Set();
    const groups = [];
    for (const cat of categories) {
        const items = [];
        for (const name of cat.names) {
            const entry = byName.get(name);
            if (!entry) {
                warnings.push(`분류표의 '${name}'(${cat.id})가 원본에 없습니다. 삭제되었거나 이름이 바뀌었을 수 있습니다.`);
                continue;
            }
            if (used.has(name)) {
                warnings.push(`'${name}'가 분류표에 두 번 들어 있습니다.`);
                continue;
            }
            used.add(name);
            items.push(entry);
        }
        if (items.length) groups.push({ ...cat, items });
    }
    const rest = entries.filter((e) => !used.has(e.name));
    if (rest.length) {
        warnings.push(`분류되지 않은 함수 ${rest.length}개: ${rest.map((e) => e.name).join(', ')} → scripts/cbs-categories.mjs에 추가하세요.`);
        groups.push({ ...uncategorized, items: rest });
    }
    return groups;
}

function renderEntry(entry, locale, ctx) {
    const t = STRINGS[locale];
    const id = idFor(entry.name);
    const lines = [`<h3 id="${id}"><a href="#${id}"><code>${entry.name.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</code></a></h3>`, ''];

    const aliases = [...new Set(entry.alias)].filter((a) => a !== entry.name);
    if (aliases.length) lines.push(`${t.aliases}: ${aliases.map(codeSpan).join(', ')}`, '');

    if (entry.deprecated) {
        const rep = entry.deprecated.replacement;
        const repLink = rep ? (ctx.ids.has(rep) ? `[${codeSpan(rep)}](#${idFor(rep)})` : codeSpan(rep)) : '';
        lines.push(`:::caution[${t.deprecated}]`, formatInline(entry.deprecated.message));
        if (repLink) lines.push('', t.useInstead(repLink));
        lines.push(':::', '');
    }

    const { body, usage } = splitUsage(entry.description);
    const tr = ctx.translations?.[entry.name];
    if (tr?.description) {
        ctx.translated++;
        lines.push(formatBody(tr.description), '');
        const current = hashDescription(entry.description);
        if (!tr.source) {
            ctx.warnings.push(`번역 '${entry.name}'에 source 해시가 없습니다. 현재 원문의 해시는 "${current}"입니다.`);
        } else if (tr.source !== current) {
            ctx.stale.push(entry.name);
            lines.push(`:::caution[${t.staleTitle}]`, t.stale, ':::', '');
            lines.push('<details>', `<summary>${t.original}</summary>`, '', formatBody(body), '', '</details>', '');
        }
    } else if (body) {
        lines.push(formatBody(body), '');
    }

    if (entry.docOnly) lines.push(`*${t.docOnly}*`, '');
    if (usage) lines.push(`**${t.usage}:** ${formatInline(usage)}`, '');
    if (ctx.sourceUrl) lines.push(`[${t.source} ↗](${ctx.sourceUrl}#L${entry.line})`, '');
    return lines.join('\n');
}

function renderPage(locale, groups, src, translations, warnings) {
    const t = STRINGS[locale];
    const commitLink = src.commit ? `[${codeSpan(src.commit.slice(0, 7))}](${src.repo}/commit/${src.commit})` : '';
    const ctx = {
        ids: new Set(groups.flatMap((g) => g.items.map((e) => e.name))),
        sourceUrl: src.commit ? `${src.repo}/blob/${src.commit}/src/ts/cbs.ts` : null,
        translations,
        translated: 0,
        stale: [],
        warnings,
    };
    const total = groups.reduce((n, g) => n + g.items.length, 0);

    const sections = groups.map((g) =>
        [`## ${g.label[locale]}`, '', ...g.items.map((e) => renderEntry(e, locale, ctx))].join('\n'),
    );
    const overview = [
        `| ${t.category} | ${t.functions} |`,
        '| --- | --- |',
        ...groups.map((g) => `| ${g.label[locale]} | ${g.items.map((e) => `[${codeSpan(e.name)}](#${idFor(e.name)})`).join(' · ')} |`),
    ].join('\n');

    const frontmatter = [
        '---',
        `title: ${JSON.stringify(t.title)}`,
        `description: ${JSON.stringify(t.description)}`,
        'editUrl: false',
        'lastUpdated: false',
        'tableOfContents:',
        '  maxHeadingLevel: 2',
        `verifiedVersion: ${JSON.stringify(src.version)}`,
        '---',
    ].join('\n');

    const page = [
        frontmatter,
        '',
        '<!-- 자동 생성 파일입니다. 직접 고치지 마세요. (scripts/generate-cbs.mjs) -->',
        '',
        `:::note[${t.generatedTitle}]`,
        t.generated({ version: src.version, commitLink }),
        ':::',
        '',
        t.intro,
        '',
        t.stats(total, ctx.translated),
        '',
        `## ${t.overview}`,
        '',
        overview,
        '',
        ...sections,
    ].join('\n');

    return { page, total, translated: ctx.translated, stale: ctx.stale };
}

// ---------------------------------------------------------------------------

function main() {
    const src = loadSource();
    const { entries: all, warnings } = extractCbs(src.cbs);
    const entries = all.filter((e) => !e.internalOnly);
    if (entries.length < 50) {
        throw new Error(`CBS 항목이 ${entries.length}개밖에 없습니다. 원본 구조가 바뀌었을 수 있으니 추출기를 확인하세요.`);
    }
    const groups = groupEntries(entries, warnings);

    for (const [locale, out] of Object.entries(OUTPUTS)) {
        const file = TRANSLATIONS[locale];
        const translations = file && existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
        if (translations) {
            for (const name of Object.keys(translations)) {
                if (!entries.some((e) => e.name === name)) warnings.push(`번역 파일에 있는 '${name}'가 원본에 없습니다.`);
            }
        }
        const { page, total, translated, stale } = renderPage(locale, groups, src, translations, warnings);
        mkdirSync(dirname(out), { recursive: true });
        writeFileSync(out, page);
        let summary = `[cbs] ${locale}: ${total}개 항목 → ${out.slice(ROOT.length + 1)}`;
        if (translations) summary += ` (번역 ${translated}개${stale.length ? `, 원문 바뀜 ${stale.length}개: ${stale.join(', ')}` : ''})`;
        console.log(summary);
    }
    console.log(`[cbs] 원본: ${src.origin} · 버전 ${src.version}${src.commit ? ` · ${src.commit.slice(0, 7)}` : ''}`);
    for (const w of new Set(warnings)) console.warn(`[cbs] 경고: ${w}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        main();
    } catch (err) {
        console.error(`[cbs] 실패: ${err.message}`);
        process.exit(1);
    }
}
