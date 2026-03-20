console.log("app.js starting...");
if (typeof deck === 'undefined') {
  console.error("Critical: deck library is not loaded!");
}
const { MapboxOverlay } = deck || {};
const { H3HexagonLayer } = deck || {};

// ===========================
// API Configuration
// ===========================
// Auto-detect: use localhost in development, otherwise relative path or disable backend features
const IS_LOCAL = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
const API_BASE_URL = IS_LOCAL ? 'http://localhost:5000' : '';
const HAS_BACKEND = IS_LOCAL; // Backend features only available locally

console.log(`🌐 Environment: ${IS_LOCAL ? 'Development' : 'Production'}`);
console.log(`📡 Backend API: ${HAS_BACKEND ? 'Available' : 'Disabled'}`);

// Store selected hex for AI prediction (used by createH3Layer)
let selectedHexForPrediction = null;

// ===========================
// 1) Cấu hình vùng ĐBSCL
// ===========================
const MEKONG_BOUNDS = [
  [104.1, 8.0],
  [107.2, 11.6]
];

// ===========================
// 2) Map style vệ tinh (ESRI)
// ===========================
const SATELLITE_WITH_LABEL_STYLE = {
  version: 8,
  sources: {
    esriSat: {
      type: "raster",
      tiles: [
        "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
      ],
      tileSize: 256
    },
    esriLabels: {
      type: "raster",
      tiles: [
        "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}"
      ],
      tileSize: 256
    }
  },
  layers: [
    { id: "satellite", type: "raster", source: "esriSat" },
    { id: "labels", type: "raster", source: "esriLabels" }
  ]
};

// ===========================
// 3) Helper UI
// ===========================
function formatNumber(x, digits = 3) {
  if (x === null || x === undefined || Number.isNaN(x)) return "N/A";
  return Number(x).toFixed(digits);
}

function getRiskColor(risk) {
  if (!risk) return [107, 114, 128, 200];
  const r = String(risk).toLowerCase();
  if (r.includes("high") || r.includes("extreme")) return [239, 68, 68, 220];
  if (r.includes("medium")) return [245, 158, 11, 220];
  if (r.includes("low")) return [16, 185, 129, 220];
  return [107, 114, 128, 200];
}

// ===========================
// Salinity Quartile Color System
// ===========================
let SALINITY_QUARTILES = { q1: 0, q2: 0, q3: 0, min: 0, max: 0 };

// Calculate quartiles from data
function calculateSalinityQuartiles() {
  if (DATA.length === 0) return;
  
  // Get all salinity values (filter out null/undefined)
  const salinities = DATA
    .map(d => d.predicted_salinity !== undefined ? d.predicted_salinity : d.salinity)
    .filter(s => s !== null && s !== undefined && !isNaN(s))
    .sort((a, b) => a - b);
  
  if (salinities.length === 0) return;
  
  const n = salinities.length;
  SALINITY_QUARTILES = {
    min: salinities[0],
    t1: salinities[Math.floor(n * 0.33)],  // Low threshold (33%)
    t2: salinities[Math.floor(n * 0.66)],  // Medium threshold (66%)
    max: salinities[n - 1]
  };
  
  console.log('📊 Salinity Thresholds:', SALINITY_QUARTILES);
}

// Get color based on salinity level (3 levels)
function getSalinityQuartileColor(salinity) {
  if (salinity === null || salinity === undefined || isNaN(salinity)) {
    return [156, 163, 175, 180]; // Gray for no data
  }
  
  const sal = Number(salinity);
  const { t1, t2 } = SALINITY_QUARTILES;
  
  // Thấp (0-33%): Đỏ - Nguy hiểm
  if (sal <= t1) {
    return [239, 68, 68, 220]; // Red
  }
  // Trung bình (33-66%): Cam
  if (sal <= t2) {
    return [245, 158, 11, 220]; // Amber/Orange
  }
  // Cao (66-100%): Xanh lá - An toàn
  return [16, 185, 129, 220]; // Emerald green
}

function getSalinityQuartileLabel(salinity) {
  if (salinity === null || salinity === undefined || isNaN(salinity)) {
    return { label: 'Không có dữ liệu', level: 'N/A', color: '#9ca3af' };
  }
  
  const sal = Number(salinity);
  const { t1, t2 } = SALINITY_QUARTILES;
  
  if (sal <= t1) {
    return { label: 'Thấp', level: 'Low', color: '#ef4444' };
  }
  if (sal <= t2) {
    return { label: 'Trung bình', level: 'Medium', color: '#f59e0b' };
  }
  return { label: 'Cao', level: 'High', color: '#10b981' };
}