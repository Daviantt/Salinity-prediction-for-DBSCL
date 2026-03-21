# WEB Dev Notes

Tai lieu nhanh de hieu va onboard du an ban do do man (MapLibre + DeckGL + H3).

## 1) So do luong su kien click (dang bullet)

### Luong A: Mo toolbar
1. Click nut cai dat (`#btnCollapseToolbar`).
2. JS toggle class `expanded` cho `#toolbar`.
3. CSS hien/an `#toolbar-actions` theo class `expanded`.

### Luong B: Bat/Tat Hex slider
1. User doi checkbox `#hexToggle`.
2. Event `change` cap nhat state `HEX_ENABLED`.
3. Goi `syncHexToggleUI()` de doi text `Hex: Bat/Tat` va mau.
4. Goi `renderLayers()`:
   - Neu `HEX_ENABLED = false`: xoa layer, an tooltip.
   - Neu `HEX_ENABLED = true`: ve lai H3 layer bang `createH3Layer()`.
5. Neu tat Hex: an them `infoPanel` va `legendBox`.

### Luong C: Chon nam du lieu
1. Click `#btnYear` de mo dropdown `#yearMenu`.
2. Click `.yearOption` (2022/2025).
3. Cap nhat `SELECTED_YEAR` va text tren nut nam.
4. Goi `loadDataForYear(SELECTED_YEAR)`:
   - Fetch file `dataYYYY.json`.
   - Gan vao `DATA`.
   - Tinh nguong mau `calculateSalinityQuartiles()`.
   - Neu dang bat Hex thi `renderLayers()` lai.
5. Neu dashboard dang mo va co `CURRENT_HEX` -> refresh chart.

### Luong D: Click vao 1 o Hex tren ban do
1. User click o H3 layer (pickable).
2. Set `CURRENT_HEX`.
3. Goi `openDashboard(hexData)`.
4. Dashboard:
   - Hien thong tin do man/nhiet do/rui ro/cao do.
   - Goi `fetchHexHistory(CURRENT_HEX, SELECTED_YEAR)`.
   - Ve chart timeline qua `renderTimeline()`.

### Luong E: AI panel va du bao toan vung
1. Click `#btnXGBoost` de mo/doi panel AI.
2. Chon model (`xgboost` hoac `smri`) -> cap nhat `SELECTED_MODEL`.
3. Click `#btnPredictAll`:
   - Chay `predictAllHexes()` tren tung phan tu `DATA`.
   - Gan `predicted_salinity`, `predicted_risk`.
   - Tinh lai nguong mau va `renderLayers()`.
   - Tu dong dong AI panel va hien tong ket.

### Luong F: Tim dia diem trong AI panel
1. Nhap `#aiSearchInput` (co debounce 400ms).
2. Goi Nominatim search theo bounding box DBSCL.
3. Click ket qua -> `selectLocationForPrediction(lat, lon, name)`.
4. App fly den vi tri, tim hex gan nhat (`findNearestHex`), highlight hex.
5. Mo dashboard hex vua tim thay.

## 2) Ban do state quan trong

- `DATA`: du lieu hex cua nam hien tai.
- `HEX_ENABLED`: co ve layer hex hay khong.
- `SELECTED_YEAR`: nam du lieu (2022/2025).
- `CURRENT_HEX`: hex dang duoc focus/open dashboard.
- `SELECTED_MODEL`: model AI dang chon (`xgboost`/`smri`).
- `selectedHexForPrediction`: hex duoc highlight khi tim kiem AI.

## 3) Diem vao code chinh

- HTML UI: `WEB/demo.html`
- CSS UI: `WEB/style.css`
- Logic chinh: `WEB/app.js`

Cac ham nen doc dau tien trong `app.js`:
1. `loadDataForYear`
2. `renderLayers`
3. `createH3Layer`
4. `openDashboard`
5. `predictAllHexes`
6. `aiSearchLocation` va `selectLocationForPrediction`

## 4) Checklist debug nhanh

1. Mo Console, dam bao khong co loi `null/undefined`.
2. Xac nhan id trong HTML giong id truy cap trong JS.
3. Neu click khong co tac dung: check event listener da bind chua.
4. Neu bat Hex ma khong thay mau: check `DATA.length` va `HEX_ENABLED`.
5. Neu doi nam loi: check file `data2022.json`/`data2025.json` co ton tai va dung duong dan.

## 5) Luong du lieu moi (CSV theo nam)

## cai dat node.js neu chua co(link: https://nodejs.org/en/download)
## Neu nhu da cai dat node.js ma van khong mo duoc npm thi hay mo powershelf len copy lenh nay va dan vao: Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
## lenh nay chi cap quyen thoi khong anh huong den may yen tam lam.


Du an da ho tro backend doc cac file CSV co ten mau:

- `final_train_AI_2021.csv`
- `final_train_AI_2022.csv`
- `final_train_AI_2023.csv`

Chi can dat file vao thu muc goc du an va backend se nap theo nam tu ten file.

### Chay backend

1. `cd backend`
2. `npm install`
3. `npm start`

Backend mac dinh chay tai `http://localhost:5000`.

### API chinh

- `GET /api/health`: xem trang thai nap du lieu
- `GET /api/years`: danh sach nam dang co
- `GET /api/months?year=2021`: cac thang co du lieu
- `GET /api/hexes?year=2021&month=1`: du lieu map theo nam-thang
- `GET /api/history/{hex}?year=2021`: timeline theo hex
- `POST /api/reload`: nap lai du lieu khi them file moi

### Frontend map

- `app.js` uu tien goi backend API khi chay local.
- Neu backend loi hoac khong chay, frontend moi fallback ve file JSON cu.
- Dropdown nam tren map se tu dong lay tu `/api/years`.
