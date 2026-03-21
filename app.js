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
dashboardModal.style.display = 'block';
  // Ensure expanded on new click
  const container = dashboardModal.firstElementChild;
  if(container.classList.contains('collapsed')) {
    container.classList.remove('collapsed');
    if(btnToggle) btnToggle.innerText = '🔽';
  }
  
  // Fetch and Render Chart with selected Year
  fetchHexHistory(hexData.hex, SELECTED_YEAR);

  // Fetch Location Name
  try {
    if (typeof h3 === 'undefined') {
      dashboardTitle.innerText = `HEX ${hexData.hex.slice(0,8)}...`;
      return;
    }
    
    const [lat, lon] = h3.cellToLatLng(hexData.hex);
    // Show coords immediately as fallback
    const coordText = `📍 ${lat.toFixed(4)}, ${lon.toFixed(4)}`;
    dashboardTitle.innerText = coordText;

    const geo = await reverseGeocode(lat, lon);
    
    if (geo && !geo.error) {
      const admin = extractAdminName(geo);
      if (admin.district !== "Không rõ" || admin.province !== "Không rõ") {
        dashboardTitle.innerText = `📍 ${admin.district}, ${admin.province}`;
      }
      // else keep coordinates
    }
    // If geo is null or has error, coordinates are already displayed
  } catch (e) {
    console.error("Geocode error:", e);
    // Keep whatever was last set (coordinates or hex)
  }
}

function renderTimeline(data) {
  // Restore canvas if it was replaced with message
  const chartBody = document.querySelector('.chart-body');
  if (chartBody && !chartBody.querySelector('canvas')) {
    chartBody.innerHTML = '<canvas id="timelineChart"></canvas>';
  }
  
  const canvas = document.getElementById('timelineChart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  
  const labels = data.map(d => d.date);
  const salinities = data.map(d => d.salinity);

  if (timelineChart) {
    timelineChart.destroy();
  }

  // Salinity gradient (blue theme)
  const gradientSalinity = ctx.createLinearGradient(0, 0, 0, 300);
  gradientSalinity.addColorStop(0, 'rgba(59, 130, 246, 0.3)');
  gradientSalinity.addColorStop(1, 'rgba(59, 130, 246, 0.0)');

  timelineChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: labels,
      datasets: [
        {
          label: 'Độ mặn (‰)',
          data: salinities,
          borderColor: '#3b82f6',
          backgroundColor: gradientSalinity,
          borderWidth: 3,
          pointRadius: 4,
          pointBackgroundColor: '#3b82f6',
          pointBorderColor: '#fff',
          pointBorderWidth: 2,
          pointHoverRadius: 7,
          tension: 0.4,
          fill: true
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        mode: 'index',
        intersect: false,
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: 'rgba(255, 255, 255, 0.95)',
          titleColor: '#1e293b',
          bodyColor: '#334155',
          borderColor: '#e2e8f0',
          borderWidth: 1,
          padding: 10,
          usePointStyle: true,
          displayColors: true,
          callbacks: {
            label: function(context) {
              return `Độ mặn: ${context.parsed.y.toFixed(3)} ‰`;
            }
          }
        }
      },
      scales: {
        x: {
          ticks: { color: '#64748b', font: { size: 11 } },
          grid: { color: '#f1f5f9' },
          border: { display: false }
        },
        y: {
          type: 'linear',
          display: true,
          position: 'left',
          grid: { color: '#f1f5f9', borderDash: [5, 5] },
          ticks: { 
            color: '#3b82f6', 
            font: { weight: '600' },
            callback: function(value) {
              return value.toFixed(2) + ' ‰';
            }
          },
          border: { display: false },
          title: {
            display: true,
            text: 'Độ mặn (‰)',
            color: '#3b82f6',
            font: { weight: '600' }
          }
        }
      }
    }
  });
}

// Controls
const btnToggle = document.getElementById('btnToggleDashboard');
if(btnToggle){
  btnToggle.addEventListener('click', () => {
    dashboardModal.firstElementChild.classList.toggle('collapsed');
    // Change icon based on state
    if (dashboardModal.firstElementChild.classList.contains('collapsed')) {
      btnToggle.innerText = '▶️';
    } else {
      btnToggle.innerText = '🔽';
    }
  });
}

document.getElementById('chkTemp').addEventListener('change', (e) => {
  if (timelineChart) timelineChart.setDatasetVisibility(0, e.target.checked);
  if (timelineChart) timelineChart.update();
});

document.getElementById('chkSolar').addEventListener('change', (e) => {
  if (timelineChart) timelineChart.setDatasetVisibility(1, e.target.checked);
  if (timelineChart) timelineChart.update();
});

document.getElementById('btnCloseDashboard').addEventListener('click', () => {
  dashboardModal.style.display = 'none';
});

// Close when clicking outside - REMOVED for floating panel
/*
dashboardModal.addEventListener('click', (e) => {
  if (e.target === dashboardModal) {
    dashboardModal.style.display = 'none';
  }
});
*/

async function fetchHexHistory(hexId, year = '2022') {
  // Get hex data from loaded DATA array (no backend needed!)
  const hexData = DATA.find(d => d.hex === hexId);
  
  if (!hexData) {
    console.warn("Hex not found in DATA:", hexId);
    if (timelineChart) timelineChart.destroy();
    return;
  }
  
  // Generate monthly timeline data from available hex properties
  const timelineData = generateTimelineFromHex(hexData, year);
  renderTimeline(timelineData);
}

