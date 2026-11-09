import { defineCollection } from 'astro:content';
import { z } from 'astro/zod';
import { docsLoader, i18nLoader } from '@astrojs/starlight/loaders';
import { docsSchema, i18nSchema } from '@astrojs/starlight/schema';

export const collections = {
    docs: defineCollection({
        loader: docsLoader(),
        schema: docsSchema({
            extend: z.object({
                /** 이 문서의 내용을 마지막으로 확인한 RisuAI 버전 (예: 2026.10.295). */
                verifiedVersion: z.string().optional(),
            }),
        }),
    }),
    i18n: defineCollection({
        loader: i18nLoader(),
        schema: i18nSchema({
            extend: z.object({
                'wiki.verifiedVersion': z.string().optional(),
                'wiki.disclaimer': z.string().optional(),
            }),
        }),
    }),
};
