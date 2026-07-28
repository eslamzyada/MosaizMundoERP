/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  // The admin had no runtime tests at all, which is how a blank screen, a
  // hidden ratings panel and a status the UI did not know about all reached a
  // real device with CI green: tsc only ever checked types, and the types were
  // asserted rather than validated.
  test: {
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    globals: true,
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