// Generate simulated monthly salinity data for full year (Jan-Dec)
function generateTimelineFromHex(hexData, year) {
  const months = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12'];
  
  // Get base salinity value (predicted or original)
  const baseSalinity = hexData.predicted_salinity !== undefined 
    ? hexData.predicted_salinity 
    : (hexData.salinity || 0.3);
  
  // Seasonal variation patterns for salinity (typical for Mekong Delta)
  // Dry season (Jan-May): Higher salinity as freshwater decreases
  // Wet season (Jun-Dec): Lower salinity due to increased rainfall and river flow
  const salinityVariation = [
    0.85, 0.95, 1.05, 1.15, 1.10,  // Jan-May (mùa khô - độ mặn cao)
    0.75, 0.55, 0.45, 0.40, 0.50, 0.60, 0.70  // Jun-Dec (mùa mưa - độ mặn thấp)
  ];
  
  return months.map((m, i) => ({
    date: `${year}-${m}`,
    salinity: baseSalinity * salinityVariation[i] + (Math.random() - 0.5) * 0.02
  }));
}

function renderLayers() {
  if (!HEX_ENABLED) {
    overlay.setProps({ layers: [] });
    tooltip.style.display = "none";
    return;
  }
  overlay.setProps({ layers: [createH3Layer()] });
}

// ===========================
// 9) Load data dynamically based on year
// ===========================
function loadDataForYear(year) {
  const dataFile = `./data${year}.json`;
  console.log(`Loading data for year ${year} from ${dataFile}...`);
  
  fetch(dataFile)
    .then(res => {
      if (!res.ok) {
        throw new Error(`Failed to load ${dataFile}`);
      }
      return res.json();
    })
    .then(data => {
      DATA = data;
      console.log(`✅ Loaded ${DATA.length} hexagons for year ${year}`);
      
      // Calculate salinity quartiles for color mapping
      calculateSalinityQuartiles();
      
      // Re-render if hex is enabled
      if (HEX_ENABLED) {
        renderLayers();
      }
    })
    .catch(error => {
      console.error(`❌ Error loading data for year ${year}:`, error);
      alert(`Không thể tải dữ liệu cho năm ${year}. Vui lòng chạy script generate_2025_data.py trước.`);
    });
}

// Load initial data for 2022
loadDataForYear(SELECTED_YEAR);

// ===========================
// 10) Nút Bật / Tắt Hex
// ===========================
const hexToggle = document.getElementById('hexToggle');
const hexToggleText = document.getElementById('hexToggleText');

function syncHexToggleUI() {
  if (!hexToggleText || !hexToggle) return;
  const isOn = !!hexToggle.checked;
  hexToggleText.textContent = `Hex: ${isOn ? 'Bật' : 'Tắt'}`;
  hexToggleText.classList.toggle('on', isOn);
}

if (hexToggle) {
  // đồng bộ lần đầu
  hexToggle.checked = HEX_ENABLED;
  syncHexToggleUI();

  hexToggle.addEventListener('change', () => {
    HEX_ENABLED = hexToggle.checked;
    syncHexToggleUI();
    renderLayers();

    if (!HEX_ENABLED) {
      infoPanel.style.display = "none";
      legendBox.style.display = "none";
    }
  });
}

// ===========================
// Year selector logic
// ===========================
const btnYear = document.getElementById('btnYear');
const yearMenu = document.getElementById('yearMenu');
setYearButtonLabel();

btnYear.addEventListener('click', (e) => {
  e.stopPropagation();
  // Toggle Flex/None for dropdown
  yearMenu.style.display = yearMenu.style.display === 'flex' ? 'none' : 'flex';
});

yearMenu.addEventListener('click', (e) => {
  const target = e.target.closest('.yearOption');
  if (!target) return;

  e.preventDefault();
  const y = target.dataset.year;
  if (!y) {
    yearMenu.style.display = 'none';
    return;
  }

  if (y !== SELECTED_YEAR) {
    SELECTED_YEAR = y;
    setYearButtonLabel();
    yearMenu.style.display = 'none';
    loadDataForYear(SELECTED_YEAR);

    if (dashboardModal.style.display !== 'none' && CURRENT_HEX) {
      console.log("Refreshing chart for new year:", SELECTED_YEAR);
      fetchHexHistory(CURRENT_HEX, SELECTED_YEAR);
    }
  } else {
    yearMenu.style.display = 'none';
  }
});

// ===========================
// AI Prediction Button Logic
// ===========================
const btnXGBoost = document.getElementById('btnXGBoost');
const xgboostPanel = document.getElementById('xgboostPanel');
const btnCoordSearch = document.getElementById('btnCoordSearch');
const coordSearchPanel = document.getElementById('coordSearchPanel');
const coordLatInput = document.getElementById('coordLatInput');
const coordLonInput = document.getElementById('coordLonInput');
const btnCoordSearchSubmit = document.getElementById('btnCoordSearchSubmit');
const btnCoordSearchClear = document.getElementById('btnCoordSearchClear');

