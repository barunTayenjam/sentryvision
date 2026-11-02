const { chromium } = require('@playwright/test');
const jwt = require('jsonwebtoken');
(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--disable-web-security'] });
  const page = await browser.newPage();
  page.on('console', m => { if (m.type() === 'error') console.log('[CONSOLE]', m.text().slice(0, 250)); });
  page.on('pageerror', e => console.log('[PAGEERROR]', String(e).slice(0, 400)));
  page.on('requestfailed', r => console.log('[REQFAIL]', r.method(), r.url(), r.failure()?.errorText));
  page.on('response', r => { if (r.status() >= 400) console.log('[RESPERR]', r.status(), r.url()); });

  const token = jwt.sign(
    { userId: '9b7d8973-0670-4c03-bcf6-936f34da451f', username: 'barun', role: 'admin' },
    'dev-jwt-access-secret-change-in-production',
    { expiresIn: '7d', issuer: 'home-security-system', audience: 'home-security-client' },
  );
  console.log('CRAFTED TOKEN:', token.slice(0, 40));

  await page.goto('http://192.168.31.99:9753/login');
  await page.evaluate((t) => window.localStorage.setItem('auth_token', t), token);
  await page.goto('http://192.168.31.99:9753/analytics', { waitUntil: 'networkidle', timeout: 20000 });
  await page.waitForTimeout(8000);

  const title = await page.title();
  const svgCount = await page.evaluate(() => document.querySelectorAll('svg.recharts-surface').length);
  const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 2000));
  console.log('TITLE:', title);
  console.log('RECHARTS SVG COUNT:', svgCount);
  console.log('BODY TEXT:', bodyText);
  await page.screenshot({ path: '/tmp/analytics-auth.png', fullPage: true }).catch(() => {});
  await browser.close();
  console.log('DONE');
  process.exit(0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
