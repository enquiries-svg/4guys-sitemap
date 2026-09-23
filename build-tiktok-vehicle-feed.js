// Builds the vehicle inventory feed for TikTok's dedicated "Auto - Inventory" catalog
// (TikTok Automotive Ads), which is a different, richer field schema than the generic
// e-commerce catalog fields TikTok's Google-Merchant-Center import currently produces
// (title/description/brand/condition/price only - no make/model/year/mileage/body
// style/drivetrain/dealer location, so it can't support real dynamic prospecting).
//
// Field list and requirements taken from TikTok's own docs:
// https://ads.tiktok.com/help/article/available-fields-for-automotive-ads-inventory-catalogs
//
// Same source and approach as build-meta-vehicle-feed.js: fetches AutoPlay's own
// Facebook vehicle feed directly (no API key needed, confirmed field-for-field already
// for the Meta feed) and reshapes/renames its columns into TikTok's Automotive Ads
// header names. This is a separate output file/catalog from the Meta feed - TikTok's
// Automotive Ads catalog is a brand-new catalog (TikTok's Catalog Manager doesn't let
// an existing "E-commerce" industry catalog be converted to "Auto - Inventory" in
// place), so nothing about the existing "Vehicles" (E-commerce) catalog or campaign
// changes when this is added.
//
// Fields intentionally left blank (no reliable source data, so left out rather than
// guessed): vin (not present in AutoPlay's feed), condition (TikTok's
// EXCELLENT/GOOD/FAIR/POOR grading is subjective and not something AutoPlay reports -
// don't confuse with state_of_vehicle, which IS populated, for New/Used/CPO), trim,
// interior_color, date_first_on_lot, days_on_lot, custom_number_0-4, dealer_id,
// dealer_phone, stock_number, ios_url, android_url.
//
// Run with: node build-tiktok-vehicle-feed.js

const fs = require('fs');

const AUTOPLAY_ID = '75';
const AUTOPLAY_YARDS = '27';
const SOURCE_URL = `https://data.autoplay.co.nz/fbookAd.ashx?id=${AUTOPLAY_ID}&yardList=${AUTOPLAY_YARDS}&type=3`;
const OUTPUT_FILE = 'tiktok-vehicle-feed.csv';

const OUTPUT_HEADERS = [
  'vehicle_id', 'title', 'description', 'url', 'make', 'model', 'year',
  'mileage.value', 'mileage.unit', 'image_link', 'transmission', 'body_style',
  'drivetrain', 'price', 'exterior_color', 'state_of_vehicle', 'fuel_type',
  'sale_price', 'availability', 'vehicle_type', 'address.addr1', 'address.city',
  'address.region', 'address.country', 'latitude', 'longitude', 'dealer_name',
];

function csvField(value) {
  const s = value == null ? '' : String(value);
  return `"${s.replace(/"/g, '""')}"`;
}

function toCsvRow(values) {
  return values.map(csvField).join(',');
}

// Same minimal state-machine CSV parser as build-meta-vehicle-feed.js.
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

function stripHtml(value) {
  if (!value) return value;
  return value
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s+,/g, ',')
    .trim();
}

const CAPITALISATION_ALLOWLIST = new Set([
  'NZ', 'US', 'UK', 'AU',
  'AWD', 'FWD', 'RWD', 'WD', 'GST', 'ABS', 'ESP', 'DSG', 'CVT', 'TDI', 'GTI', 'GT', 'RS', 'SS', 'ST', 'SRT',
  'SUV', 'UTE', 'RV', 'LED', 'GPS', 'USB',
]);

function smartTitleCase(value) {
  if (!value) return value;
  return value.replace(/[A-Za-z]{2,}/g, (word) => {
    if (word !== word.toUpperCase()) return word;
    if (CAPITALISATION_ALLOWLIST.has(word)) return word;
    return word.charAt(0) + word.slice(1).toLowerCase();
  });
}

function extractFuelType(row) {
  const d = (row.description || '').toLowerCase();
  if (/plug-?in hybrid|phev/.test(d)) return 'HYBRID'; // no distinct plug-in-hybrid value in TikTok's enum
  if (/hybrid/.test(d)) return 'HYBRID';
  if (/\belectric\b|\bev\b|\bbev\b/.test(d)) return 'ELECTRIC';
  if (/diesel|\btdi\b|\bcrd\b|\bhdi\b|\bdci\b|\btdci\b|bluetec|d-4d|d4d/.test(d)) return 'DIESEL';
  return 'GASOLINE';
}

