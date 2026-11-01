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
const FEED_URL = 'https://data.autoplay.co.nz/fbookAd.ashx?id=75&yardList=27&type=3';
const CONCURRENCY = 4;
const PAGE_TIMEOUT_MS = 30000;

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
  ['sunroof', /sunroof|moonroof|panoramic/i],
  ['roof_rails', /roof rails/i],
  ['nz_new', /^nz new/i],
  ['parking_sensors', /parking sensors|parking assist/i],
  ['blind_spot', /blind spot/i],
  ['lane_assist', /lane assist|lane keep/i],
  ['keyless', /keyless/i],
  ['navigation', /navigation/i],
  ['service_history', /service history/i],
  ['power_tailgate', /power tailgate|electric tailgate|power boot/i],
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
async function expandReadMore(page) {
  const sel = 'button.vdp-btn-readmore-features, button.vdp-btn-readmore-comments';
  for (let round = 0; round < 3; round++) {
    const buttons = page.locator(sel).filter({ hasText: /read more/i })
      .or(page.getByRole('button', { name: /^\s*read more\s*$/i }));
    const n = await buttons.count();
    if (n === 0) return true;
    for (let i = n - 1; i >= 0; i--) {
      try { await buttons.nth(i).click({ timeout: 5000 }); } catch (e) { /* retried next round */ }
    }
    await page.waitForTimeout(400);
  }
  return (await page.getByRole('button', { name: /^\s*read more\s*$/i }).count()) === 0;
}

function deriveFields(vdp, title) {
  const f = vdp.features;
  const num = (re) => { const x = f.find((s) => re.test(s)); const m = x && x.match(/(\d+)/); return m ? +m[1] : null; };
  const seats = /^\d+$/.test(vdp.seats) ? +vdp.seats : num(/^\d+ Seater$/);
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
    transmission: /manual/i.test(vdp.transmission) ? 'Manual' : 'Automatic',
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
  const out = []; const failed = [];
  let next = 0;

  async function worker() {
    const page = await ctx.newPage();
    while (next < ids.length) {
      const id = ids[next++];
      const row = feed[id];
      if (!row) { failed.push([id, 'not in AutoPlay feed']); continue; }
      try {
        await page.goto(`https://www.4guys.co.nz/vehicle-details?id=${id}`, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT_MS });
        await page.waitForFunction(() => document.body.textContent.includes('SPECIFICATIONS') && document.body.textContent.includes('DESCRIPTION'), null, { timeout: PAGE_TIMEOUT_MS });
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
          description: vdp.description.slice(0, 600),
        });
      } catch (err) {
        failed.push([id, err.message.split('\n')[0]]);
      }
    }
    await page.close();
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  await browser.close();

  console.log(`Read ${out.length}/${ids.length} vehicles. ${failed.length} failed.`);
  failed.forEach(([id, why]) => console.warn(`  ${id}: ${why}`));

  // Don't publish a half-empty index over a good one if the site was having a bad night.
  if (out.length < ids.length * 0.8) {
    console.error('Fewer than 80% of vehicles read - keeping the previous vehicles.json.');
    process.exit(1);
  }

  out.sort((a, b) => a.price - b.price);
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify({ updated: new Date().toISOString(), count: out.length, vehicles: out }));
  console.log(`Wrote ${OUTPUT_FILE} (${out.length} vehicles).`);
}

main().catch((err) => { console.error(err); process.exit(1); });