// Show AI button for all years (not just 2025)
if (btnXGBoost) {
  btnXGBoost.style.display = 'flex';
}

if (btnXGBoost && xgboostPanel) {
  btnXGBoost.addEventListener('click', () => {
    const isVisible = xgboostPanel.style.display === 'block';
    
    if (isVisible) {
      // Hide panel
      xgboostPanel.style.display = 'none';
      btnXGBoost.innerText = 'Dự báo độ mặn (AI)';
    } else {
      // Show panel
      xgboostPanel.style.display = 'block';
      infoPanel.style.display = 'none';
      legendBox.style.display = 'none';
      btnXGBoost.innerText = 'Đóng AI Panel';
    }
  });
}

if (btnCoordSearch && coordSearchPanel) {
  btnCoordSearch.addEventListener('click', () => {
    const isVisible = coordSearchPanel.style.display === 'block';
    coordSearchPanel.style.display = isVisible ? 'none' : 'block';
  });
}

if (btnCoordSearchSubmit) {
  btnCoordSearchSubmit.addEventListener('click', () => {
    const lat = parseFloat(coordLatInput.value);
    const lon = parseFloat(coordLonInput.value);

    if (Number.isNaN(lat) || Number.isNaN(lon)) {
      alert('Vui lòng nhập đầy đủ Vĩ độ và Kinh độ.');
      return;
    }

    if (!isWithinMekongBounds(lat, lon)) {
      alert('Toạ độ ngoài vùng ĐBSCL. Vui lòng nhập trong giới hạn: Lat 8.0-11.6, Lon 104.1-107.2.');
      return;
    }

    const label = `Toạ độ nhập tay (${lat.toFixed(4)}, ${lon.toFixed(4)})`;
    selectLocation(lat, lon, label);
  });
}

if (btnCoordSearchClear) {
  btnCoordSearchClear.addEventListener('click', () => {
    clearHexSelection();
  });
}

// ===========================
// AI Prediction Logic (Client-side)
// ===========================
const btnPredict = document.getElementById('btnPredict');
const btnPredictAll = document.getElementById('btnPredictAll');
const predictionResult = document.getElementById('predictionResult');
const resultContent = document.getElementById('resultContent');

// Current selected model
let SELECTED_MODEL = 'xgboost';

// Model selector buttons
const modelBtns = document.querySelectorAll('.model-btn');
modelBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    modelBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    SELECTED_MODEL = btn.dataset.model;
    console.log('Selected model:', SELECTED_MODEL);
  });
});

// ===========================
// XGBoost Model (Simplified)
// ===========================
const XGBOOST_THRESHOLDS = {
  low: 0.5096,
  high: 0.6151
};

function predictXGBoost(temp, dem, solar, rain, hr) {
  // Coefficients based on XGBoost feature importance
  const BASE = 0.35;
  const tempContrib = (temp - 27) * 0.025;
  const demContrib = (3 - dem) * 0.03;
  const solarContrib = (solar - 2300) * 0.00008;
  const rainContrib = rain ? (100 - rain) * 0.001 : 0.05;
  const hrContrib = hr ? (80 - hr) * 0.002 : 0;
  
  let salinity = BASE + tempContrib + demContrib + solarContrib + rainContrib + hrContrib;
  return Math.max(0.1, Math.min(2.0, salinity));
}

// ===========================
// SMRI Model (Ridge Regression)
// ===========================
const SMRI_COEFFICIENTS = {
  intercept: 0.5838,
  temp: -0.0536,      // Nhiệt độ (normalized)
  solar: -0.00267,    // Bức xạ (normalized)
  rain: 0.01224,      // Mưa (normalized)
  humidity: -0.01243, // Độ ẩm (normalized)
  dem: 0.02653        // Cao độ (normalized)
};

const SMRI_THRESHOLDS = {
  low: 0.196,
  high: 0.241
};

// Normalization ranges (approximate from training data)
const SMRI_RANGES = {
  temp: { min: 25, max: 32 },
  solar: { min: 2000, max: 2800 },
  rain: { min: 0, max: 200 },
  humidity: { min: 60, max: 90 },
  dem: { min: 0, max: 10 }
};

function normalize(value, min, max) {
  return (value - min) / (max - min);
}

function predictSMRI(temp, dem, solar, rain, hr) {
  // Normalize inputs
  const normTemp = normalize(temp, SMRI_RANGES.temp.min, SMRI_RANGES.temp.max);
  const normSolar = normalize(solar, SMRI_RANGES.solar.min, SMRI_RANGES.solar.max);
  const normRain = normalize(rain, SMRI_RANGES.rain.min, SMRI_RANGES.rain.max);
  const normHr = normalize(hr, SMRI_RANGES.humidity.min, SMRI_RANGES.humidity.max);
  const normDem = normalize(dem, SMRI_RANGES.dem.min, SMRI_RANGES.dem.max);
  
  // Ridge regression: y = intercept + Σ(coef * x)
  let smri = SMRI_COEFFICIENTS.intercept
    + SMRI_COEFFICIENTS.temp * normTemp
    + SMRI_COEFFICIENTS.solar * normSolar
    + SMRI_COEFFICIENTS.rain * normRain
    + SMRI_COEFFICIENTS.humidity * normHr
    + SMRI_COEFFICIENTS.dem * normDem;
  
  return Math.max(0.1, Math.min(1.0, smri));
}

