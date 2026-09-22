// Builds a small SUPPLEMENTARY feed for the Meta (Facebook/Instagram) "Catalog_Vehicles"
// catalog. This does NOT replace AutoPlay's own Facebook feed (fbookAd.ashx) - that one
// stays the primary data source and keeps handling images, AppLinks, location, price,
// mileage etc, which it already does correctly. This file only overlays a handful of
// fields AutoPlay's Facebook export leaves blank (fuel_type, drivetrain, transmission),
// plus a custom_label_0 price-bracket segment for building prospecting product sets.
//
// Meta merges a supplementary feed onto the primary feed by matching the "id" column
// here to the primary feed's item id. Confirmed by cross-checking: AutoPlay's Google
// feed row.id "29856" (2019 Dodge Challenger Hellcat) is the exact same value shown as
// "Vehicle ID: 29856" on that item in Commerce Manager - so we key off row.id from the
// same AutoPlay source the Google remarketing feed already uses.
//
// The AutoPlay API key is never hardcoded here - read from AUTOPLAY_API_KEY, injected
// by GitHub Actions from a repository secret at run time.
//
// Run with: AUTOPLAY_API_KEY=xxxx node build-meta-supplementary-feed.js

const fs = require('fs');

const AUTOPLAY_ID = '75';
const AUTOPLAY_YARDS = '27';
const OUTPUT_FILE = 'meta-supplementary-feed.csv';

// Meta's supplementary feed field names (must match the catalog's vertical schema
// field names exactly - see Meta's automotive catalog reference).
const OUTPUT_HEADERS = ['id', 'fuel_type', 'drivetrain', 'transmission', 'custom_label_0'];

function csvField(value) {
  const s = value == null ? '' : String(value);
  if (/[",\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function toCsvRow(values) {
  return values.map(csvField).join(',');
}

function parseTsv(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n').filter((l) => l.length > 0);
  const headers = lines[0].split('\t');
  return lines.slice(1).map((line) => {
    const cells = line.split('\t');
    const row = {};
    headers.forEach((h, i) => {
      row[h] = cells[i] !== undefined ? cells[i] : '';
    });
    return row;
  });
}

// Same logic as build-remarketing-feed.js's extractFuelType (kept in sync manually -
// these are small, stable, self-contained scripts like the rest of this repo).
function extractFuelType(row) {
  const d = (row.description || '').toLowerCase();
  if (/plug-?in hybrid|phev/.test(d)) return 'Plug-in Hybrid';
  if (/hybrid/.test(d)) return 'Hybrid';
  if (/\belectric\b|\bev\b|\bbev\b/.test(d)) return 'Electric';
  if (/diesel|\btdi\b|\bcrd\b|\bhdi\b|\bdci\b|\btdci\b|bluetec|d-4d|d4d/.test(d)) return 'Diesel';
  return 'Petrol';
}

// Same logic as build-remarketing-feed.js's extractDrivetrain.
function extractDrivetrain(row) {
  const d = (row.description || '').toLowerCase();
  if (/\b4wd\b|\b4x4\b|4matic|quattro|xdrive|4motion/.test(d)) return '4WD';
  if (/\bawd\b|all-?wheel/.test(d)) return 'AWD';
  return '';
}

// Transmission isn't a discrete AutoPlay field either, but nearly every description
// states it plainly ("AUTO", "6SPD MANUAL" etc). Checked against all 266 current
// vehicles: unambiguous in every case seen, so no "unknown" fallback needed - but if a
// future description doesn't match either pattern, this correctly leaves it blank
// rather than guessing.
function extractTransmission(row) {
  const d = (row.description || '').toLowerCase();
  if (/\bmanual\b|\bmt\b\)?$/.test(d)) return 'Manual';
  if (/\bauto|\bcvt\b|\bdct\b|\btiptronic\b/.test(d)) return 'Automatic';
  // A bare "Nspd" (e.g. "6Spd (Tremec)") with no "auto" anywhere in the description is
  // a manual gearbox spec - manufacturers only bother stating the speed count alongside
  // "manual" or on its own for manuals; automatics are described as "Auto" instead.
  if (/\d\s?spd\b/.test(d)) return 'Manual';
  return '';
}

// custom_label_0 is ours to define - Meta doesn't populate or interpret it. Used here
// as a price-bracket segment so we can build prospecting product sets / ad sets by
// budget tier (e.g. "target shoppers likely to afford $20-40k" ), which nothing else
// in the feed currently expresses (body_style and make/model already exist as their
// own dedicated fields, so a price bracket adds a genuinely new axis rather than
// duplicating one).
function buildPriceBracketLabel(row) {
  // AutoPlay's raw price field includes a " NZD" suffix (confirmed against the live
  // feed - e.g. "164800.00 NZD"), so a plain Number(row.price) would silently produce
  // NaN for every row. Strip everything except digits and the decimal point first.
  const price = Number((row.price || '').replace(/[^0-9.]/g, ''));
  if (!row.price || Number.isNaN(price)) return '';
  if (price < 20000) return 'Under $20k';
  if (price < 40000) return '$20k-$40k';
  if (price < 80000) return '$40k-$80k';
  return '$80k+';
}

async function main() {
  const apiKey = process.env.AUTOPLAY_API_KEY;
  if (!apiKey) {
    console.error('Missing AUTOPLAY_API_KEY environment variable - aborting.');
    process.exit(1);
  }

  const sourceUrl = `https://dataapi.autoplay.co.nz/GoogleAd.ashx?id=${AUTOPLAY_ID}&yards=${AUTOPLAY_YARDS}&format=4&apikey=${apiKey}`;

  console.log('Fetching AutoPlay vehicle feed...');
  const res = await fetch(sourceUrl);
  if (!res.ok) {
    console.error(`AutoPlay feed request failed: ${res.status} ${res.statusText}`);
    process.exit(1);
  }
  const text = await res.text();
  const rows = parseTsv(text);
  console.log(`Parsed ${rows.length} vehicles from AutoPlay feed.`);

  if (rows.length === 0) {
    console.error('No vehicles found in AutoPlay feed - aborting without overwriting the output file.');
    process.exit(1);
  }

  const outLines = [toCsvRow(OUTPUT_HEADERS)];
  for (const row of rows) {
    outLines.push(
      toCsvRow([
        row.id,
        extractFuelType(row),
        extractDrivetrain(row),
        extractTransmission(row),
        buildPriceBracketLabel(row),
      ])
    );
  }

  fs.writeFileSync(OUTPUT_FILE, outLines.join('\n') + '\n');
  console.log(`Wrote ${OUTPUT_FILE} with ${rows.length} vehicles.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
