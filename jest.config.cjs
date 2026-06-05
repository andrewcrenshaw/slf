/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  roots: ['<rootDir>'],
  testMatch: ['**/__tests__/**/*.test.ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        useESM: true,
        tsconfig: {
          module: 'ESNext',
          moduleResolution: 'Node',
          esModuleInterop: true,
        },
      },
    ],
  },
  extensionsToTreatAsEsm: ['.ts'],
  transformIgnorePatterns: [
    '/node_modules/(?!(@noble/ed25519|@noble/hashes|jose)/)',
  ],
  collectCoverageFrom: [
    'src/**/*.ts',
    'index.ts',
    '!**/*.d.ts',
  ],
};