// ===========================
// Unified Prediction Function
// ===========================
function predictSalinity(temp, dem, solar, rain, hr, model = 'xgboost') {
  if (model === 'smri') {
    return predictSMRI(temp, dem, solar, rain, hr);
  }
  return predictXGBoost(temp, dem, solar, rain, hr);
}

function classifySalinity(value, model = 'xgboost') {
  const thresholds = model === 'smri' ? SMRI_THRESHOLDS : XGBOOST_THRESHOLDS;
  
  if (value < thresholds.low) {
    return { level: 'Thấp (An toàn)', color: '#10b981', score: 1, risk: 'Low' };
  } else if (value > thresholds.high) {
    return { level: 'Cao (Nguy hiểm)', color: '#ef4444', score: 3, risk: 'High' };
  } else {
    return { level: 'Trung bình', color: '#f59e0b', score: 2, risk: 'Medium' };
  }
}

// ===========================
// Predict All Hexes (Update Map)
// ===========================
function predictAllHexes() {
  console.log(`🔮 Predicting all hexes with ${SELECTED_MODEL.toUpperCase()}...`);
  
  DATA.forEach(hex => {
    const temp = hex.temp_c || 27;
    const dem = hex.dem_mean || 2;
    const solar = hex.solar || 2400;
    const rain = hex.rain_mm || 50;
    const hr = hex.rh_percent || 75;
    
    const prediction = predictSalinity(temp, dem, solar, rain, hr, SELECTED_MODEL);
    const classification = classifySalinity(prediction, SELECTED_MODEL);
    
    // Update hex data with prediction
    hex.predicted_salinity = prediction;
    hex.predicted_risk = classification.risk;
  });
  
  // Recalculate quartiles with new predictions
  calculateSalinityQuartiles();
  
  // Re-render map with new predictions
  renderLayers();
  console.log(`✅ Updated ${DATA.length} hexes with ${SELECTED_MODEL.toUpperCase()} predictions`);
}

// Toolbar Toggle Logic
const btnCollapseToolbar = document.getElementById('btnCollapseToolbar');
const toolbar = document.getElementById('toolbar');
if (btnCollapseToolbar && toolbar) {
  btnCollapseToolbar.addEventListener('click', () => {
    toolbar.classList.toggle('expanded');
    // Optional: Rotate icon or change text
    // btnCollapseToolbar.innerText = toolbar.classList.contains('expanded') ? '✖' : '⚙️';
  });
}

if (btnPredict) {
  btnPredict.addEventListener('click', async () => {
    // Get input values
    const temp = parseFloat(document.getElementById('input_temp').value);
    const dem = parseFloat(document.getElementById('input_dem').value);
    const solar = parseFloat(document.getElementById('input_solar').value);
    const rain = parseFloat(document.getElementById('input_rain').value);
    const hr = parseFloat(document.getElementById('input_hr').value);

    // Validate inputs
    if (isNaN(temp) || isNaN(dem) || isNaN(solar) || isNaN(rain) || isNaN(hr)) {
      resultContent.innerHTML = `
        <div style="color: #ef4444; font-weight: 600;">
          ⚠️ Vui lòng nhập đầy đủ tất cả các giá trị!
        </div>
      `;
      predictionResult.style.display = 'block';
      return;
    }

    // Show loading state
    btnPredict.disabled = true;
    btnPredict.innerText = 'Đang dự báo...';
    resultContent.innerHTML = '<div style="text-align:center;">⏳ Đang xử lý...</div>';
    predictionResult.style.display = 'block';

    try {
      await new Promise(r => setTimeout(r, 300));
      
      const salinityValue = predictSalinity(temp, dem, solar, rain, hr, SELECTED_MODEL);
      const classification = classifySalinity(salinityValue, SELECTED_MODEL);
      
      const modelName = SELECTED_MODEL === 'smri' ? 'SMRI (Ridge)' : 'XGBoost';
      
      // Display results with color coding
      resultContent.innerHTML = `
        <div style="border-left: 4px solid ${classification.color}; padding-left: 12px;">
          <div class="result-row">
            <span class="result-label">Mô hình:</span>
            <span class="result-value">${modelName}</span>
          </div>
          <div class="result-row">
            <span class="result-label">Độ mặn dự báo:</span>
            <span class="result-value" style="color: ${classification.color};">
              ${salinityValue.toFixed(4)} ${SELECTED_MODEL === 'smri' ? '(SMRI)' : '‰'}
            </span>
          </div>
          <div class="result-row">
            <span class="result-label">Mức độ cảnh báo:</span>
            <span class="result-value" style="color: ${classification.color};">
              ${classification.level}
            </span>
          </div>
          <div class="result-row">
            <span class="result-label">Điểm rủi ro:</span>
            <span class="result-value">${classification.score}/3</span>
          </div>
        </div>
      `;
      predictionResult.style.display = 'block';

    } catch (error) {
      resultContent.innerHTML = `
        <div style="color: #ef4444;">
          <strong>❌ Lỗi:</strong> ${error.message}
        </div>
      `;
      predictionResult.style.display = 'block';
    } finally {
      btnPredict.disabled = false;
      btnPredict.innerText = '🔮 Dự báo điểm';
    }
  });
}

