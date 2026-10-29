import config from './cucumber.config.js'

export default {
  ...config,
  tags: '@soak and not @skip',
  format: [
    'progress',
    'html:e2e/reports/soak.html',
    'json:e2e/reports/soak.json',
  ],
}
