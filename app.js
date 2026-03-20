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

// ===========================
// 4) DOM elements
// ===========================
const infoPanel = document.getElementById("infoPanel");
const legendBox = document.getElementById("legendBox");
const infoContent = document.getElementById("infoContent");
const tooltip = document.getElementById("tooltip");

// Ẩn toàn bộ UI phụ khi load
infoPanel.style.display = "none";
legendBox.style.display = "none";
tooltip.style.display = "none";

function setInfo(html, show = false) {
  infoContent.innerHTML = html;
  if (show) {
    infoPanel.style.display = "block";
    legendBox.style.display = "block";
  }
}

// ===========================
// 5) Reverse Geocoding
// ===========================
async function reverseGeocode(lat, lon) {
  try {
    // Try direct Nominatim API (works in production without backend)
    const nominatimUrl = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&accept-language=vi`;
    
    const res = await fetch(nominatimUrl, {
      headers: {
        'User-Agent': 'MekongSalinityH3Demo/1.0 (https://github.com/mekong-salinity)'
      }
    });
    
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    console.warn("Geocode fetch error:", err);
    return null;
  }
}

function extractAdminName(geo) {
  if (!geo || !geo.address)
    return { district: "Không rõ", province: "Không rõ" };

  const a = geo.address;
  return {
    district: a.county || a.district || a.city_district || a.town || a.suburb || "Không rõ",
    province: a.state || a.city || "Không rõ"
  };
}

// ===========================
// 6) Tạo MapLibre
// ===========================
const map = new maplibregl.Map({
  container: "map",
  style: SATELLITE_WITH_LABEL_STYLE,
  center: [105.6, 9.9],
  zoom: 8.2,
  pitch: 35,
  maxBounds: MEKONG_BOUNDS
});

map.addControl(new maplibregl.NavigationControl(), "top-right");

// ===========================
// 7) DeckGL Overlay
// ===========================
const overlay = new MapboxOverlay({ layers: [] });
map.addControl(overlay);

// ===========================
// 8) Data & Layer
// ===========================
let DATA = [];
let HEX_ENABLED = false;
let CURRENT_HEX = null; // Track active hex
let CURRENT_PROBLEM = null; // 'drought' or 'mangrove'
let SELECTED_YEAR = HAS_BACKEND ? '2021' : '2022';
let SELECTED_MONTH = 1;
let AVAILABLE_YEARS = [];
let HEX_HOVER_ENABLED = true;

function setHexHoverEnabled(enabled) {
  if (HEX_HOVER_ENABLED === enabled) return;
  HEX_HOVER_ENABLED = enabled;
  tooltip.style.display = "none";
  if (HEX_ENABLED) {
    renderLayers();
  }
}

function clearHexSelection() {
  selectedHexForPrediction = null;
  CURRENT_HEX = null;
  HEX_HOVER_ENABLED = true;
  tooltip.style.display = "none";
  dashboardModal.style.display = 'none';
  renderLayers();
}

function isWithinMekongBounds(lat, lon) {
  const minLat = MEKONG_BOUNDS[0][1];
  const maxLat = MEKONG_BOUNDS[1][1];
  const minLon = MEKONG_BOUNDS[0][0];
  const maxLon = MEKONG_BOUNDS[1][0];
  return lat >= minLat && lat <= maxLat && lon >= minLon && lon <= maxLon;
}

function getMangroveColor(pct) {
  if (pct === null || pct === undefined || Number.isNaN(pct)) return [156,163,175,200];
  const v = Math.max(0, Math.min(100, Number(pct)));
  // more mangrove -> greener
  const g = Math.round(160 + (v / 100) * 95);
  const r = Math.round(120 - (v / 100) * 80);
  return [r, g, 64, 220];
}

function createH3Layer() {
  const selectedHexId = selectedHexForPrediction?.hex || CURRENT_HEX;

  return new H3HexagonLayer({
    id: "h3-layer",
    data: DATA,
    h3Lib: h3,

    pickable: true,
    filled: true,
    extruded: true,

    getHexagon: d => d.hex,
    // Color based on salinity quartiles
    getFillColor: d => {
      // Highlight selected hex for prediction with different color
      if (selectedHexId && d.hex === selectedHexId) {
        return [56, 189, 248, 245]; // Cyan-blue highlight (close to hover feel)
      }
      // Use salinity quartile color
      const sal = d.predicted_salinity !== undefined ? d.predicted_salinity : d.salinity;
      return getSalinityQuartileColor(sal);
    },

    getLineColor: d => {
      // Thicker white border for selected hex
      if (selectedHexId && d.hex === selectedHexId) {
        return [14, 116, 144, 255]; // Strong border for selected hex
      }
      return [255, 255, 255, 120];
    },
    lineWidthMinPixels: 1,
    
    // Make selected hex line thicker
    getLineWidth: d => {
      if (selectedHexId && d.hex === selectedHexId) {
        return 5;
      }
      return 1;
    },

    getElevation: d => {
      // Elevate selected hex higher
      if (selectedHexId && d.hex === selectedHexId) {
        const sal = d.predicted_salinity || d.salinity || 0;
        return Number(sal) * 2500 + 900; // Extra elevation for selected hex visibility
      }
      
      if (CURRENT_PROBLEM === 'mangrove') {
        // lower elevation for more mangrove (visual inversion)
        return ((100 - (Number(d.mangrove) || 0)) / 100) * 800;
      }
      // Use predicted_salinity if available
      const sal = d.predicted_salinity || d.salinity || 0;
      return Number(sal) * 2500;
    },
    elevationScale: 1,

    autoHighlight: HEX_HOVER_ENABLED,
    highlightColor: [168, 85, 247, 220],
    updateTriggers: {
      autoHighlight: [HEX_HOVER_ENABLED],
      getFillColor: [selectedHexId],
      getLineColor: [selectedHexId],
      getLineWidth: [selectedHexId],
      getElevation: [selectedHexId]
    },

    /* ======================
       HOVER: tooltip gọn nhẹ
       ====================== */
    onHover: info => {
      if (!HEX_ENABLED || !HEX_HOVER_ENABLED || !info.object) {
        tooltip.style.display = "none";
        return;
      }

      const o = info.object;

      tooltip.style.display = "block";
      tooltip.style.left = `${info.x + 8}px`;
      tooltip.style.top = `${info.y + 8}px`;

      // Content depends on selected problem
      if (CURRENT_PROBLEM === 'mangrove') {
        tooltip.innerHTML = `
          <div style="font-weight:600;">HEX ${o.hex.slice(0, 8)}…</div>
          <div>Mangrove: <b>${formatNumber(o.mangrove, 1)} %</b></div>
        `;
      } else {
        // Get salinity and quartile info
        const sal = o.predicted_salinity !== undefined ? o.predicted_salinity : o.salinity;
        const quartileInfo = getSalinityQuartileLabel(sal);
        const salLabel = o.predicted_salinity !== undefined
          ? `${formatNumber(o.predicted_salinity, 3)} ‰ (AI)` 
          : `${formatNumber(o.salinity, 3)} ‰`;
        const isPredicted = o.predicted_salinity !== undefined ? '🤖' : '';
        
        tooltip.innerHTML = `
          <div style="font-weight:600;">${isPredicted} HEX ${o.hex.slice(0, 8)}…</div>
          <div>Độ mặn: <b>${salLabel}</b></div>
          <div>Phân vị: <b style="color:${quartileInfo.color}">${quartileInfo.label}</b></div>
        `;
      }
    },

    /* ======================
       CLICK: popup trong suốt
       ====================== */
    onClick: async info => {
      if (!HEX_ENABLED) return;

      // Click ra ngoài hex → đóng popup
      if (!info.object) {
        infoPanel.style.display = "none";
        legendBox.style.display = "none";
        return;
      }

      const o = info.object;

      CURRENT_HEX = o.hex;
      selectedHexForPrediction = o;
      renderLayers();
      
      // Open Dashboard with all data
      openDashboard(o);

      // Disable old Info Panel logic
      /*
      if (CURRENT_PROBLEM === 'mangrove') {
         ... old logic ...
      }
      */
    }
  });
}