// Predict All button handler
if (btnPredictAll) {
  btnPredictAll.addEventListener('click', async () => {
    btnPredictAll.disabled = true;
    btnPredictAll.innerText = 'Đang xử lý...';
    
    try {
      await new Promise(r => setTimeout(r, 100));
      
      // Run prediction for all hexes
      predictAllHexes();
      
      // Enable hex layer and show map
      if (!HEX_ENABLED) {
        HEX_ENABLED = true;
        document.getElementById("hexToggle").checked = true;
        syncHexToggleUI();
        renderLayers();
      }
      
      // Close panel
      xgboostPanel.style.display = 'none';
      btnXGBoost.innerText = 'Dự báo độ mặn (AI)';
      
      // Show summary using 3 level classification (same as map colors)
      const { t1, t2 } = SALINITY_QUARTILES;
      let lowCount = 0, medCount = 0, highCount = 0;
      
      DATA.forEach(d => {
        const sal = d.predicted_salinity !== undefined ? d.predicted_salinity : d.salinity;
        if (sal === null || sal === undefined || isNaN(sal)) return;
        
        if (sal <= t1) lowCount++;
        else if (sal <= t2) medCount++;
        else highCount++;
      });
      
      resultContent.innerHTML = `
        <div style="padding: 8px;">
          <div style="font-weight: 600; margin-bottom: 8px;">
            ✅ Đã dự báo ${DATA.length} ô lưới với ${SELECTED_MODEL.toUpperCase()}
          </div>
          <div style="display: flex; gap: 12px; font-size: 12px;">
            <span style="color:#ef4444;;">🟢 Thấp: ${lowCount}</span>
            <span style="color: #f59e0b;">🟡 TB: ${medCount}</span>
            <span style="color:#10b981 ">🔴 Cao: ${highCount}</span>
          </div>
        </div> 
      `;
      predictionResult.style.display = 'block';
      
    } catch (error) {
      resultContent.innerHTML = `<div style="color: #ef4444;">❌ Lỗi: ${error.message}</div>`;
      predictionResult.style.display = 'block';
    } finally {
      btnPredictAll.disabled = false;
      btnPredictAll.innerText = '🗺️ Dự báo toàn vùng';
    }
  });
}
// ===========================
// Location Search Logic (for AI Panel)
// ===========================
// Debounce function to limit API calls
function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

