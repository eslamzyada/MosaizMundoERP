/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  // Load backend/.env for local runs. In CI the vars are already in the
  // environment; dotenv does not override existing values.
  setupFiles: ['dotenv/config'],
  testMatch: ['**/__tests__/**/*.test.ts'],
  testTimeout: 30000,
};
