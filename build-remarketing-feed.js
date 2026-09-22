// Fetches the AutoPlay "Google Ads" vehicle feed (already correctly formatted for
// Google Merchant Center) and reshapes it into the different column layout Google Ads
// needs for a Business Data / dynamic remarketing custom combined feed.
//
// The AutoPlay API key is never hardcoded here - it's read from the
// AUTOPLAY_API_KEY environment variable, which GitHub Actions injects from a
// repository secret at run time. The output file never contains the key.
//
// Run with: AUTOPLAY_API_KEY=xxxx node build-remarketing-feed.js

const fs = require('fs');

const AUTOPLAY_ID = '75';
const AUTOPLAY_YARDS = '27';
const OUTPUT_FILE = 'remarketing-feed.csv';

// 4Guys Autobarn's single dealership address - matches the registered Google
// Business Profile location exactly (Business data > Google My Business locations).
// Used by Google Ads as a proximity signal, not displayed verbatim in the ad.
const DEALERSHIP_ADDRESS = '20 Arthur Porter Drive, Hamilton, 3200, New Zealand';

const OUTPUT_HEADERS = [
  'ID',
  'ID2',
  'Item title',
  'Final URL',
  'Image URL',
  'Item subtitle',
  'Item description',
  'Item category',
  'Price',
  'Sale price',
  'Contextual keywords',
  'Item address',
  'Tracking template',
  'Custom parameter',
  'Final mobile URL',
  'Android app link',
  'iOS app link',
  'iOS app store ID',
  'Formatted price',
  'Formatted sale price',
];

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

function formatMileage(mileage) {
  const n = Number(mileage);
  if (!mileage || Number.isNaN(n)) return '';
  return `${n.toLocaleString('en-NZ')} km`;
}

// Custom parameter values can't contain spaces (Google Ads rejects the whole row
// with "illegal characters in the string" if they do) - e.g. "Land Rover" or "A 180".
function sanitizeParamValue(value) {
  return value.trim().replace(/\s+/g, '_');
}

// Google Ads ad policy disallows "non-standard capitalisation" (shouting in ALL CAPS).
// The AutoPlay feed's titles/descriptions include spec/trim details in full caps
// (e.g. "HELLCAT WIDEBODY", "TURBO DIESEL") which gets every affected vehicle
// disapproved. This converts any all-caps run of 2+ letters to Title Case while
// leaving numbers, model codes with digits (GT350, V8, 6SPD), and short country
// codes untouched.
const CAPITALISATION_ALLOWLIST = new Set(['NZ', 'US', 'UK', 'AU']);

function toStandardCapitalisation(value) {
  if (!value) return value;
  return value.replace(/[A-Za-z]{2,}/g, (word) => {
    if (word !== word.toUpperCase()) return word;
    if (CAPITALISATION_ALLOWLIST.has(word)) return word;
    return word.charAt(0) + word.slice(1).toLowerCase();
  });
}

function buildCustomParameter(row) {
  const parts = [];
  if (row.vehicle_make) parts.push(`{_make}=${sanitizeParamValue(row.vehicle_make)}`);
  if (row.vehicle_model) parts.push(`{_model}=${sanitizeParamValue(row.vehicle_model)}`);
  if (row.vehicle_year) parts.push(`{_year}=${sanitizeParamValue(row.vehicle_year)}`);
  return parts.join(';');
}

// AutoPlay groups SUVs under the label "RV/SUV". These are ordinary SUVs (that's
// just how AutoPlay names the category), not motorhomes. The combined label muddies
// category matching for prospecting, so we normalise it to a clean "SUV".
function normalizeBodyStyle(bodyStyle) {
  if (!bodyStyle) return bodyStyle;
  return bodyStyle.trim() === 'RV/SUV' ? 'SUV' : bodyStyle;
}

// Fuel type isn't a discrete field in the AutoPlay feed, but it's reliably stated in
// the description for diesels, hybrids and EVs. Everything else on a used-car lot is
// petrol, so the remainder defaults to Petrol. This adds a matching signal for
// prospecting / optimised targeting (e.g. a diesel-ute shopper -> our diesel utes).
function extractFuelType(row) {
  const d = (row.description || '').toLowerCase();
  if (/plug-?in hybrid|phev/.test(d)) return 'Plug-in Hybrid';
  if (/hybrid/.test(d)) return 'Hybrid';
  if (/\belectric\b|\bev\b|\bbev\b/.test(d)) return 'Electric';
  if (/diesel|\btdi\b|\bcrd\b|\bhdi\b|\bdci\b|\btdci\b|bluetec|d-4d|d4d/.test(d)) return 'Diesel';
  return 'Petrol';
}

// Drivetrain is another buyer-intent signal that's reliably stated in the description
// (4WD/4x4 utes and SUVs, AWD cars). We only tag it when clearly present - 2WD is
// rarely stated, so those are left blank rather than guessed.
function extractDrivetrain(row) {
  const d = (row.description || '').toLowerCase();
  if (/\b4wd\b|\b4x4\b|4matic|quattro|xdrive|4motion/.test(d)) return '4WD';
  if (/\bawd\b|all-?wheel/.test(d)) return 'AWD';
  return '';
}

function buildContextualKeywords(row) {
  return [
    row.vehicle_make,
    row.vehicle_model,
    row.vehicle_year,
    normalizeBodyStyle(row.vehicle_body_style),
    extractFuelType(row),
    extractDrivetrain(row),
  ]
    .filter(Boolean)
    .join('; ');
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
        '',
        toStandardCapitalisation(row.title),
        row.link,
        row.image_link,
        formatMileage(row.vehicle_mileage),
        toStandardCapitalisation(row.description),
        normalizeBodyStyle(row.vehicle_body_style),
        row.price,
        row.sale_price,
        buildContextualKeywords(row),
        DEALERSHIP_ADDRESS,
        '',
        buildCustomParameter(row),
        '',
        '',
        '',
        '',
        '',
        '',
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