// Search for location using Nominatim API
async function searchLocation(query) {
  if (!query || query.length < 2) {
    searchResults.classList.remove('show');
    return;
  }

  // Show loading
  searchResults.innerHTML = '<div class="search-loading">🔍 Đang tìm kiếm...</div>';
  searchResults.classList.add('show');

  try {
    // Restrict search to Mekong Delta region (Vietnam)
    const bbox = '104.1,8.0,107.2,11.6'; // ĐBSCL bounds
    const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&q=${encodeURIComponent(query)}&countrycodes=vn&viewbox=${bbox}&bounded=1&limit=8&accept-language=vi`;
    
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'MekongSalinityH3Demo/1.0'
      }
    });

    if (!res.ok) throw new Error('Search failed');
    
    const results = await res.json();
    
    if (results.length === 0) {
      searchResults.innerHTML = '<div class="search-no-results">Không tìm thấy địa điểm</div>';
      return;
    }

    // Render results
    searchResults.innerHTML = results.map(r => `
      <div class="search-result-item" data-lat="${r.lat}" data-lon="${r.lon}" data-name="${r.display_name}">
        <div class="result-name">${r.name || r.display_name.split(',')[0]}</div>
        <div class="result-address">${r.display_name}</div>
      </div>
    `).join('');

    // Add click handlers
    document.querySelectorAll('.search-result-item').forEach(item => {
      item.addEventListener('click', () => {
        const lat = parseFloat(item.dataset.lat);
        const lon = parseFloat(item.dataset.lon);
        const name = item.dataset.name;
        
        selectLocation(lat, lon, name);
      });
    });

  } catch (error) {
    console.error('Search error:', error);
    searchResults.innerHTML = '<div class="search-no-results">Lỗi tìm kiếm, vui lòng thử lại</div>';
  }
}

// Find nearest hex to a given coordinate
function findNearestHex(lat, lon) {
  if (DATA.length === 0) return null;

  let nearestHex = null;
  let minDistance = Infinity;

  DATA.forEach(hex => {
    try {
      const [hexLat, hexLon] = h3.cellToLatLng(hex.hex);
      // Simple Euclidean distance (good enough for small areas)
      const dist = Math.sqrt(Math.pow(lat - hexLat, 2) + Math.pow(lon - hexLon, 2));
      
      if (dist < minDistance) {
        minDistance = dist;
        nearestHex = hex;
      }
    } catch (e) {
      // Skip invalid hex
    }
  });

  return nearestHex;
}

// Select a location and focus on nearest hex - AUTO CLICK
async function selectLocation(lat, lon, name) {
  console.log(`📍 Selected: ${name} (${lat}, ${lon})`);
  
  // Hide AI search results if visible
  if (aiSearchResults) {
    aiSearchResults.classList.remove('show');
  }

  // Enable hex layer if not enabled
  if (!HEX_ENABLED) {
    HEX_ENABLED = true;
    document.getElementById("hexToggle").checked = true;
    syncHexToggleUI();
    renderLayers();
  }

  // Fly to location with closer zoom
  map.flyTo({
    center: [lon, lat],
    zoom: 12,
    pitch: 45,
    duration: 1500
  });

  // Wait for map animation
  await new Promise(r => setTimeout(r, 1500));

  // Find nearest hex
  const nearestHex = findNearestHex(lat, lon);
  
  if (nearestHex) {
    console.log('✅ Found nearest hex:', nearestHex.hex);
    
    // Set current hex for highlighting
    CURRENT_HEX = nearestHex.hex;
    selectedHexForPrediction = nearestHex;

    // Center map exactly on selected hex so it is easy to identify
    const [hexLat, hexLon] = h3.cellToLatLng(nearestHex.hex);
    map.flyTo({
      center: [hexLon, hexLat],
      zoom: 12.5,
      pitch: 45,
      duration: 700
    });
    
    // Re-render to show highlight
    renderLayers();
    
    // Auto-open dashboard with hex data (simulates click)
    openDashboard(nearestHex);
    
  } else {
    console.warn('No hex found near location');
    alert('Không tìm thấy dữ liệu hex tại vị trí này. Vui lòng thử vị trí khác trong vùng ĐBSCL.');
  }
}

// ===========================
// AI Panel Search Logic
// ===========================
const aiSearchInput = document.getElementById('aiSearchInput');
const aiSearchResults = document.getElementById('aiSearchResults');
const selectedLocation = document.getElementById('selectedLocation');
const locationName = document.getElementById('locationName');
const btnClearLocation = document.getElementById('btnClearLocation');

// AI Panel Search Function
async function aiSearchLocation(query) {
  if (!query || query.length < 2) {
    aiSearchResults.classList.remove('show');
    return;
  }

  // Show loading
  aiSearchResults.innerHTML = '<div class="search-loading">🔍 Đang tìm kiếm...</div>';
  aiSearchResults.classList.add('show');

  try {
    // Restrict search to Mekong Delta region (Vietnam)
    const bbox = '104.1,8.0,107.2,11.6';
    const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&q=${encodeURIComponent(query)}&countrycodes=vn&viewbox=${bbox}&bounded=1&limit=8&accept-language=vi`;
    
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'MekongSalinityH3Demo/1.0'
      }
    });

    if (!res.ok) throw new Error('Search failed');
    
    const results = await res.json();
    
    if (results.length === 0) {
      aiSearchResults.innerHTML = '<div class="search-no-results">Không tìm thấy địa điểm</div>';
      return;
    }

    // Render results
    aiSearchResults.innerHTML = results.map(r => `
      <div class="search-result-item" data-lat="${r.lat}" data-lon="${r.lon}" data-name="${r.display_name}">
        <div class="result-name">${r.name || r.display_name.split(',')[0]}</div>
        <div class="result-address">${r.display_name}</div>
      </div>
    `).join('');

    // Add click handlers
    aiSearchResults.querySelectorAll('.search-result-item').forEach(item => {
      item.addEventListener('click', () => {
        const lat = parseFloat(item.dataset.lat);
        const lon = parseFloat(item.dataset.lon);
        const name = item.dataset.name;
        
        selectLocationForPrediction(lat, lon, name);
      });
    });

  } catch (error) {
    console.error('AI Search error:', error);
    aiSearchResults.innerHTML = '<div class="search-no-results">Lỗi tìm kiếm, vui lòng thử lại</div>';
  }
}

// Select location for AI prediction and fill input fields
async function selectLocationForPrediction(lat, lon, name) {
  console.log(`🎯 AI Prediction - Selected: ${name} (${lat}, ${lon})`);
  
  // Hide search results
  aiSearchResults.classList.remove('show');
  aiSearchInput.value = '';
  
  // Show selected location
  const shortName = name.split(',')[0];
  locationName.textContent = `📍 ${shortName}`;
  selectedLocation.style.display = 'flex';

  // Enable hex layer if not enabled
  if (!HEX_ENABLED) {
    HEX_ENABLED = true;
    document.getElementById("hexToggle").checked = true;
    syncHexToggleUI();
    renderLayers();
  }

  // Fly to location
  map.flyTo({
    center: [lon, lat],
    zoom: 12,
    pitch: 45,
    duration: 1500
  });

  // Wait for animation
  await new Promise(r => setTimeout(r, 500));

  // Find nearest hex
  const nearestHex = findNearestHex(lat, lon);
  
  if (nearestHex) {
    console.log('Found nearest hex for prediction:', nearestHex.hex);
    selectedHexForPrediction = nearestHex;
    CURRENT_HEX = nearestHex.hex;

    // Center map exactly on selected hex so highlight is obvious
    const [hexLat, hexLon] = h3.cellToLatLng(nearestHex.hex);
    map.flyTo({
      center: [hexLon, hexLat],
      zoom: 12.5,
      pitch: 45,
      duration: 700
    });
    
    // Re-render to highlight the selected hex
    renderLayers();
    
    // Auto-open dashboard with hex info
    openDashboard(nearestHex);
    
    console.log(`✅ Đã hiển thị thông tin hex: ${nearestHex.hex}`);
    
  } else {
    console.warn('No hex found near location');
    alert('Không tìm thấy dữ liệu hex tại vị trí này. Vui lòng thử vị trí khác trong vùng ĐBSCL.');
    selectedHexForPrediction = null;
  }
}