function extractTransmission(row) {
  const d = (row.description || '').toLowerCase();
  if (/\bmanual\b|\bmt\b\)?$/.test(d)) return 'Manual';
  if (/\bauto|\bcvt\b|\bdct\b|\btiptronic\b/.test(d)) return 'Automatic';
  if (/\d\s?spd\b/.test(d)) return 'Manual';
  return '';
}

// TikTok's drivetrain enum is 4X2, 4X4, AWD, FWD, RWD, Other - narrower and
// differently-spelled than Meta's. Only flag what's clearly stated; leave blank
// (optional field) rather than guess FWD/RWD/4X2 for the common case where the
// description doesn't say either way.
function extractDrivetrain(row) {
  const d = (row.description || '').toLowerCase();
  if (/\b4wd\b|\b4x4\b|4matic|quattro|xdrive|4motion/.test(d)) return '4X4';
  if (/\bawd\b|all-?wheel/.test(d)) return 'AWD';
  return '';
}

// AutoPlay's body_style values seen in production (post smart-title-case): Coupe,
// SUV, Hatchback, Sedan, Van, Convertible, Other - plus the "RV/SUV" combined label
// AutoPlay sometimes uses. TikTok requires one of a fixed enum (CONVERTIBLE, COUPE,
// HATCHBACK, MINIVAN, TRUCK, SUV, SEDAN, VAN, WAGON, CROSSOVER, SMALL_CAR, OTHER) -
// map what we've actually seen and fall back to OTHER for anything unrecognised
// (e.g. utes/pickups, which AutoPlay's own feed doesn't break out separately and
// lumps into "Other" - confirmed against the current 266-vehicle export, not
// verified against every possible future value, so OTHER is the safe default here
// rather than guessing TRUCK for a body style we haven't actually seen AutoPlay use).
const BODY_STYLE_MAP = {
  'RV/SUV': 'SUV',
  SUV: 'SUV',
  Coupe: 'COUPE',
  Hatchback: 'HATCHBACK',
  Sedan: 'SEDAN',
  Van: 'VAN',
  Convertible: 'CONVERTIBLE',
  Wagon: 'WAGON',
  Ute: 'TRUCK',
  Truck: 'TRUCK',
  Crossover: 'CROSSOVER',
};

function mapBodyStyle(rawBodyStyle) {
  const cleaned = (rawBodyStyle || '').trim();
  return BODY_STYLE_MAP[cleaned] || 'OTHER';
}

// TikTok wants Title Case (New / Used / CPO); AutoPlay's own feed sends this field
// as all-caps ("USED").
function mapStateOfVehicle(raw) {
  const v = (raw || '').trim().toUpperCase();
  if (v === 'NEW') return 'New';
  if (v === 'CPO' || v === 'CERTIFIED PRE-OWNED') return 'CPO';
  return 'Used';
}

// Same 800x600 upsize as build-meta-vehicle-feed.js and build-remarketing-feed.js -
// same image.ashx endpoint, just requesting the existing photo larger.
function upsizeImageUrl(url) {
  if (!url) return url;
  return url.replace(/([?&])w=\d+/, '$1w=800').replace(/([?&])h=\d+/, '$1h=600');
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

  const outLines = [toCsvRow(OUTPUT_HEADERS)];
  for (const row of rows) {
    const title = smartTitleCase(row.title);
    const description = smartTitleCase(row.description);
    outLines.push(
      toCsvRow([
        row.vehicle_id,
        title,
        description,
        row.URL,
        row.make,
        row.model,
        row.year,
        row['mileage.value'],
        row['mileage.unit'],
        upsizeImageUrl(row['image[0].url']),
        extractTransmission(row),
        mapBodyStyle(smartTitleCase(row.body_style)),
        extractDrivetrain(row),
        row.price,
        smartTitleCase(row.exterior_color),
        mapStateOfVehicle(row.state_of_vehicle),
        extractFuelType(row),
        row.sale_price,
        'available', // feed only ever lists current, in-stock vehicles
        'car_truck', // 4Guys sells cars/SUVs/utes, not boats/motorcycles/RVs
        stripHtml(row['address.addr1']),
        row['address.city'],
        row['address.region'],
        row['address.country'],
        row.latitude,
        row.longitude,
        '4Guys Autobarn',
      ])
    );
  }

  fs.writeFileSync(OUTPUT_FILE, outLines.join('\n') + '\n');
  console.log(`Wrote ${OUTPUT_FILE} with ${rows.length} vehicles (${OUTPUT_HEADERS.length} columns).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
