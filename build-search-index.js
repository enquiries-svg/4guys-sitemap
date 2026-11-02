// Builds vehicles.json, the data file behind the homepage vehicle search.
//
// The ad feeds (remarketing, Meta, TikTok) only carry headline fields: title, price,
// km, body, fuel. The search needs the full AutoPlay "Features" list from each
// vehicle detail page (seat count, Isofix (2), Child Restraints (4), Towbar,
// CarPlay, 360 camera etc.), which only exists on the rendered page. So this opens
// every vehicle page listed in sitemap.xml (written earlier in the same workflow
// run by crawl-sitemap.js) with Playwright, reads the Specifications / Features /
// Description blocks, then joins that with AutoPlay's Facebook feed for the clean
// title, price, make/model and photo URL.
//
// Rules that keep search results honest:
//   - A feature is only tagged if AutoPlay lists it. Nothing is inferred from what a
//     model "usually" has.
//   - Some listings have a near-empty features list (e.g. the 2019 Challenger only
//     lists "5 Seater"). Those get features_listed < 10, and the search widget treats
//     their missing features as "not listed" rather than "doesn't have it".
//   - Fuel comes from the page's Fuel field and the title, never from AutoPlay's
//     "Electric" feature label, which also appears on diesel and petrol vehicles.
//
// Run with: node build-search-index.js   (after crawl-sitemap.js)

const { chromium } = require('playwright');
const fs = require('fs');

const SITEMAP_FILE = 'sitemap.xml';
const OUTPUT_FILE = 'vehicles.json';
const FEED_URL = process.env.FEED_URL || 'https://data.autoplay.co.nz/fbookAd.ashx?id=75&yardList=27&type=3';
const SITE = process.env.SITE_URL || 'https://www.4guys.co.nz'; // both overridable for local testing
const CONCURRENCY = 4;
const PAGE_TIMEOUT_MS = 30000;
// Stop starting new vehicles after this long, so a slow night can't hold up the
// commit step (which also publishes the sitemap and ad feeds).
const TIME_BUDGET_MS = 15 * 60 * 1000;

// The scraper must not count as a visitor. Without this, every run would send ~250
// vehicle views to GA4 (incl. the data.4guys.co.nz tagging server), Google Ads
// remarketing, Meta and TikTok, inflating traffic and putting bots in audiences.
// Photos, video and fonts are skipped too: the search only needs the page text.
const BLOCKED_HOSTS = /(^|\.)(google-analytics\.com|googletagmanager\.com|doubleclick\.net|googleadservices\.com|googlesyndication\.com|data\.4guys\.co\.nz|analytics\.tiktok\.com|connect\.facebook\.net|facebook\.com|clarity\.ms|hotjar\.com|tawk\.to)$/i;
const BLOCKED_PATHS = /^https:\/\/www\.google\.[a-z.]+\/(rmkt|ccm|pagead|ads)\//i;
const BLOCKED_TYPES = new Set(['image', 'media', 'font']);
// AutoPlay loads Google's tag library as one link in a chain of scripts, so the
// library files themselves still load. Only the requests that record a visit
// (collect/rmkt/ccm/pagead beacons and the pixels) are blocked.
const ALLOWED_SCRIPTS = /\/(gtag\/js|gtm\.js)(\?|$)/;

// AutoPlay feature label -> search tag. Keep in sync with FEAT in the widget.
const FEATURE_TAGS = [
  ['towbar', /^towbar/i],
  ['carplay', /carplay|android auto/i],
  ['camera_360', /360/],
  ['reversing_camera', /backing camera|reversing camera/i],
  ['adaptive_cruise', /adaptive cruise/i],
  ['cruise', /^cruise control/i],
  ['leather', /^leather|partial leather/i],
  ['heated_seats', /heated seats/i],
  ['cooled_seats', /cooled (&|and) vented|ventilated seats|cooled seats/i], // not "Turbo Intercooled"
  ['sunroof', /sun ?roof|moon ?roof|panoramic/i], // "Sun Roof", "Dual Sunroof"
  ['roof_rails', /roof (rails?|racks?)/i],
  ['nz_new', /^nz new/i],
  ['parking_sensors', /parking sensors|parking assist/i],
  ['blind_spot', /blind spot/i],
  ['lane_assist', /lane assist|lane keep/i],
  ['keyless', /keyless|push button start/i],
  ['navigation', /navigation/i],
  ['service_history', /service history/i],
  ['power_tailgate', /(power|electric|gesture|hands.?free) (tailgate|boot)/i], // "Electric Boot", "Gesture Tailgate"
  ['heated_wheel', /heated (s\/wheel|steering)/i],
];