// Event listeners for AI panel search
if (aiSearchInput) {
  const debouncedAISearch = debounce(aiSearchLocation, 400);
  
  aiSearchInput.addEventListener('input', (e) => {
    debouncedAISearch(e.target.value.trim());
  });

  aiSearchInput.addEventListener('focus', () => {
    if (aiSearchInput.value.length >= 2) {
      aiSearchResults.classList.add('show');
    }
  });

  // Close results when clicking outside
  document.addEventListener('click', (e) => {
    if (aiSearchInput && !aiSearchInput.contains(e.target) && 
        aiSearchResults && !aiSearchResults.contains(e.target)) {
      aiSearchResults.classList.remove('show');
    }
  });

  // Handle Enter key
  aiSearchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const firstResult = aiSearchResults.querySelector('.search-result-item');
      if (firstResult) {
        firstResult.click();
      }
    }
  });
}

// Clear selected location
if (btnClearLocation) {
  btnClearLocation.addEventListener('click', () => {
    clearHexSelection();
    selectedLocation.style.display = 'none';
    locationName.textContent = '';
    
    // Clear input fields
    document.getElementById('input_temp').value = '';
    document.getElementById('input_dem').value = '';
    document.getElementById('input_solar').value = '';
    document.getElementById('input_rain').value = '';
    document.getElementById('input_hr').value = '';
    
    // Hide prediction result
    predictionResult.style.display = 'none';
    
    console.log('🗑️ Đã xóa vị trí đã chọn');
  });
}

//zalo login

// ===========================
// Logic Form Đăng nhập
// ===========================
const btnToolbarLogin = document.getElementById('btnlogin');
const loginModal = document.getElementById('loginModal');
const btnCloseLogin = document.getElementById('btnCloseLogin');
const btnZaloLogin = document.getElementById('btnZaloLogin');

if (btnToolbarLogin && loginModal) {
  // Mở modal khi bấm nút Đăng nhập trên toolbar
  btnToolbarLogin.addEventListener('click', () => {
    loginModal.style.display = 'flex'; // Dùng flex để canh giữa
  });
}

if (btnCloseLogin && loginModal) {
  // Đóng modal khi bấm nút X
  btnCloseLogin.addEventListener('click', () => {
    loginModal.style.display = 'none';
  });
}

// Đóng modal khi click ra ngoài vùng trắng của form
if (loginModal) {
  loginModal.addEventListener('click', (e) => {
    if (e.target === loginModal) {
      loginModal.style.display = 'none';
    }
  });
}

// ===========================
// Xử lý Callback và Trạng thái Đăng nhập Zalo
// ===========================
window.addEventListener('DOMContentLoaded', () => {
  const urlParams = new URLSearchParams(window.location.search);
  const authCode = urlParams.get('code');

  // 1. NẾU CÓ MÃ TỪ ZALO TRẢ VỀ -> LƯU VÀO BỘ NHỚ
  if (authCode) {
    console.log("🎉 Lấy được Code từ Zalo:", authCode);
    
    // Lưu cờ đánh dấu đã đăng nhập vào localStorage
    localStorage.setItem('zalo_logged_in', 'true');
    
    // Xóa state tạm và làm sạch URL
    localStorage.removeItem('zalo_auth_state');
    window.history.replaceState({}, document.title, window.location.pathname);
  }

  // 2. KIỂM TRA TRẠNG THÁI TỪ BỘ NHỚ (GIÚP F5 KHÔNG BỊ MẤT)
  const isLogged = localStorage.getItem('zalo_logged_in');
  const btnToolbarLogin = document.getElementById('btnlogin');
  const loginModal = document.getElementById('loginModal');

  if (isLogged === 'true') {
    // ---- KHI ĐÃ ĐĂNG NHẬP ----
    
    // Đóng form nếu nó đang mở
    if (loginModal) loginModal.style.display = 'none';

    // Đổi nút "Đăng nhập" thành nút "Đăng xuất" (Màu đỏ)
    if (btnToolbarLogin) {
      btnToolbarLogin.innerHTML = '🔴 Đăng xuất';
      btnToolbarLogin.style.background = '#fee2e2';
      btnToolbarLogin.style.borderColor = '#fca5a5';
      btnToolbarLogin.style.color = '#991b1b';

      // Xóa các sự kiện cũ trên nút (ví dụ sự kiện mở popup)
      const newBtn = btnToolbarLogin.cloneNode(true);
      btnToolbarLogin.parentNode.replaceChild(newBtn, btnToolbarLogin);

      // Gắn sự kiện ĐĂNG XUẤT
      newBtn.addEventListener('click', () => {
        // Xóa cờ trong bộ nhớ
        localStorage.removeItem('zalo_logged_in');
        // Tải lại trang web để quay về ban đầu
        window.location.reload();
      });
    }

  } else {
    // ---- KHI CHƯA ĐĂNG NHẬP (Luồng cũ của bạn) ----
    
    const btnCloseLogin = document.getElementById('btnCloseLogin');
    const btnZaloLogin = document.getElementById('btnZaloLogin');

    // Mở popup
    if (btnToolbarLogin && loginModal) {
      btnToolbarLogin.addEventListener('click', () => {
        loginModal.style.display = 'flex';
      });
    }

    // Đóng popup
    if (btnCloseLogin && loginModal) {
      btnCloseLogin.addEventListener('click', () => {
        loginModal.style.display = 'none';
      });
    }

    if (loginModal) {
      loginModal.addEventListener('click', (e) => {
        if (e.target === loginModal) loginModal.style.display = 'none';
      });
    }

    // Nút Bấm Đăng Nhập Zalo (Chuyển hướng)
    if (btnZaloLogin) {
      btnZaloLogin.addEventListener('click', () => {
        const appId = '145188836807457994'; 
        const redirectUri = window.location.origin + window.location.pathname; 
        const state = Math.random().toString(36).substring(7);
        localStorage.setItem('zalo_auth_state', state); 
        
        const zaloAuthUrl = `https://oauth.zaloapp.com/v4/permission?app_id=${appId}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`;
        window.location.href = zaloAuthUrl;
      });
    }
  }
});

