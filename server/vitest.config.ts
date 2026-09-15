import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    env: {
      NODE_ENV: 'test',
      ENCRYPTION_KEY: 'test-key-test-key-test-key-test-key',
      SESSION_SECRET: 'test-session',
      DB_PATH: ':memory:',
    },
  },
});
