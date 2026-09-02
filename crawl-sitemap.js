// Crawls the live 4Guys Autobarn vehicle listing page and generates a sitemap.xml
// listing every currently-live vehicle detail URL.
//
// Why this exists: Squarespace's own sitemap.xml excludes content rendered inside
// code/embed blocks (which is how the AutoPlay VDP widget renders each vehicle),
// so the ~280 individual vehicle pages never appear in Squarespace's native sitemap.
// This script fills that gap by reading the same public listing page a visitor sees.
//
// Run with: node crawl-sitemap.js
// Requires: npm install (installs Playwright), then npx playwright install --with-deps chromium

const { chromium } = require('playwright');
const fs = require('fs');

const LISTING_URL = 'https://www.4guys.co.nz/vehicles';
const DETAIL_BASE = 'https://www.4guys.co.nz/vehicle-details/';
const OUTPUT_FILE = 'sitemap.xml';
const MAX_PAGES = 200; // safety cap, real page count is driven by current stock

function nowIso() {
  return new Date().toISOString().split('T')[0];
}

async function getVisibleIds(page) {
  return page.evaluate(() => {
    const anchors = Array.from(document.querySelectorAll('a')).filter(
      (a) => a.textContent.trim() === 'View Details'
    );
    const ids = anchors
      .map((a) => {
        const m = a.href.match(/id=(\d+)/);
        return m ? m[1] : null;
      })
      .filter(Boolean);
    return [...new Set(ids)];
  });
}

// Waits until the set of vehicle ids on the page stops changing (page has
// finished rendering/hydrating) before reading it as final for that page.
async function waitForStableIds(page, { checks = 25, intervalMs = 400, requiredStableReads = 3 } = {}) {
  let last = await getVisibleIds(page);
  let stableCount = 0;
  for (let i = 0; i < checks; i++) {
    await page.waitForTimeout(intervalMs);
    const cur = await getVisibleIds(page);
    const same = cur.length === last.length && cur.every((id) => last.includes(id));
    if (same) {
      stableCount++;
      if (stableCount >= requiredStableReads && cur.length > 0) return cur;
    } else {
      stableCount = 0;
    }
    last = cur;
  }
  return last;
}

async function crawlAllVehicleIds() {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  await page.goto(LISTING_URL, { waitUntil: 'networkidle' });

  // The widget remembers the last page you viewed in browser storage and can
  // reopen there on a fresh load. Clear it and reload so we always start at page 1.
  await page.evaluate(() => {
    try { localStorage.clear(); } catch (e) {}
    try { sessionStorage.clear(); } catch (e) {}
  });
  await page.reload({ waitUntil: 'networkidle' });

  const allIds = new Set();
  const firstPageIds = await waitForStableIds(page);
  firstPageIds.forEach((id) => allIds.add(id));

  for (let target = 2; target <= MAX_PAGES; target++) {
    const link = await page.$(`a[href$="#page-${target}"]`);
    if (!link) break; // no more pages — reached the end of current stock
    await link.click();
    const ids = await waitForStableIds(page);
    ids.forEach((id) => allIds.add(id));
  }

  await browser.close();
  return [...allIds];
}

function buildSitemapXml(ids) {
  const lastmod = nowIso();
  const urlEntries = ids
    .map((id) => {
      const loc = `${DETAIL_BASE}?id=${id}`;
      return `  <url>\n    <loc>${loc}</loc>\n    <lastmod>${lastmod}</lastmod>\n  </url>`;
    })
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urlEntries}\n</urlset>\n`;
}

(async () => {
  console.log(`Crawling ${LISTING_URL} ...`);
  const ids = await crawlAllVehicleIds();
  console.log(`Found ${ids.length} live vehicle listings.`);

  if (ids.length === 0) {
    console.error('No vehicle IDs found — aborting without overwriting sitemap.xml (likely a site issue, not an empty inventory).');
    process.exit(1);
  }

  const xml = buildSitemapXml(ids);
  fs.writeFileSync(OUTPUT_FILE, xml);
  console.log(`Wrote ${OUTPUT_FILE} with ${ids.length} URLs.`);
})();
