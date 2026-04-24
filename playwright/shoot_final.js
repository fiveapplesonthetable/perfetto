// Final shoot: re-take everything that referenced old class names, plus before/after verification shots.

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const OUT    = path.resolve(__dirname, '..', 'screenshots');
const UI     = 'http://127.0.0.1:10000';
const DUMPS  = path.resolve(__dirname, '..', 'dumps');

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function primeContext(ctx) {
  await ctx.addInitScript(() => { try { localStorage.setItem('cookieAck','true'); } catch {} });
}
async function loadTrace(page, file) {
  await page.goto(UI, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(800);
  await page.locator('input[type=file]').first().setInputFiles(file);
  await page.waitForFunction(() => (document.body.innerText||'').includes('Heapdump Explorer'), { timeout: 240_000 });
  await sleep(4500);
}
async function openHash(page, hash, probe, to=25000) {
  await page.evaluate(h => { window.location.hash = h; }, hash);
  if (probe) await page.waitForFunction(p => (document.body.innerText||'').includes(p), probe, { timeout: to }).catch(() => {});
  await sleep(3000);
}
async function full(page, name) {
  const p = path.join(OUT, name);
  await page.screenshot({ path: p });
  console.log('shot', name);
}
async function clickExactText(page, text, parents='button.ah-link') {
  return await page.evaluate(({t, sel}) => {
    for (const el of document.querySelectorAll(sel)) {
      if ((el.textContent || '').trim() === t) {
        el.scrollIntoView({ block: 'center' });
        el.click();
        return true;
      }
    }
    return false;
  }, { t: text, sel: parents });
}
async function clickRegex(page, regex, parents='button.ah-link') {
  return await page.evaluate(({src, flags, sel}) => {
    const rx = new RegExp(src, flags);
    for (const el of document.querySelectorAll(sel)) {
      const t = (el.textContent || '').trim();
      if (rx.test(t)) {
        el.scrollIntoView({ block: 'center' });
        el.click();
        return t;
      }
    }
    return null;
  }, { src: regex.source, flags: regex.flags, sel: parents });
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    viewport: { width: 1920, height: 1200 },
    deviceScaleFactor: 2,
  });
  await primeContext(ctx);

  // ========= BEFORE (HPROF) =========
  console.log('=== BEFORE HPROF ===');
  const p1 = await ctx.newPage();
  p1.on('pageerror', e => console.error('pageerror:', e.message));
  await loadTrace(p1, path.join(DUMPS, 'before.hprof'));

  // Re-shoot shots that referenced old class names.
  await openHash(p1, '#!/heapdump', 'General Information');
  await full(p1, '04_overview.png');

  await openHash(p1, '#!/heapdump/classes', 'com.heapleak.ProfileActivity', 45_000);
  await full(p1, '05_classes.png');

  await openHash(p1, '#!/heapdump/dominators', 'Root Type');
  await full(p1, '07_dominators.png');

  await openHash(p1, '#!/heapdump/bitmaps', 'Total bitmaps');
  await full(p1, '08_bitmaps_gallery.png');
  // Toggle Show Paths.
  try {
    await p1.getByText('Show Paths', { exact: false }).first().click({ timeout: 5000 });
    await sleep(3000);
    await full(p1, '09_bitmaps_showpaths.png');
  } catch (e) { console.warn('Show Paths miss:', e.message); }

  // ProfileActivity object tab flow.
  await openHash(p1, '#!/heapdump/classes', 'com.heapleak.ProfileActivity', 45_000);
  const gotCls = await clickExactText(p1, 'com.heapleak.ProfileActivity');
  console.log('clicked class:', gotCls);
  await sleep(4500);
  await full(p1, '12a_objects_profile_activity.png');
  const objT = await clickRegex(p1, /^ProfileActivity\s+0x[0-9a-fA-F]+$/);
  console.log('clicked obj:', objT);
  await p1.waitForFunction(() => (document.body.innerText||'').includes('Reference Path from GC Root') || (document.body.innerText||'').includes('Reference path from GC root') || (document.body.innerText||'').includes('Object Info'), { timeout: 25_000 }).catch(() => {});
  await sleep(3500);
  await full(p1, '12_object_tab_top.png');
  await p1.evaluate(() => {
    for (const el of document.querySelectorAll('*')) {
      if (el.scrollHeight > el.clientHeight) el.scrollTop = el.scrollHeight;
    }
    window.scrollTo(0, document.body.scrollHeight);
  });
  await sleep(1500);
  await full(p1, '13_object_tab_bottom.png');

  await p1.evaluate(() => {
    for (const el of document.querySelectorAll('*')) if (el.scrollHeight > el.clientHeight) el.scrollTop = 0;
    window.scrollTo(0, 0);
  });
  await sleep(800);
  await full(p1, '03_tab_bar.png');

  await p1.close();

  // ========= AFTER (HPROF, fixed) =========
  console.log('=== AFTER HPROF ===');
  const p2 = await ctx.newPage();
  p2.on('pageerror', e => console.error('pageerror:', e.message));
  await loadTrace(p2, path.join(DUMPS, 'after.hprof'));

  // Fixed Overview: duplicate bitmaps group should be gone.
  await openHash(p2, '#!/heapdump', 'General Information');
  await full(p2, 'fixed_overview.png');

  // Fixed Classes: ProfileActivity Count should be 0 or 1.
  await openHash(p2, '#!/heapdump/classes', 'java.lang.String', 45_000);
  await full(p2, 'fixed_classes_full.png');

  // Fixed Classes filter to ProfileActivity specifically.
  await p2.evaluate(() => {
    const inp = document.querySelector('input[placeholder], input[type=text]');
    if (inp) { inp.focus(); inp.value = 'ProfileActivity'; inp.dispatchEvent(new Event('input', {bubbles:true})); }
  });
  await sleep(2000);
  await full(p2, 'fixed_classes_profileactivity_filter.png');

  // Fixed Bitmaps gallery: at most 1 copy.
  await openHash(p2, '#!/heapdump/bitmaps', 'Total bitmaps');
  await full(p2, 'fixed_bitmaps_gallery.png');

  await p2.close();

  // ========= BEFORE (pftrace) =========
  console.log('=== BEFORE pftrace (flamegraph) ===');
  const p3 = await ctx.newPage();
  p3.on('pageerror', e => console.error('pageerror:', e.message));
  await loadTrace(p3, path.join(DUMPS, 'before.pftrace'));
  await p3.waitForFunction(() => !(document.body.innerText||'').includes('Computing graph'), { timeout: 60_000 }).catch(() => {});
  await sleep(2500);
  await full(p3, '14_flamegraph_bottom_panel.png');

  await browser.close();
  console.log('=== DONE ===');
})().catch(e => { console.error('FATAL', e); process.exit(1); });
