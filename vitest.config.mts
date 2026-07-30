import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Installs the host CMS's LiquidJS on the global, the way an admin page
    // does — the preview renderer and the built bundle read it from there.
    setupFiles: ['./test/host-liquid.ts'],
  },
});
