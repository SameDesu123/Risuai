// @ts-check
import { defineConfig } from 'astro/config';
import { satteri } from '@astrojs/markdown-satteri';
import starlight from '@astrojs/starlight';
import { BASE, GITHUB_REPO, SITE } from './site.config.mjs';
import { baseLinks } from './src/plugins/base-links.mjs';

export default defineConfig({
    site: SITE,
    base: BASE,
    trailingSlash: 'always',
    markdown: {
        processor: satteri({ hastPlugins: [baseLinks(BASE)] }),
    },
    integrations: [
        starlight({
            title: {
                ko: 'RisuAI 비공식 위키',
                en: 'RisuAI Unofficial Wiki',
            },
            description: 'RisuAI 사용자들이 함께 만드는 비공식 문서입니다.',
            defaultLocale: 'root',
            locales: {
                root: { label: '한국어', lang: 'ko' },
                en: { label: 'English', lang: 'en' },
            },
            favicon: '/favicon.svg',
            social: [{ icon: 'github', label: 'GitHub', href: `https://github.com/${GITHUB_REPO}` }],
            editLink: { baseUrl: `https://github.com/${GITHUB_REPO}/edit/main/` },
            lastUpdated: true,
            customCss: ['./src/styles/custom.css'],
            components: {
                PageTitle: './src/components/PageTitle.astro',
                Footer: './src/components/Footer.astro',
            },
            sidebar: [
                {
                    label: '시작하기',
                    translations: { en: 'Getting started' },
                    items: [{ slug: 'getting-started/install' }],
                },
                {
                    label: 'CBS',
                    items: [{ slug: 'cbs/basics' }, { slug: 'cbs/reference' }],
                },
                {
                    label: '위키 기여하기',
                    translations: { en: 'Contributing' },
                    items: [{ slug: 'contributing' }],
                },
            ],
        }),
    ],
});
