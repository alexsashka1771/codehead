import { defineConfig } from '@playwright/test';
import path from 'node:path';

const baseURL = process.env.CODEHEAD_E2E_BASE_URL;
const reportDirectory = process.env.CODEHEAD_TEST_REPORT_DIR;
if (!baseURL || !reportDirectory) throw new Error('Use npm run test:e2e to start the isolated test database and servers.');

export default defineConfig({
  testDir: './tests/e2e',
  outputDir: path.join(reportDirectory, 'results'),
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 8_000 },
  reporter: [['list'], ['html', { outputFolder: path.join(reportDirectory, 'html'), open: 'never' }]],
  use: {
    baseURL,
    browserName: 'chromium',
    headless: true,
    viewport: { width: 1366, height: 768 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
});
