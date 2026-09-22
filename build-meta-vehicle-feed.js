// Builds the FULL primary feed for the Meta (Facebook/Instagram) "Catalog_Vehicles"
// catalog, replacing AutoPlay's own Facebook feed (fbookAd.ashx) as the data source
// Commerce Manager points at.
//
// Why replace it instead of overlaying a supplementary feed: Meta's self-serve
// Commerce Manager UI does not support true supplementary-feed merging for the
// "Vehicles" catalog vertical - every additional feed added via Data sources > Add is
// validated as a brand-new, complete product feed (requiring price, image, model,
// mileage etc. on every row), not merged onto existing items by vehicle_id. Confirmed
// by testing: 266/266 rows failed both with header "id" and with the correct Meta
// field name "vehicle_id". The Product data rules engine (regex replace / find &
// replace) was also checked and can only transform a field using its OWN existing
// value, not derive one field from another (e.g. fuel_type from description), so it
// can't help either. See /areas/4guys-meta-ads-3.md for the full investigation.
//
// This script instead MIRRORS AutoPlay's real Facebook feed byte-for-byte (fetched
// directly from the same data.autoplay.co.nz endpoint Commerce Manager already uses -
// confirmed field-for-field against a live export: vehicle_id, year, make, model,
// description, body_style, drivetrain, mileage.value, mileage.unit, URL, title, price,
// state_of_vehicle, exterior_color, address.addr1, address.city, address.region,
// address.country, latitude, longitude, sale_price, image[0].url - 22 columns, always
// present, no embedded commas/quotes seen in practice) and adds only the columns
// AutoPlay's own feed doesn't have: fuel_type, transmission, and a custom_label_0
// price-bracket segment. Every field AutoPlay already populates correctly (images,
// AppLinks-equivalent URL, location, price, mileage, drivetrain where known) passes
// through completely unchanged - this is a strict superset of the working feed, not a
// rebuild from a weaker source, so it carries far less risk to the three live ad
// campaigns than reconstructing the feed from Google's differently-shaped export would.
//
// No API key is required for this endpoint (confirmed: Commerce Manager's own "Data
// file" URL for the existing primary feed is the same URL with no apikey parameter).
//
// Run with: node build-meta-vehicle-feed.js

const fs = require('fs');

const AUTOPLAY_ID = '75';
const AUTOPLAY_YARDS = '27';
const SOURCE_URL = `https://data.autoplay.co.nz/fbookAd.ashx?id=${AUTOPLAY_ID}&yardList=${AUTOPLAY_YARDS}&type=3`;
const OUTPUT_FILE = 'meta-vehicle-feed.csv';

// The extra columns we append after AutoPlay's own 22 columns.
const EXTRA_HEADERS = ['fuel_type', 'transmission', 'custom_label_0'];

function csvField(value) {
  const s = value == null ? '' : String(value);
  // Always quote, matching AutoPlay's own feed style exactly (every field is quoted
  // there regardless of content), and double up any embedded quotes per CSV rules.
  return `"${s.replace(/"/g, '""')}"`;
}

function toCsvRow(values) {
  return values.map(csvField).join(',');
}

// Minimal state-machine CSV parser (handles quoted fields with embedded commas,
// newlines and doubled-quote escaping) - AutoPlay's feed hasn't been seen to need any
// of that in practice, but parsing it properly costs little and avoids a silent
// mis-split if a future description ever contains a comma.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const src = text.replace(/\r\n/g, '\n');

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  const headers = rows[0];
  return rows
    .slice(1)
    .filter((r) => r.length === headers.length && r.some((v) => v.length > 0))
    .map((r) => {
      const obj = {};
      headers.forEach((h, i) => {
        obj[h] = r[i];
      });
      return obj;
    });
}

// Same logic as build-remarketing-feed.js's extractFuelType.
function extractFuelType(row) {
  const d = (row.description || '').toLowerCase();
  if (/plug-?in hybrid|phev/.test(d)) return 'Plug-in Hybrid';
  if (/hybrid/.test(d)) return 'Hybrid';
  if (/\belectric\b|\bev\b|\bbev\b/.test(d)) return 'Electric';
  if (/diesel|\btdi\b|\bcrd\b|\bhdi\b|\bdci\b|\btdci\b|bluetec|d-4d|d4d/.test(d)) return 'Diesel';
  return 'Petrol';
}

// Transmission isn't a discrete AutoPlay field, but nearly every description states it
// plainly ("AUTO", "6SPD MANUAL" etc). Validated against all 266 current vehicles.
function extractTransmission(row) {
  const d = (row.description || '').toLowerCase();
  if (/\bmanual\b|\bmt\b\)?$/.test(d)) return 'Manual';
  if (/\bauto|\bcvt\b|\bdct\b|\btiptronic\b/.test(d)) return 'Automatic';
  if (/\d\s?spd\b/.test(d)) return 'Manual';
  return '';
}

// custom_label_0 is ours to define - a price-bracket segment for prospecting product
// sets / ad sets by budget tier. AutoPlay's price field here is "164800 NZD" (no
// decimal point, unlike the Google feed's "164800.00 NZD"), so strip everything
// except digits and the decimal point before parsing either way.
function buildPriceBracketLabel(row) {
  const price = Number((row.price || '').replace(/[^0-9.]/g, ''));
  if (!row.price || Number.isNaN(price)) return '';
  if (price < 20000) return 'Under $20k';
  if (price < 40000) return '$20k-$40k';
  if (price < 80000) return '$40k-$80k';
  return '$80k+';
}

async function main() {
  console.log('Fetching AutoPlay Facebook vehicle feed...');
  const res = await fetch(SOURCE_URL);
  if (!res.ok) {
    console.error(`AutoPlay feed request failed: ${res.status} ${res.statusText}`);
    process.exit(1);
  }
  const text = await res.text();
  const rows = parseCsv(text);
  console.log(`Parsed ${rows.length} vehicles from AutoPlay feed.`);

  if (rows.length === 0) {
    console.error('No vehicles found in AutoPlay feed - aborting without overwriting the output file.');
    process.exit(1);
  }

  const sourceHeaders = Object.keys(rows[0]);
  const outputHeaders = [...sourceHeaders, ...EXTRA_HEADERS];

  const outLines = [toCsvRow(outputHeaders)];
  for (const row of rows) {
    const values = sourceHeaders.map((h) => row[h]);
    values.push(extractFuelType(row), extractTransmission(row), buildPriceBracketLabel(row));
    outLines.push(toCsvRow(values));
  }

  fs.writeFileSync(OUTPUT_FILE, outLines.join('\n') + '\n');
  console.log(`Wrote ${OUTPUT_FILE} with ${rows.length} vehicles (${outputHeaders.length} columns).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
