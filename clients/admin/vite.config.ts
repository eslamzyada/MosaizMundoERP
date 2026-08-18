// defineConfig comes from vitest/config, not from vite.
//
// Under vitest 4 the `test` block below is no longer part of vite's own
// UserConfig type, so importing defineConfig from 'vite' fails the build with
// "Object literal may only specify known properties, and 'test' does not
// exist". vitest/config re-exports a defineConfig that knows about both, which
// is why the triple-slash reference is no longer needed either.
import { defineConfig } from 'vitest/config';
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
    // Placeholder Supabase config, so importing the API client does not throw
    // "supabaseUrl is required" in a checkout with no .env.
    //
    // These are NOT credentials and must never become them: nothing in a test
    // reaches Supabase. The real values live in clients/admin/.env, which is
    // gitignored — which is exactly why the suite passed locally and failed in
    // CI until this existed.
    env: {
      VITE_SUPABASE_URL: 'http://localhost:54321',
      VITE_SUPABASE_ANON_KEY: 'test-anon-key-not-a-real-credential',
    },
  },
});