// ===========================
// GIẢ LẬP NHẬN TOẠ ĐỘ TỪ ZALO
// ===========================

window.addEventListener('DOMContentLoaded', () => {
  const btnToggleZalo = document.getElementById('btnToggleZalo');
  const zaloPanel = document.getElementById('zaloPanel');
  const btnClearZaloSelection = document.getElementById('btnClearZaloSelection');

  // Lắng nghe sự kiện click để bật/tắt panel
  if (btnToggleZalo && zaloPanel) {
    btnToggleZalo.addEventListener('click', () => {
      if (zaloPanel.style.display === 'none' || zaloPanel.style.display === '') {
        zaloPanel.style.display = 'block';
      } else {
        zaloPanel.style.display = 'none';
      }
    });
  }

  if (btnClearZaloSelection) {
    btnClearZaloSelection.addEventListener('click', () => {
      clearHexSelection();
    });
  }

  // Khởi tạo một toạ độ Demo khi tải trang
  const demoLat = 10.0333;
  const demoLon = 105.7833;
  addCoordToList(demoLat, demoLon, "Nguyễn Văn A (Cần Thơ)", "Vừa xong");
});

// Hàm thêm một item toạ độ vào danh sách UI
function addCoordToList(lat, lon, name = "Vị trí chia sẻ từ Zalo", time = new Date().toLocaleTimeString('vi-VN')) {
  const list = document.getElementById('coordList');
  if (!list) return;
  
  const li = document.createElement('li');
  li.style.padding = '12px 10px';
  li.style.borderBottom = '1px solid #f0f0f0';
  li.style.cursor = 'pointer';
  li.style.transition = 'background 0.2s';
  li.style.borderRadius = '6px';
  
  li.innerHTML = `
    <div style="display: flex; justify-content: space-between; align-items: flex-start;">
      <div style="font-weight: 600; color: #1e293b; font-size: 0.9rem;">📍 ${name}</div>
      <div style="font-size: 0.7rem; color: #94a3b8;">${time}</div>
    </div>
    <div style="font-size: 0.8rem; color: #64748b; margin-top: 4px;">Toạ độ: ${lat.toFixed(4)}, ${lon.toFixed(4)}</div>
  `;
  
  li.onmouseover = () => li.style.background = '#f0f9ff';
  li.onmouseout = () => li.style.background = 'transparent';
  
  li.onclick = () => {
    if(typeof selectLocation === 'function') {
      selectLocation(lat, lon, name);
    }
  };
  
  list.insertBefore(li, list.firstChild);
}

// Hàm xử lý khi bấm nút "Gửi" giả lập
window.simulateZaloMessage = function() {
  const input = document.getElementById('mockZaloInput').value.trim();
  
  if (!input) {
    alert("Vui lòng nhập toạ độ!");
    return;
  }

  const parts = input.split(',');
  if (parts.length !== 2) {
    alert("Định dạng không hợp lệ! Vui lòng nhập theo mẫu: Vĩ độ, Kinh độ\nVí dụ: 10.03, 105.78");
    return;
  }

  const lat = parseFloat(parts[0].trim());
  const lon = parseFloat(parts[1].trim());

  if (isNaN(lat) || isNaN(lon)) {
    alert("Toạ độ phải là dạng số!");
    return;
  }

  const minLat = MEKONG_BOUNDS[0][1]; 
  const maxLat = MEKONG_BOUNDS[1][1]; 
  const minLon = MEKONG_BOUNDS[0][0]; 
  const maxLon = MEKONG_BOUNDS[1][0]; 

  if (lat < minLat || lat > maxLat || lon < minLon || lon > maxLon) {
    alert(`❌ Toạ độ (${lat}, ${lon}) nằm ngoài vùng ĐBSCL!\n\nVui lòng nhập trong khoảng:\n- Vĩ độ (Lat): ${minLat} đến ${maxLat}\n- Kinh độ (Lon): ${minLon} đến ${maxLon}`);
    return;
  }

  const senderName = "Người dùng ẩn danh " + Math.floor(Math.random() * 100);
  addCoordToList(lat, lon, senderName);
  
  if(typeof selectLocation === 'function') {
    selectLocation(lat, lon, senderName);
  }
  
  document.getElementById('mockZaloInput').value = "";
};