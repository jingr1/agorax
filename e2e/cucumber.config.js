export default {
  paths: ['e2e/src/features/**/*.feature'],
  import: ['e2e/src/support/**/*.ts', 'e2e/src/steps/**/*.ts'],
  format: [
    'progress',
    'html:e2e/reports/cucumber.html',
    'json:e2e/reports/cucumber.json',
  ],
  parallel: 1,
  retry: 0,
  tags: 'not @soak and not @skip',
}
