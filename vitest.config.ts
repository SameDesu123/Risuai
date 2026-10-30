import { svelte } from "@sveltejs/vite-plugin-svelte"
import { configDefaults, defineConfig } from 'vitest/config'

// Contrast checks are advisory and run separately (`pnpm test:contrast`) so
// they never block `pnpm test`.
const contrastTests = 'src/**/*.contrast.test.ts'

export default defineConfig({
  plugins: [
    svelte(),
  ],
  resolve: {
    alias: {
      src: '/src',
    },
    conditions: ['browser'],
  },
  test: {
    environment: 'happy-dom',
    setupFiles: ['vitest.setup.ts'],
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          exclude: [...configDefaults.exclude, contrastTests],
        },
      },
      {
        extends: true,
        test: {
          name: 'contrast',
          include: [contrastTests],
        },
      },
    ],
  },
})
