const cors = require('cors');
const csv = require('csv-parser');
const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = Number(process.env.PORT) || 5000;
const DATA_DIR = process.env.DATA_DIR || path.resolve(__dirname, '..');
const FILE_PATTERN = /^final_train_ai_(\d{4})\.csv$/i;

app.use(cors());
app.use(express.json({ limit: '2mb' }));

const store = {
  datasets: new Map(),
  loadedAt: null,
  files: []
};

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toInt(value) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : null;
}

function normalizeHexRow(year, row) {
  const month = toInt(row.month);
  const hex = String(row.hex || '').trim();

  if (!hex || !month || month < 1 || month > 12) {
    return null;
  }

  return {
    year,
    month,
    hex,
    lat: toNumber(row.lat),
    lon: toNumber(row.lon),
    dist_to_sea: toNumber(row.dist_to_sea),
    dist_to_river: toNumber(row.dist_to_river),
    dem_mean: toNumber(row.altitude),
    solar: toNumber(row.solar),
    temp_c: toNumber(row.temp),
    rain_mm: toNumber(row.rain),
    salinity: toNumber(row.salinity)
  };
}

function ensureYearDataset(year) {
  if (!store.datasets.has(year)) {
    store.datasets.set(year, {
      months: new Set(),
      byMonth: new Map(),
      historyByHex: new Map(),
      rowCount: 0,
      invalidRows: 0,
      sourceFile: ''
    });
  }
  return store.datasets.get(year);
}

function addRecordToDataset(dataset, record) {
  dataset.months.add(record.month);

  if (!dataset.byMonth.has(record.month)) {
    dataset.byMonth.set(record.month, new Map());
  }
  dataset.byMonth.get(record.month).set(record.hex, {
    hex: record.hex,
    lat: record.lat,
    lon: record.lon,
    salinity: record.salinity,
    temp_c: record.temp_c,
    dem_mean: record.dem_mean,
    solar: record.solar,
    rain_mm: record.rain_mm,
    dist_to_sea: record.dist_to_sea,
    dist_to_river: record.dist_to_river
  });

  if (!dataset.historyByHex.has(record.hex)) {
    dataset.historyByHex.set(record.hex, []);
  }
  dataset.historyByHex.get(record.hex).push({
    date: `${record.year}-${String(record.month).padStart(2, '0')}`,
    month: record.month,
    salinity: record.salinity,
    temp_c: record.temp_c,
    dem_mean: record.dem_mean,
    solar: record.solar,
    rain_mm: record.rain_mm,
    dist_to_sea: record.dist_to_sea,
    dist_to_river: record.dist_to_river
  });

  dataset.rowCount += 1;
}

async function importCsvFile(fullPath, year) {
  const dataset = ensureYearDataset(year);
  dataset.sourceFile = path.basename(fullPath);

  await new Promise((resolve, reject) => {
    fs.createReadStream(fullPath)
      .pipe(csv())
      .on('data', rawRow => {
        const record = normalizeHexRow(year, rawRow);
        if (!record) {
          dataset.invalidRows += 1;
          return;
        }
        addRecordToDataset(dataset, record);
      })
      .on('end', resolve)
      .on('error', reject);
  });

  for (const rows of dataset.historyByHex.values()) {
    rows.sort((a, b) => a.month - b.month);
  }
}

async function loadDatasetsFromDisk() {
  const files = await fs.promises.readdir(DATA_DIR);
  const csvFiles = files
    .filter(file => FILE_PATTERN.test(file))
    .sort();

  store.datasets.clear();
  store.files = csvFiles;

  for (const file of csvFiles) {
    const match = file.match(FILE_PATTERN);
    if (!match) continue;
    const year = match[1];
    const fullPath = path.join(DATA_DIR, file);
    await importCsvFile(fullPath, year);
  }

  store.loadedAt = new Date().toISOString();
}

function getSortedYears() {
  return Array.from(store.datasets.keys()).sort();
}

function ensureYear(year) {
  const dataset = store.datasets.get(String(year));
  if (!dataset) {
    return null;
  }
  return dataset;
}

app.get('/api/health', (req, res) => {
  const years = getSortedYears();
  const details = years.map(year => {
    const dataset = store.datasets.get(year);
    return {
      year,
      months: Array.from(dataset.months).sort((a, b) => a - b),
      rows: dataset.rowCount,
      invalidRows: dataset.invalidRows,
      sourceFile: dataset.sourceFile
    };
  });

  res.json({
    status: 'ok',
    loadedAt: store.loadedAt,
    dataDir: DATA_DIR,
    files: store.files,
    years: details
  });
});

app.get('/api/years', (req, res) => {
  res.json(getSortedYears());
});

app.get('/api/months', (req, res) => {
  const year = String(req.query.year || '');
  const dataset = ensureYear(year);

  if (!dataset) {
    return res.status(404).json({ error: `No dataset for year ${year}` });
  }

  const months = Array.from(dataset.months).sort((a, b) => a - b);
  return res.json(months);
});

app.get('/api/hexes', (req, res) => {
  const year = String(req.query.year || '');
  const dataset = ensureYear(year);

  if (!dataset) {
    return res.status(404).json({ error: `No dataset for year ${year}` });
  }

  const months = Array.from(dataset.months).sort((a, b) => a - b);
  const requestedMonth = toInt(req.query.month);
  const month = requestedMonth && dataset.byMonth.has(requestedMonth)
    ? requestedMonth
    : months[0];

  const byHex = dataset.byMonth.get(month) || new Map();
  const rows = Array.from(byHex.values());

  return res.json({
    year,
    month,
    count: rows.length,
    data: rows
  });
});

app.get('/api/history/:hex', (req, res) => {
  const year = String(req.query.year || '');
  const hex = String(req.params.hex || '').trim();
  const dataset = ensureYear(year);

  if (!dataset) {
    return res.status(404).json({ error: `No dataset for year ${year}` });
  }

  const history = dataset.historyByHex.get(hex);
  if (!history || history.length === 0) {
    return res.status(404).json({ error: `No history found for hex ${hex}` });
  }

  return res.json({
    year,
    hex,
    data: history
  });
});

app.post('/api/reload', async (req, res) => {
  try {
    await loadDatasetsFromDisk();
    return res.json({ ok: true, loadedAt: store.loadedAt, files: store.files });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

app.get('/', (req, res) => {
  res.send('Hacka CSV backend is running. Use /api/health');
});

async function bootstrap() {
  try {
    await loadDatasetsFromDisk();
    app.listen(PORT, () => {
      console.log(`CSV backend listening on http://localhost:${PORT}`);
      console.log(`Loaded files: ${store.files.join(', ') || '(none found)'}`);
    });
  } catch (error) {
    console.error('Failed to bootstrap backend:', error);
    process.exit(1);
  }
}

bootstrap();
