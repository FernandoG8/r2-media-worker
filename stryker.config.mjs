// @ts-check
/** @type {import('@stryker-mutator/core').PartialStrykerOptions} */
export default {
  testRunner: 'vitest',
  vitest: {
    configFile: 'vitest.config.mts',
  },
  mutate: [
    'src/crypto.ts',
    'src/validators.ts',
    'src/cors.ts',
  ],
  coverageAnalysis: 'perTest',
  reporters: ['html', 'json', 'clear-text'],
  htmlReporter: {
    fileName: 'reports/mutation/index.html',
  },
  jsonReporter: {
    fileName: 'reports/mutation/mutation.json',
  },
  thresholds: {
    high: 80,
    low: 60,
    break: null,
  },
  disableTypeChecks: true,
  timeoutMS: 30000,
}