function idsFromSitemap() {
  const xml = fs.readFileSync(SITEMAP_FILE, 'utf8');
  return [...xml.matchAll(/vehicle-details\/?\?id=(\d+)/g)].map((m) => m[1]);
}

// Same tolerant CSV parser approach as build-meta-vehicle-feed.js.
function parseCsv(text) {
  const rows = []; let row = []; let field = ''; let q = false;
  const src = text.replace(/\r\n/g, '\n');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q) { if (c === '"') { if (src[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const h = rows[0];
  return rows.slice(1).filter((r) => r.length === h.length).map((r) => Object.fromEntries(h.map((k, i) => [k, r[i]])));
}

// Runs inside the page. Reads the AutoPlay VDP blocks by their headings.
// Checked against live listings (Outlander XLS, X-Trail ST-L, Challenger Hellcat and a
// 59-vehicle sample) on 30 Oct 2026.
function readVdp() {
  // innerText keeps the line breaks the label/value layout relies on.
  const t = document.body.innerText;
  const between = (a, b) => {
    const i = t.indexOf(a); if (i < 0) return '';
    const j = t.indexOf(b, i + a.length);
    return t.slice(i + a.length, j < 0 ? i + a.length + 4000 : j);
  };
  const label = (name, block) => {
    const m = block.match(new RegExp(name + '\\s*\\n\\s*([^\\n]+)'));
    return m ? m[1].trim() : '';
  };
  // expandReadMore() has already opened every Read More, so the visible text should be
  // complete. As a backstop (a button that didn't open), the smallest element whose
  // textContent holds the block also has the full text; whichever is longer wins. When
  // still collapsed, AutoPlay's "..." lands mid-word ("P...ush Button Start").
  const smallest = (re) => [...document.querySelectorAll('div,p,span,li')]
    .map((e) => e.textContent).filter((x) => re.test(x)).sort((a, b) => a.length - b.length)[0] || '';
  const clean = (s) => s.replace(/Read (More|Less)/g, '').replace(/\.\.\.(?=\w)/g, '').replace(/\.\.\./g, '').replace(/\s+/g, ' ').trim();
  const head = between('Odometer', 'PRINT');
  const specs = between('SPECIFICATIONS', 'FEATURES');
  const featureBlock = clean(between('FEATURES', 'DESCRIPTION'));
  const firstFeature = featureBlock.split(',')[0].trim();
  let full = firstFeature ? clean(smallest(new RegExp('^\\s*' + firstFeature.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*,'))) : '';
  if (full.length < featureBlock.length) full = featureBlock;
  const features = full.split(/\s*,\s*/).filter(Boolean);
  const descShort = clean(between('DESCRIPTION', 'RELATED CARS'));
  const descStart = descShort.slice(0, 40);
  let description = descStart ? clean(smallest(new RegExp(descStart.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))) : '';
  if (description.length < descShort.length) description = descShort;
  description = description.replace(/^.*?DESCRIPTION\s*/, '').replace(/^4 FREE bonuses.*?T&C apply\.\s*/, '');
  return {
    seats: label('Seats', head), fuel: label('Fuel', head), economy: label('Consumption', head),
    transmission: label('Transmission', specs), bodyType: label('Body Type', specs),
    colour: label('Colour', specs), stockNo: label('Stock No', specs),
    features, description,
  };
}

// AutoPlay shows the first part of the Features list and the Description, then a
// "Read More" button (button.vdp-btn-readmore-features / -comments). Always click every
// one before reading, so the scraper sees exactly what a customer sees once they expand
// it. Checked live 31 Oct 2026: the button reveals text already in the page and loads no
// extra vehicle data, but clicking guards against AutoPlay changing that. Returns true
// once no "Read More" is left showing.
let loggedClickProblem = false;
async function expandReadMore(page) {
  const sel = 'button.vdp-btn-readmore-features, button.vdp-btn-readmore-comments';
  const stillCollapsed = () => page.evaluate((s) => [...document.querySelectorAll(s)]
    .filter((b) => /read more/i.test(b.textContent)).length, sel);
  for (let round = 0; round < 3; round++) {
    const buttons = page.locator(sel).filter({ hasText: /read more/i });
    const n = await buttons.count();
    if (n === 0) return true;
    for (let i = n - 1; i >= 0; i--) {
      const b = buttons.nth(i);
      try {
        await b.click({ timeout: 3000 });
      } catch (err) {
        // Something on the page (a banner, sticky bar) took the click. Press the
        // button directly instead: same handler as a real click, ignores overlays.
        if (!loggedClickProblem) { loggedClickProblem = true; console.warn(`  normal Read More click refused, pressing it directly instead: ${err.message.split('\n')[0]}`); }
        try { await b.evaluate((el) => el.click()); } catch (e) { /* retried next round */ }
      }
    }
    await page.waitForTimeout(300);
  }
  return (await stillCollapsed()) === 0;
}

function deriveFields(vdp, title) {
  const f = vdp.features;
  const num = (re) => { const x = f.find((s) => re.test(s)); const m = x && x.match(/(\d+)/); return m ? +m[1] : null; };
  let seats = /^\d+$/.test(vdp.seats) ? +vdp.seats : num(/^\d+ Seater$/);
  // Hand-written listings (mostly American) often only state seats in the description,
  // e.g. "COUPE (4 SEATER)" or "Five seats". Read it from the full text, not the trimmed copy.
  if (seats == null) {
    const m = `${title} ${vdp.description}`.match(/\b(two|three|four|five|six|seven|eight|nine|ten|[2-9]|10)[ -]?(seater|seats?|passenger)\b/i);
    if (m) seats = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 }[m[1].toLowerCase()] || +m[1];
  }
  const drive = f.some((s) => /4WD|4X4|AWD|Quattro|xDrive/i.test(s)) ? '4WD/AWD'
    : f.some((s) => /^(2WD|RWD|FWD)$/.test(s)) ? '2WD' : null;
  const fuelText = `${title} ${vdp.fuel}`;
  const fuel = /phev|plug-?in/i.test(fuelText) ? 'plug-in hybrid'
    : /hybrid/i.test(fuelText) ? 'hybrid'
    : /\belectric\b|\bev\b/i.test(vdp.fuel) ? 'electric'
    : /diesel|tdi/i.test(fuelText) ? 'diesel' : 'petrol';
  const tags = FEATURE_TAGS.filter(([, re]) => f.some((s) => re.test(s))).map(([k]) => k);
  if (/\(NZ NEW\)/i.test(title) && !tags.includes('nz_new')) tags.push('nz_new');
  const econ = parseFloat(vdp.economy);
  return {
    seats, isofix: num(/^Isofix/i), child_restraints: num(/^Child Restraints/i), drive, fuel,
    // The spec field says "Man" or "Auto"; fall back to the features list ("5 Speed Manual")
    // and the title ("6SPD MANUAL") in case it is blank.
    transmission: (/^man/i.test(vdp.transmission) || (!vdp.transmission && (f.some((s) => /\bmanual\b/i.test(s)) || /\bmanual\b/i.test(title)))) ? 'Manual' : 'Automatic',
    economy: Number.isFinite(econ) ? econ : null, airbags: num(/AirBags/i),
    features_listed: f.length, features: f, tags,
  };
}

function normaliseBody(feedBody, vdpBody, title) {
  const b = (vdpBody || feedBody || '').toUpperCase();
  if (/SUV/.test(b)) return 'SUV';
  if (/UTILITY|\bUTE\b|double cab|d\/cab|dual cab|pick-?up|hilux|ranger|navara|triton|colorado|\bram\b|silverado|f150/i.test(`${b} ${title}`)) return 'Ute';
  if (/HATCH/.test(b)) return 'Hatchback';
  if (/SEDAN/.test(b)) return 'Sedan';
  if (/WAGON|ESTATE/.test(b)) return 'Wagon';
  if (/VAN|PEOPLE MOVER|MINIVAN|COACH|BUS/.test(b)) return 'Van';
  if (/COUPE|CONVERTIBLE/.test(b)) return 'Coupe';
  return 'Other';
}

async function main() {
  const ids = idsFromSitemap();
  if (!ids.length) { console.error('sitemap.xml has no vehicle ids - aborting.'); process.exit(1); }

  const feedRes = await fetch(FEED_URL);
  if (!feedRes.ok) { console.error(`AutoPlay feed failed: ${feedRes.status}`); process.exit(1); }
  const feed = Object.fromEntries(parseCsv(await feedRes.text()).map((r) => [String(r.URL).split('id=')[1], r]));

  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  await ctx.route('**/*', (route) => {
    const req = route.request();
    let host = '';
    try { host = new URL(req.url()).hostname; } catch (e) { /* data: etc */ }
    if (BLOCKED_TYPES.has(req.resourceType())) return route.abort();
    if (ALLOWED_SCRIPTS.test(req.url()) && req.resourceType() === 'script') return route.continue();
    if (BLOCKED_HOSTS.test(host) || BLOCKED_PATHS.test(req.url())) return route.abort();
    return route.continue();
  });
  const started = Date.now();
  let done = 0; let skipped = 0;
  const out = []; const failed = [];
  let next = 0;

  async function worker() {
    const page = await ctx.newPage();
    while (next < ids.length) {
      if (Date.now() - started > TIME_BUDGET_MS) { skipped = ids.length - next; next = ids.length; break; }
      const id = ids[next++];
      const row = feed[id];
      if (!row) { failed.push([id, 'not in AutoPlay feed']); continue; }
      try {
        await page.goto(`${SITE}/vehicle-details?id=${id}`, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT_MS });
        // innerText, not textContent: the headings are "Specifications"/"Description" in the
        // page source and only shown in capitals by CSS.
        await page.waitForFunction(() => document.body.innerText.includes('SPECIFICATIONS') && document.body.innerText.includes('DESCRIPTION'), null, { timeout: PAGE_TIMEOUT_MS });
        const expanded = await expandReadMore(page);
        const vdp = await page.evaluate(readVdp);
        if (!expanded) console.warn(`  ${id}: a Read More button would not open; used the hidden page text instead`);
        const title = row.title;
        out.push({
          id, url: row.URL, title, make: row.make, model: row.model, year: +row.year,
          price: Math.round(Number(String(row.price).replace(/[^0-9.]/g, ''))),
          km: +row['mileage.value'] || 0,
          body: normaliseBody(row.body_style, vdp.bodyType, title),
          colour: vdp.colour || row.exterior_color,
          image: String(row['image[0].url'] || '').replace(/([?&])w=\d+/, '$1w=480').replace(/([?&])h=\d+/, '$1h=360'),
          ...deriveFields(vdp, title),
          // Hand-written listings keep the full description: it is their feature list.
          description: vdp.description.slice(0, (vdp.features.length < 10 || /^(dodge|chevrolet|chrysler|jeep|ram|gmc|cadillac|lincoln)$/i.test(row.make) || /mustang|f-?150|f-?250|f-?350|bronco/i.test(title)) ? 4000 : 600),
        });
      } catch (err) {
        failed.push([id, err.message.split('\n')[0]]);
      }
      if (++done % 25 === 0) console.log(`  ${done}/${ids.length} pages (${out.length} read, ${failed.length} failed) after ${Math.round((Date.now() - started) / 1000)}s`);
    }
    await page.close();
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  await browser.close();

  console.log(`Read ${out.length}/${ids.length} vehicles in ${Math.round((Date.now() - started) / 1000)}s. ${failed.length} failed${skipped ? `, ${skipped} skipped (time budget)` : ''}.`);
  failed.forEach(([id, why]) => console.warn(`  ${id}: ${why}`));

  // Health checks. Anything below makes the step (and so the whole run) fail, which is
  // what triggers GitHub's failed-run email. "::error::" lines show up in that email and
  // at the top of the run page, so the reason is visible without opening the log.
  const alert = (msg) => console.log(`::error title=Vehicle search::${msg}`);
  const pageErrors = failed.filter(([, why]) => why !== 'not in AutoPlay feed').length;
  const median = (a) => { const x = [...a].sort((p, q) => p - q); return x.length ? x[x.length >> 1] : 0; };
  const medianFeatures = median(out.map((v) => v.features_listed));
  const seatsKnown = out.length ? out.filter((v) => v.seats != null).length / out.length : 0;

  // 1. Too few vehicles read: the site was down or blocked us. Keep yesterday's file.
  if (out.length < ids.length * 0.8) {
    alert(`Only ${out.length} of ${ids.length} vehicles could be read. Kept the previous vehicles.json, so the homepage search is showing older stock.`);
    process.exit(1);
  }
  // 2. Pages loaded but the details came back empty: AutoPlay has probably changed the
  //    vehicle page layout. Publishing this would break search results, so keep yesterday's.
  if (medianFeatures < 15 || seatsKnown < 0.6) {
    alert(`Vehicle pages loaded but the details look wrong (typical features per car: ${medianFeatures}, seat count found on ${Math.round(seatsKnown * 100)}%). AutoPlay may have changed their page layout. Kept the previous vehicles.json.`);
    process.exit(1);
  }

  out.sort((a, b) => a.price - b.price);
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify({ updated: new Date().toISOString(), count: out.length, vehicles: out }));
  console.log(`Wrote ${OUTPUT_FILE} (${out.length} vehicles, typical features per car ${medianFeatures}, seats known on ${Math.round(seatsKnown * 100)}%).`);

  // 3. Published, but worth a look: a noticeable number of pages errored or the run ran
  //    out of time. The new file is still used; the run is marked failed so you hear about it.
  const warnings = [];
  if (pageErrors > ids.length * 0.05) warnings.push(`${pageErrors} vehicle pages failed to load`);
  if (skipped) warnings.push(`${skipped} vehicles skipped because the run hit its 15 minute limit`);
  if (warnings.length) {
    alert(`Search updated with ${out.length} vehicles, but ${warnings.join(' and ')}. Check the run log.`);
    process.exit(2);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
