import { fileURLToPath } from 'node:url'
import { mergeConfig, defineConfig, configDefaults } from 'vitest/config'
import viteConfig from './vite.config'

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: 'jsdom',
      exclude: [...configDefaults.exclude, 'e2e/**', 'cypress/**'],
      root: fileURLToPath(new URL('./', import.meta.url)),
      // `virtual:pwa-register` only exists once vite-plugin-pwa runs a real
      // build; src/pwa.js imports it dynamically and tolerates this stub.
      alias: {
        'virtual:pwa-register': fileURLToPath(
          new URL('./src/__mocks__/pwa-register.js', import.meta.url),
        ),
      },
    },
  }),
)
