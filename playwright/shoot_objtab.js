// Just nail the Object tab flow: 12 objects-list, 12 object-tab-top, 13 object-tab-bottom, 03 tab bar.

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const OUT = path.resolve(__dirname, '..', 'screenshots');
const UI  = 'http://127.0.0.1:10000';
const HPR = path.resolve(__dirname, '..', 'dumps', 'leakapp.hprof');

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    viewport: { width: 1920, height: 1200 },
    deviceScaleFactor: 2,
  });
  await ctx.addInitScript(() => { try { localStorage.setItem('cookieAck','true'); } catch {} });

  const page = await ctx.newPage();
  page.on('pageerror', e => console.error('pageerror:', e.message));

  await page.goto(UI, { waitUntil: 'domcontentloaded' });
  await sleep(800);
  await page.locator('input[type=file]').first().setInputFiles(HPR);
  await page.waitForFunction(() => (document.body.innerText||'').includes('Heapdump Explorer'), { timeout: 240_000 });
  await sleep(4000);

  // Classes tab → click EXACTLY the com.heapleak.LeakedActivity row.
  await page.evaluate(() => { window.location.hash = '#!/heapdump/classes'; });
  await page.waitForFunction(() => (document.body.innerText||'').includes('com.heapleak.LeakedActivity'), { timeout: 45_000 });
  await sleep(2500);

  // Find the button.ah-link whose full textContent is exactly the class name.
  const clicked = await page.evaluate(() => {
    const target = 'com.heapleak.LeakedActivity';
    for (const el of document.querySelectorAll('button.ah-link')) {
      const t = (el.textContent || '').trim();
      if (t === target) {
        el.scrollIntoView({ block: 'center' });
        el.click();
        return {tag: el.tagName, cls: el.className};
      }
    }
    return null;
  });
  console.log('click leakedactivity ->', clicked);
  if (!clicked) { console.error('could not find exact class link'); process.exit(1); }
  await sleep(5000); // give the UI time to re-render the Objects table
  const diag = await page.evaluate(() => ({
    hash: window.location.hash,
    hasLeakedAt: (document.body.innerText||'').includes('LeakedActivity@0x'),
    hasObjectsTitle: (document.body.innerText||'').includes('Objects ('),
    snippet: (document.body.innerText||'').slice(0, 400),
  }));
  console.log('after click:', JSON.stringify(diag));
  await page.screenshot({ path: path.join(OUT, '12_objects_leaked_activity.png') });
  console.log('wrote 12_objects_leaked_activity.png');

  // Click the LeakedActivity 0x... object id to open the Object tab.
  const clickedObj = await page.evaluate(() => {
    const rx = /^LeakedActivity\s+0x[0-9a-fA-F]+$/;
    for (const el of document.querySelectorAll('button.ah-link, a')) {
      const t = (el.textContent || '').trim();
      if (rx.test(t)) {
        el.scrollIntoView({ block: 'center' });
        el.click();
        return t;
      }
    }
    return null;
  });
  console.log('click obj ->', clickedObj);
  if (!clickedObj) { console.error('no LeakedActivity@0x link'); process.exit(1); }
  await page.waitForFunction(() => {
    const t = document.body.innerText || '';
    return t.includes('Reference path from GC root') ||
           t.includes('Reference Path') ||
           t.includes('Object info') ||
           t.includes('Object Info') ||
           t.includes('Reachable through');
  }, { timeout: 30_000 }).catch(() => {
    console.warn('object tab probe timed out — screenshotting anyway');
  });
  await sleep(3500);
  await page.screenshot({ path: path.join(OUT, '12_object_tab_top.png') });
  console.log('wrote 12_object_tab_top.png');

  // Scroll the content pane for the bottom half. Perfetto's content scrollers have class "pf-stable-panel-wrapper" or similar.
  await page.evaluate(() => {
    // Find the element containing "Immediately dominated objects" or "Objects with references" and scroll its nearest scroll parent.
    function scrollParent(el) {
      while (el && el !== document.body) {
        const s = getComputedStyle(el);
        if ((s.overflowY === 'auto' || s.overflowY === 'scroll') && el.scrollHeight > el.clientHeight) return el;
        el = el.parentElement;
      }
      return document.scrollingElement || document.documentElement;
    }
    const iter = document.evaluate("//*[contains(text(),'Immediately dominated') or contains(text(),'Objects with references')]", document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
    const target = iter.singleNodeValue;
    if (target) {
      const sp = scrollParent(target);
      sp.scrollTop = sp.scrollHeight;
    } else {
      // fallback: scroll all candidates
      for (const el of document.querySelectorAll('*')) {
        if (el.scrollHeight > el.clientHeight) el.scrollTop = el.scrollHeight;
      }
    }
    window.scrollTo(0, document.body.scrollHeight);
  });
  await sleep(1500);
  await page.screenshot({ path: path.join(OUT, '13_object_tab_bottom.png') });
  console.log('wrote 13_object_tab_bottom.png');

  // 03 tab bar — scroll back to top of the object tab so the tab strip is framed.
  await page.evaluate(() => {
    for (const el of document.querySelectorAll('*')) {
      if (el.scrollHeight > el.clientHeight) el.scrollTop = 0;
    }
    window.scrollTo(0, 0);
  });
  await sleep(800);
  await page.screenshot({ path: path.join(OUT, '03_tab_bar.png') });
  console.log('wrote 03_tab_bar.png');

  await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
