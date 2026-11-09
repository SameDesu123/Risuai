// 마크다운 본문의 루트 기준 링크(/cbs/basics/ 같은 것)에 base 경로를 붙이는 Sätteri hast 플러그인.
// 덕분에 문서에는 base를 신경 쓰지 않고 '/경로/' 형태로 링크를 쓰면 된다.
// MDX 안의 컴포넌트(<LinkCard href>)나 frontmatter(hero 링크)는 여기서 처리되지 않으니 상대 경로를 쓴다.

/**
 * @param {string} base astro 설정의 base (예: '/risuai-wiki')
 */
export function baseLinks(base) {
    const prefix = base.replace(/\/+$/, '');

    /** @param {unknown} url */
    function withBase(url) {
        if (!prefix || typeof url !== 'string') return undefined;
        if (!url.startsWith('/') || url.startsWith('//')) return undefined;
        if (url === prefix || url.startsWith(`${prefix}/`)) return undefined;
        return prefix + url;
    }

    return {
        name: 'wiki-base-links',
        element: {
            filter: ['a', 'img'],
            visit(node, ctx) {
                const attr = node.tagName === 'a' ? 'href' : 'src';
                const next = withBase(node.properties?.[attr]);
                if (next) ctx.setProperty(node, attr, next);
            },
        },
    };
}
