// Capture jank screenshots from before.pftrace and after.pftrace.

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const OUT    = path.resolve(__dirname, '..', 'screenshots');
const UI     = 'http://127.0.0.1:10000';
const TRACES = path.resolve(__dirname, '..', 'traces');

fs.mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function load(page, file) {
  await page.goto(UI, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(1500);
  await page.locator('input[type=file]').first().setInputFiles(file);
  // Trace ready when the title bar shows the file or a process track shows up.
  await page.waitForFunction(() => {
    const t = document.body.innerText || '';
    return t.includes('com.example.perfetto.jank') || t.includes('JankDemo');
  }, { timeout: 240_000 });
  await sleep(4000);
}

async function full(page, name) {
  const p = path.join(OUT, name);
  await page.screenshot({ path: p });
  console.log('shot', name);
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    viewport: { width: 1920, height: 1200 },
    deviceScaleFactor: 2,
  });
  await ctx.addInitScript(() => { try { localStorage.setItem('cookieAck','true'); } catch {} });

  for (const variant of ['before', 'after']) {
    console.log('===', variant);
    const page = await ctx.newPage();
    page.on('pageerror', e => console.error('pageerror:', e.message));
    await load(page, path.join(TRACES, `${variant}.pftrace`));

    // Default zoomed-out view.
    await full(page, `${variant}-01-default.png`);

    // Find and click the JankDemo process row to expand its tracks.
    const expanded = await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('*'));
      for (const el of els) {
        const t = (el.textContent || '').trim();
        if (t === 'com.example.perfetto.jank' && el.children.length === 0) {
          el.scrollIntoView({ block: 'center' });
          el.click();
          return true;
        }
      }
      return false;
    });
    console.log('  expanded process row:', expanded);
    await sleep(1500);

    // Zoom to fit the whole trace, then screenshot.
    await page.keyboard.press('1');           // 1 = zoom out / fit
    await sleep(800);
    await full(page, `${variant}-02-process-tracks.png`);

    // Use the search bar to find a getView slice and jump to it.
    const sliceName = variant === 'before' ? 'BadAdapter.getView' : 'GoodAdapter.getView';
    await page.keyboard.press('Slash');       // open search
    await sleep(400);
    await page.keyboard.type(sliceName);
    await sleep(800);
    await page.keyboard.press('Enter');
    await sleep(2000);
    await full(page, `${variant}-03-getview-search.png`);

    // Press 'f' to zoom to the selected slice.
    await page.keyboard.press('f');
    await sleep(1500);
    await full(page, `${variant}-04-getview-zoomed.png`);

    await page.close();
  }

  await browser.close();
  console.log('=== DONE ===');
})().catch(e => { console.error('FATAL', e); process.exit(1); });
