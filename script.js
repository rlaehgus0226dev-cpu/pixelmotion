const $ = (id) => document.getElementById(id);

const state = {
  frames: [],              // [{ source, original, pixelized, fileName }]
  frameIdx: 0,
  selection: null,
  draftSelection: null,
  layout: null,
  zoom: "fit",
  panX: 0,
  panY: 0,
  activeColor: [0, 0, 0],
  palette: [],
};

// state.source / original / pixelized / fileName 은 현재 프레임의 alias
Object.defineProperty(state, "source", {
  get() { const f = state.frames[state.frameIdx]; return f ? f.source : null; },
  set(v) { const f = state.frames[state.frameIdx]; if (f) f.source = v; },
});
Object.defineProperty(state, "original", {
  get() { const f = state.frames[state.frameIdx]; return f ? f.original : null; },
  set(v) { const f = state.frames[state.frameIdx]; if (f) f.original = v; },
});
Object.defineProperty(state, "pixelized", {
  get() { const f = state.frames[state.frameIdx]; return f ? f.pixelized : false; },
  set(v) { const f = state.frames[state.frameIdx]; if (f) f.pixelized = v; },
});
Object.defineProperty(state, "fileName", {
  get() { const f = state.frames[state.frameIdx]; return f ? f.fileName : ""; },
  set(v) { const f = state.frames[state.frameIdx]; if (f) f.fileName = v; },
});

const history = [];
const HISTORY_LIMIT = 20;

function snapshot() {
  history.push({
    original: state.original,
    source: state.source,
    pixelized: state.pixelized,
  });
  if (history.length > HISTORY_LIMIT) history.shift();
  updateUndoButton();
}

function undo() {
  if (history.length === 0) return;
  const s = history.pop();
  state.original = s.original;
  state.source = s.source;
  state.pixelized = s.pixelized;
  bumpSource();
  redraw();
  updateUndoButton();
  setStatus("되돌림");
}

function clearHistory() {
  history.length = 0;
  updateUndoButton();
}

function updateUndoButton() {
  $("btn-undo").disabled = history.length === 0;
}

const canvas = $("canvas");
const ctx = canvas.getContext("2d");

function setStatus(text) { $("status").textContent = text; }
function getGridSize() { return parseInt(document.querySelector('input[name="grid"]:checked').value, 10); }
function getColorLimit() { return parseInt(document.querySelector('input[name="color"]:checked').value, 10); }
function showGrid() { return $("show-grid").checked; }

function fitCanvas() {
  const stage = $("stage");
  const dpr = window.devicePixelRatio || 1;
  const w = stage.clientWidth;
  const h = stage.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  canvas.style.width = w + "px";
  canvas.style.height = h + "px";
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

let _sourceCanvasCache = { imgData: null, canvas: null };
function imageDataToCanvas(imgData) {
  if (_sourceCanvasCache.imgData === imgData && _sourceCanvasCache.canvas) {
    return _sourceCanvasCache.canvas;
  }
  const c = document.createElement("canvas");
  c.width = imgData.width;
  c.height = imgData.height;
  c.getContext("2d").putImageData(imgData, 0, 0);
  _sourceCanvasCache = { imgData, canvas: c };
  return c;
}
function freshCanvas(imgData) {
  // 캐시 무관 — 일괄 처리용
  const c = document.createElement("canvas");
  c.width = imgData.width;
  c.height = imgData.height;
  c.getContext("2d").putImageData(imgData, 0, 0);
  return c;
}
function bumpSource() { /* 캐시가 참조 비교로 바뀌어 더 이상 필요 없음 */ }
function invalidateSourceCache() { _sourceCanvasCache = { imgData: null, canvas: null }; }

function drawCheckerboard(x, y, w, h, tile = 10) {
  for (let py = 0; py < h; py += tile) {
    for (let px = 0; px < w; px += tile) {
      const dark = ((Math.floor(px / tile) + Math.floor(py / tile)) % 2) === 1;
      ctx.fillStyle = dark ? "#aaaaaa" : "#dcdcdc";
      ctx.fillRect(x + px, y + py, Math.min(tile, w - px), Math.min(tile, h - py));
    }
  }
}

function drawGrid(x, y, w, h) {
  const sub = getSub();
  const showSub = $("show-subgrid").checked;

  // 세분화 라인 OFF → 큰 격자 (N 단위) 검정 라인만, 도트는 그대로
  if (!showSub && sub > 1) {
    const baseN = getGridSize();
    let bc, br;
    if (state.source && state.pixelized) {
      bc = Math.max(1, Math.round(state.source.width / sub));
      br = Math.max(1, Math.round(state.source.height / sub));
    } else if (state.source) {
      const d = gridDims(state.source.width, state.source.height, baseN);
      bc = d.cols; br = d.rows;
    } else {
      bc = br = baseN;
    }
    ctx.strokeStyle = "#000";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i <= bc; i++) {
      const gx = Math.round(x + w * i / bc) + 0.5;
      ctx.moveTo(gx, y);
      ctx.lineTo(gx, y + h);
    }
    for (let j = 0; j <= br; j++) {
      const gy = Math.round(y + h * j / br) + 0.5;
      ctx.moveTo(x, gy);
      ctx.lineTo(x + w, gy);
    }
    ctx.stroke();
    return;
  }

  let cols, rows;
  if (state.source) {
    if (state.pixelized) {
      cols = state.source.width;
      rows = state.source.height;
    } else {
      const dims = gridDims(state.source.width, state.source.height, getGridSize() * sub);
      cols = dims.cols;
      rows = dims.rows;
    }
  } else {
    cols = rows = getGridSize() * sub;
  }

  // 도트 격자 (마이너, 검정 1px). sub>1이면 큰 격자 위치는 skip하고 메이저로 그림
  ctx.strokeStyle = "#000";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 0; i <= cols; i++) {
    if (sub > 1 && i % sub === 0) continue;
    const gx = Math.round(x + w * i / cols) + 0.5;
    ctx.moveTo(gx, y);
    ctx.lineTo(gx, y + h);
  }
  for (let j = 0; j <= rows; j++) {
    if (sub > 1 && j % sub === 0) continue;
    const gy = Math.round(y + h * j / rows) + 0.5;
    ctx.moveTo(x, gy);
    ctx.lineTo(x + w, gy);
  }
  ctx.stroke();

  // 큰 격자 (메이저, 빨강 1px)
  if (sub > 1) {
    ctx.strokeStyle = "#ff3344";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i <= cols; i += sub) {
      const gx = Math.round(x + w * i / cols) + 0.5;
      ctx.moveTo(gx, y);
      ctx.lineTo(gx, y + h);
    }
    for (let j = 0; j <= rows; j += sub) {
      const gy = Math.round(y + h * j / rows) + 0.5;
      ctx.moveTo(x, gy);
      ctx.lineTo(x + w, gy);
    }
    ctx.stroke();
  }
}

function redraw() {
  fitCanvas();
  const cw = canvas.clientWidth;
  const ch = canvas.clientHeight;
  ctx.fillStyle = "#1e1e1e";
  ctx.fillRect(0, 0, cw, ch);

  const badge = $("badge");
  if (!state.source) {
    badge.classList.add("hidden");
    return;
  }

  const iw = state.source.width;
  const ih = state.source.height;
  let dw, dh, x, y;
  if (state.zoom === "fit") {
    if (state.pixelized) {
      const ps = Math.max(1, Math.min(Math.floor(cw * 0.95 / iw), Math.floor(ch * 0.95 / ih)));
      dw = iw * ps;
      dh = ih * ps;
      ctx.imageSmoothingEnabled = false;
    } else {
      const scale = Math.min(cw / iw, ch / ih) * 0.95;
      dw = Math.max(1, Math.floor(iw * scale));
      dh = Math.max(1, Math.floor(ih * scale));
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
    }
    x = Math.floor((cw - dw) / 2);
    y = Math.floor((ch - dh) / 2);
  } else {
    const z = state.zoom;
    dw = Math.max(1, Math.round(iw * z));
    dh = Math.max(1, Math.round(ih * z));
    x = Math.round((cw - dw) / 2 + state.panX);
    y = Math.round((ch - dh) / 2 + state.panY);
    ctx.imageSmoothingEnabled = false;
  }

  drawCheckerboard(x, y, dw, dh);

  // 어니언 스킨 (이전/다음 프레임을 반투명 겹침)
  const onionEl = $("tl-onion");
  if (onionEl && onionEl.checked && state.frames.length > 1) {
    const prevIdx = (state.frameIdx - 1 + state.frames.length) % state.frames.length;
    const nextIdx = (state.frameIdx + 1) % state.frames.length;
    ctx.save();
    if (prevIdx !== state.frameIdx) {
      const prev = state.frames[prevIdx];
      if (prev && prev.source) {
        ctx.globalAlpha = 0.35;
        ctx.drawImage(imageDataToCanvas2(prev.source), x, y, dw, dh);
      }
    }
    if (nextIdx !== state.frameIdx && nextIdx !== prevIdx) {
      const next = state.frames[nextIdx];
      if (next && next.source) {
        ctx.globalAlpha = 0.25;
        ctx.drawImage(imageDataToCanvas2(next.source), x, y, dw, dh);
      }
    }
    ctx.restore();
  }

  ctx.drawImage(imageDataToCanvas(state.source), x, y, dw, dh);

  if (showGrid()) drawGrid(x, y, dw, dh);

  state.layout = { x, y, dw, dh, iw, ih };
  drawSelection();

  badge.textContent = `${iw} × ${ih} px`;
  badge.classList.remove("hidden");
  $("file-info").textContent = `${state.fileName} · ${iw} × ${ih} px`;
}

// ---------- 이미지/프레임 로드 ----------
async function loadImageFromFile(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const cctx = c.getContext("2d");
    cctx.drawImage(img, 0, 0);
    const imgData = cctx.getImageData(0, 0, c.width, c.height);
    addFrame(imgData, file.name);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function addFrame(imgData, fileName) {
  state.frames.push({
    source: imgData,
    original: imgData,
    pixelized: false,
    fileName: fileName || `frame_${state.frames.length + 1}`,
  });
  state.frameIdx = state.frames.length - 1;
  state.selection = null;
  state.draftSelection = null;
  state.zoom = "fit";
  state.panX = 0;
  state.panY = 0;
  invalidateSourceCache();
  updateZoomDisplay();
  clearHistory();
  refreshPalette();
  renderTimeline();
  redraw();
}

function selectFrame(idx) {
  if (idx < 0 || idx >= state.frames.length) return;
  if (idx === state.frameIdx) return;
  state.frameIdx = idx;
  state.selection = null;
  state.draftSelection = null;
  invalidateSourceCache();
  refreshPalette();
  renderTimeline();
  redraw();
}

function removeFrame(idx) {
  if (idx < 0 || idx >= state.frames.length) return;
  state.frames.splice(idx, 1);
  if (state.frameIdx >= state.frames.length) {
    state.frameIdx = Math.max(0, state.frames.length - 1);
  }
  state.selection = null;
  state.draftSelection = null;
  invalidateSourceCache();
  refreshPalette();
  renderTimeline();
  redraw();
}

$("file-input").addEventListener("change", async (e) => {
  const files = Array.from(e.target.files);
  for (const f of files) {
    await loadImageFromFile(f);
  }
  e.target.value = "";
});

// ---------- 도트화 ----------
// 픽셀의 알파가 이 임계값 초과일 때만 도트화/외곽선 계산에 카운트.
// rembg 결과처럼 가장자리에 부드러운 알파(5~60)가 깔리는 경우 해당 픽셀이
// 색을 흐리게 하거나 실루엣을 부풀리는 것을 방지.
const ALPHA_THRESHOLD = 64;

function gridDims(W, H, n) {
  const cellSize = Math.min(W, H) / n;
  const cols = Math.max(1, Math.round(W / cellSize));
  const rows = Math.max(1, Math.round(H / cellSize));
  return { cellSize, cols, rows };
}

function pixelize(src, n) {
  const W = src.width, H = src.height;
  const { cellSize, cols, rows } = gridDims(W, H, n);
  if (cellSize < 1) return src;
  const out = new ImageData(cols, rows);
  const sd = src.data, od = out.data;
  for (let gy = 0; gy < rows; gy++) {
    const y0 = Math.floor(gy * cellSize);
    const y1 = Math.min(H, Math.floor((gy + 1) * cellSize));
    for (let gx = 0; gx < cols; gx++) {
      const x0 = Math.floor(gx * cellSize);
      const x1 = Math.min(W, Math.floor((gx + 1) * cellSize));
      let rSum = 0, gSum = 0, bSum = 0, count = 0;
      for (let y = y0; y < y1; y++) {
        let idx = (y * W + x0) * 4;
        for (let x = x0; x < x1; x++, idx += 4) {
          if (sd[idx + 3] > ALPHA_THRESHOLD) {
            rSum += sd[idx];
            gSum += sd[idx + 1];
            bSum += sd[idx + 2];
            count++;
          }
        }
      }
      const oi = (gy * cols + gx) * 4;
      if (count > 0) {
        od[oi] = Math.round(rSum / count);
        od[oi + 1] = Math.round(gSum / count);
        od[oi + 2] = Math.round(bSum / count);
        od[oi + 3] = 255;
      } else {
        od[oi + 3] = 0;
      }
    }
  }
  return out;
}

// 우세색 다운샘플: 한 칸에서 RGB 32단계(8x8x8=512) 버킷으로 분류해
// 가장 빈도 높은 버킷의 평균색을 사용. 외곽 안티앨리어싱이 무시되어 색이 또렷.
const DOM_BIN = 32;
const DOM_NB = Math.ceil(256 / DOM_BIN);  // 8
const DOM_TOTAL = DOM_NB * DOM_NB * DOM_NB;

function pixelizeDominant(src, n, weighted = false) {
  const W = src.width, H = src.height;
  const { cellSize, cols, rows } = gridDims(W, H, n);
  if (cellSize < 1) return src;
  const out = new ImageData(cols, rows);
  const sd = src.data, od = out.data;
  const counts = new Uint32Array(DOM_TOTAL);
  const rSum = new Float64Array(DOM_TOTAL);
  const gSum = new Float64Array(DOM_TOTAL);
  const bSum = new Float64Array(DOM_TOTAL);

  for (let gy = 0; gy < rows; gy++) {
    const y0 = Math.floor(gy * cellSize);
    const y1 = Math.min(H, Math.floor((gy + 1) * cellSize));
    for (let gx = 0; gx < cols; gx++) {
      const x0 = Math.floor(gx * cellSize);
      const x1 = Math.min(W, Math.floor((gx + 1) * cellSize));
      counts.fill(0);
      rSum.fill(0);
      gSum.fill(0);
      bSum.fill(0);
      let totalOpaque = 0;
      for (let y = y0; y < y1; y++) {
        let idx = (y * W + x0) * 4;
        for (let x = x0; x < x1; x++, idx += 4) {
          if (sd[idx + 3] > ALPHA_THRESHOLD) {
            const r = sd[idx], g = sd[idx + 1], b = sd[idx + 2];
            const bi = (Math.floor(r / DOM_BIN) * DOM_NB + Math.floor(g / DOM_BIN)) * DOM_NB + Math.floor(b / DOM_BIN);
            counts[bi]++;
            rSum[bi] += r;
            gSum[bi] += g;
            bSum[bi] += b;
            totalOpaque++;
          }
        }
      }
      const oi = (gy * cols + gx) * 4;
      if (totalOpaque > 0) {
        let bestK = 0, bestW = -1;
        for (let k = 0; k < DOM_TOTAL; k++) {
          const c = counts[k];
          if (c === 0) continue;
          let w = c;
          if (weighted) {
            // 채도 가중: 채도 높은 작은 디테일이 다수의 무채색을 이길 수 있게
            const r = rSum[k] / c;
            const g = gSum[k] / c;
            const b = bSum[k] / c;
            const sat = Math.max(r, g, b) - Math.min(r, g, b);
            w = c * (1 + sat / 32);
          }
          if (w > bestW) { bestW = w; bestK = k; }
        }
        const bc = counts[bestK];
        od[oi] = Math.round(rSum[bestK] / bc);
        od[oi + 1] = Math.round(gSum[bestK] / bc);
        od[oi + 2] = Math.round(bSum[bestK] / bc);
        od[oi + 3] = 255;
      } else {
        od[oi + 3] = 0;
      }
    }
  }
  return out;
}

// 외곽선 (Erode + floodfill): 외부 영역은 그대로 두고 캐릭터 외곽 1픽셀의 색만 검정으로.
// 사이즈/위치 변화 없음, 내부 색·구멍 보존. 캐릭터의 "진짜 바깥"과 닿은 1px만 외곽선이 됨.
function addOutline(src, color = [0, 0, 0, 255]) {
  const W = src.width, H = src.height;
  const sd = src.data;
  const out = new ImageData(W, H);
  out.data.set(sd);

  const isExterior = new Uint8Array(W * H);
  const stack = [];

  function tryPush(i) {
    if (i < 0 || i >= W * H) return;
    if (isExterior[i]) return;
    if (sd[i * 4 + 3] !== 0) return;
    isExterior[i] = 1;
    stack.push(i);
  }

  for (let x = 0; x < W; x++) {
    tryPush(x);
    tryPush((H - 1) * W + x);
  }
  for (let y = 0; y < H; y++) {
    tryPush(y * W);
    tryPush(y * W + (W - 1));
  }

  while (stack.length > 0) {
    const i = stack.pop();
    const x = i % W;
    const y = (i - x) / W;
    if (x > 0) tryPush(i - 1);
    if (x < W - 1) tryPush(i + 1);
    if (y > 0) tryPush(i - W);
    if (y < H - 1) tryPush(i + W);
  }

  const od = out.data;
  for (let i = 0; i < W * H; i++) {
    if (sd[i * 4 + 3] === 0) continue;  // 외부/구멍은 그대로
    const x = i % W;
    const y = (i - x) / W;
    let touch = false;
    if (x === 0 || x === W - 1 || y === 0 || y === H - 1) touch = true;
    else if (isExterior[i - 1]) touch = true;
    else if (isExterior[i + 1]) touch = true;
    else if (isExterior[i - W]) touch = true;
    else if (isExterior[i + W]) touch = true;
    if (touch) {
      const oi = i * 4;
      od[oi] = color[0];
      od[oi + 1] = color[1];
      od[oi + 2] = color[2];
      od[oi + 3] = color[3];
    }
  }
  return out;
}

// 외곽 셀을 큰 격자(N) 단위로 평탄화: 외곽과 닿는 큰 격자 셀의 sub×sub 블록을
// 그 셀 평균 색으로 채워 통째 한 도트로 만듦. 내부 셀은 세분 도트 그대로 유지.
// 결과: 캐릭터 외곽 = 큰 격자 도트, 내부 = 세분 도트.
function addOutlineCoarse(src, sub) {
  if (sub <= 1) return src;
  const W = src.width, H = src.height;
  const sd = src.data;
  const out = new ImageData(W, H);
  out.data.set(sd);

  const bigW = Math.ceil(W / sub);
  const bigH = Math.ceil(H / sub);
  const bigMask = new Uint8Array(bigW * bigH);
  const bigR = new Float64Array(bigW * bigH);
  const bigG = new Float64Array(bigW * bigH);
  const bigB = new Float64Array(bigW * bigH);
  const bigCount = new Uint32Array(bigW * bigH);

  for (let by = 0; by < bigH; by++) {
    const y0 = by * sub;
    const y1 = Math.min(H, y0 + sub);
    for (let bx = 0; bx < bigW; bx++) {
      const x0 = bx * sub;
      const x1 = Math.min(W, x0 + sub);
      const bi = by * bigW + bx;
      for (let y = y0; y < y1; y++) {
        let idx = (y * W + x0) * 4;
        for (let x = x0; x < x1; x++, idx += 4) {
          if (sd[idx + 3] !== 0) {
            bigR[bi] += sd[idx];
            bigG[bi] += sd[idx + 1];
            bigB[bi] += sd[idx + 2];
            bigCount[bi]++;
          }
        }
      }
      if (bigCount[bi] > 0) bigMask[bi] = 1;
    }
  }

  const isExt = new Uint8Array(bigW * bigH);
  const stack = [];
  function tryPush(i) {
    if (i < 0 || i >= bigW * bigH) return;
    if (isExt[i]) return;
    if (bigMask[i]) return;
    isExt[i] = 1;
    stack.push(i);
  }
  for (let x = 0; x < bigW; x++) { tryPush(x); tryPush((bigH - 1) * bigW + x); }
  for (let y = 0; y < bigH; y++) { tryPush(y * bigW); tryPush(y * bigW + (bigW - 1)); }
  while (stack.length) {
    const i = stack.pop();
    const x = i % bigW;
    const y = (i - x) / bigW;
    if (x > 0) tryPush(i - 1);
    if (x < bigW - 1) tryPush(i + 1);
    if (y > 0) tryPush(i - bigW);
    if (y < bigH - 1) tryPush(i + bigW);
  }

  const od = out.data;
  for (let by = 0; by < bigH; by++) {
    for (let bx = 0; bx < bigW; bx++) {
      const bi = by * bigW + bx;
      if (!bigMask[bi]) continue;
      const isEdge =
        bx === 0 || bx === bigW - 1 || by === 0 || by === bigH - 1 ||
        isExt[bi - 1] || isExt[bi + 1] || isExt[bi - bigW] || isExt[bi + bigW];
      if (!isEdge) continue;

      const c = bigCount[bi];
      const r = Math.round(bigR[bi] / c);
      const g = Math.round(bigG[bi] / c);
      const b = Math.round(bigB[bi] / c);
      const x0 = bx * sub, y0 = by * sub;
      const x1 = Math.min(W, x0 + sub);
      const y1 = Math.min(H, y0 + sub);

      for (let y = y0; y < y1; y++) {
        let idx = (y * W + x0) * 4;
        for (let x = x0; x < x1; x++, idx += 4) {
          if (sd[idx + 3] === 0) continue;
          od[idx] = r;
          od[idx + 1] = g;
          od[idx + 2] = b;
          od[idx + 3] = 255;
        }
      }
    }
  }
  return out;
}

// 채도 부스트 (luminance preserving)
function adjustSaturation(src, factor) {
  if (factor === 1) return src;
  const out = new ImageData(src.width, src.height);
  const sd = src.data, od = out.data;
  for (let i = 0; i < sd.length; i += 4) {
    const a = sd[i + 3];
    if (a === 0) {
      od[i + 3] = 0;
      continue;
    }
    const r = sd[i], g = sd[i + 1], b = sd[i + 2];
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    od[i] = Math.max(0, Math.min(255, Math.round(lum + (r - lum) * factor)));
    od[i + 1] = Math.max(0, Math.min(255, Math.round(lum + (g - lum) * factor)));
    od[i + 2] = Math.max(0, Math.min(255, Math.round(lum + (b - lum) * factor)));
    od[i + 3] = a;
  }
  return out;
}

// ---------- 색 양자화 (median cut) ----------
function quantizeColors(src, k) {
  const W = src.width, H = src.height;
  const data = src.data;
  const pixels = [];
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] > 0) pixels.push([data[i], data[i + 1], data[i + 2]]);
  }
  if (pixels.length === 0) return src;
  const buckets = medianCut(pixels, k);
  const palette = buckets.map(avgColor);
  const out = new ImageData(W, H);
  const od = out.data;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] > 0) {
      const ci = nearestPaletteIndex(data[i], data[i + 1], data[i + 2], palette);
      od[i] = palette[ci][0];
      od[i + 1] = palette[ci][1];
      od[i + 2] = palette[ci][2];
      od[i + 3] = data[i + 3];
    } else {
      od[i + 3] = 0;
    }
  }
  return out;
}

function medianCut(pixels, k) {
  let buckets = [pixels];
  while (buckets.length < k) {
    let bestI = -1, bestRange = -1;
    for (let i = 0; i < buckets.length; i++) {
      if (buckets[i].length < 2) continue;
      const r = colorRange(buckets[i]);
      if (r.range > bestRange) { bestRange = r.range; bestI = i; }
    }
    if (bestI === -1) break;
    const b = buckets[bestI];
    const r = colorRange(b);
    b.sort((p, q) => p[r.dim] - q[r.dim]);
    const mid = Math.floor(b.length / 2);
    buckets.splice(bestI, 1, b.slice(0, mid), b.slice(mid));
  }
  return buckets;
}

function colorRange(pixels) {
  let rmin=255, rmax=0, gmin=255, gmax=0, bmin=255, bmax=0;
  for (const p of pixels) {
    if (p[0] < rmin) rmin = p[0]; if (p[0] > rmax) rmax = p[0];
    if (p[1] < gmin) gmin = p[1]; if (p[1] > gmax) gmax = p[1];
    if (p[2] < bmin) bmin = p[2]; if (p[2] > bmax) bmax = p[2];
  }
  const dr = rmax - rmin, dg = gmax - gmin, db = bmax - bmin;
  if (dr >= dg && dr >= db) return { dim: 0, range: dr };
  if (dg >= db) return { dim: 1, range: dg };
  return { dim: 2, range: db };
}

function avgColor(pixels) {
  let r = 0, g = 0, b = 0;
  for (const p of pixels) { r += p[0]; g += p[1]; b += p[2]; }
  const n = pixels.length;
  return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
}

function nearestPaletteIndex(r, g, b, palette) {
  let best = 0, bestD = Infinity;
  for (let i = 0; i < palette.length; i++) {
    const dr = palette[i][0] - r, dg = palette[i][1] - g, db = palette[i][2] - b;
    const d = dr*dr + dg*dg + db*db;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

// ---------- apply ----------
function getSatFactor() {
  const v = parseInt(document.querySelector('input[name="sat"]:checked').value, 10);
  return v / 100;
}
function getDownsampleMode() {
  return document.querySelector('input[name="ds"]:checked').value;
}
function getSub() {
  return parseInt(document.querySelector('input[name="sub"]:checked').value, 10);
}
function getOutlineMode() {
  const r = document.querySelector('input[name="outline"]:checked');
  return r ? r.value : "off";
}

function getApplyRange() {
  const r = document.querySelector('input[name="apply-range"]:checked');
  return r ? r.value : "current";
}

function pixelizeFrame(frame) {
  const n = getGridSize() * getSub();
  const c = getColorLimit();
  const sat = getSatFactor();
  const mode = getDownsampleMode();
  let result;
  if (mode === "avg") result = pixelize(frame.original, n);
  else if (mode === "det") result = pixelizeDominant(frame.original, n, true);
  else result = pixelizeDominant(frame.original, n, false);
  if (sat !== 1) result = adjustSaturation(result, sat);
  if (c > 0) result = quantizeColors(result, c);
  const om = getOutlineMode();
  if (om === "fine") result = addOutline(result);
  else if (om === "coarse") result = addOutlineCoarse(result, getSub());
  frame.source = result;
  frame.pixelized = true;
}

function applyPixelize() {
  if (state.frames.length === 0) {
    setStatus("이미지를 먼저 추가하세요");
    return;
  }
  const range = getApplyRange();
  if (range === "all") {
    snapshot();
    state.frames.forEach(pixelizeFrame);
  } else {
    if (!state.pixelized) snapshot();
    pixelizeFrame(state.frames[state.frameIdx]);
  }
  invalidateSourceCache();
  refreshPalette();
  renderTimeline();
  redraw();
}

$("btn-pixelize").addEventListener("click", applyPixelize);

document.querySelectorAll('input[name="grid"]').forEach((r) => {
  r.addEventListener("change", () => {
    if (state.pixelized) applyPixelize(); else redraw();
  });
});
document.querySelectorAll('input[name="color"]').forEach((r) => {
  r.addEventListener("change", () => {
    if (state.pixelized) applyPixelize();
  });
});
document.querySelectorAll('input[name="sat"]').forEach((r) => {
  r.addEventListener("change", () => {
    if (state.pixelized) applyPixelize();
  });
});
document.querySelectorAll('input[name="ds"]').forEach((r) => {
  r.addEventListener("change", () => {
    if (state.pixelized) applyPixelize();
  });
});
document.querySelectorAll('input[name="outline"]').forEach((r) => {
  r.addEventListener("change", () => {
    if (state.pixelized) applyPixelize();
  });
});
$("show-grid").addEventListener("change", redraw);
$("show-subgrid").addEventListener("change", redraw);
document.querySelectorAll('input[name="sub"]').forEach((r) => {
  r.addEventListener("change", () => {
    if (state.pixelized) applyPixelize(); else redraw();
  });
});

// ---------- 배경 제거 (서버 rembg) ----------
$("btn-bg").addEventListener("click", async () => {
  if (!state.original) {
    setStatus("이미지를 먼저 열어주세요");
    return;
  }
  $("btn-bg").disabled = true;
  const precise = $("bg-precise").checked;
  setStatus(
    precise
      ? "배경 제거 중 (정밀)... 첫 호출 시 ~170MB 추가 다운로드, 시간 걸림"
      : "배경 제거 중..."
  );
  snapshot();
  try {
    const c = imageDataToCanvas(state.original);
    const blob = await new Promise(res => c.toBlob(res, "image/png"));
    const resp = await fetch("/api/remove-bg", {
      method: "POST",
      body: blob,
      headers: { "X-RemoveBg-Mode": precise ? "precise" : "default" },
    });
    if (!resp.ok) {
      const msg = await resp.text();
      throw new Error(msg);
    }
    const outBlob = await resp.blob();
    const url = URL.createObjectURL(outBlob);
    const img = new Image();
    img.src = url;
    await img.decode();
    URL.revokeObjectURL(url);
    const cc = document.createElement("canvas");
    cc.width = img.naturalWidth;
    cc.height = img.naturalHeight;
    cc.getContext("2d").drawImage(img, 0, 0);
    const imgData = cc.getContext("2d").getImageData(0, 0, cc.width, cc.height);
    state.original = imgData;
    state.source = imgData;
    state.pixelized = false;
    bumpSource();
    redraw();
    setStatus("배경 제거 완료");
  } catch (e) {
    history.pop();  // 실패 → 스냅샷 롤백
    updateUndoButton();
    setStatus("배경 제거 실패: " + e.message);
  } finally {
    $("btn-bg").disabled = false;
  }
});

// ---------- PNG 저장 ----------
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function stripExt(name) {
  return name.replace(/\.[^.]+$/, "");
}

$("btn-save")?.addEventListener("click", async () => {
  if (!state.source) {
    setStatus("이미지를 먼저 열어주세요");
    return;
  }
  const c = freshCanvas(state.source);
  const blob = await new Promise((res) => c.toBlob(res, "image/png"));
  const base = stripExt(state.fileName) || "pixelmotion";
  const w = state.source.width, h = state.source.height;
  const tag = state.pixelized ? `_${w}x${h}` : "";
  downloadBlob(blob, `${base}${tag}.png`);
  setStatus(`저장: ${base}${tag}.png`);
});

// ---------- 일괄 처리 ----------
async function decodeFileToImageData(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const cctx = c.getContext("2d");
    cctx.drawImage(img, 0, 0);
    return cctx.getImageData(0, 0, c.width, c.height);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function processOne(imgData) {
  const n = getGridSize() * getSub();
  const cLimit = getColorLimit();
  const sat = getSatFactor();
  const mode = getDownsampleMode();
  let result;
  if (mode === "avg") result = pixelize(imgData, n);
  else if (mode === "det") result = pixelizeDominant(imgData, n, true);
  else result = pixelizeDominant(imgData, n, false);
  if (sat !== 1) result = adjustSaturation(result, sat);
  if (cLimit > 0) result = quantizeColors(result, cLimit);
  const om = getOutlineMode();
  if (om === "fine") result = addOutline(result);
  else if (om === "coarse") result = addOutlineCoarse(result, getSub());
  return result;
}

$("btn-batch")?.addEventListener("click", () => {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*";
  input.multiple = true;
  input.onchange = async () => {
    const files = Array.from(input.files);
    if (files.length === 0) return;
    if (typeof JSZip === "undefined") {
      setStatus("JSZip 로드 실패 — 인터넷 연결 확인");
      return;
    }
    $("btn-batch").disabled = true;
    const zip = new JSZip();
    let ok = 0, fail = 0;
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      setStatus(`일괄 처리 중... ${i + 1}/${files.length}: ${f.name}`);
      try {
        const imgData = await decodeFileToImageData(f);
        const result = processOne(imgData);
        const c = freshCanvas(result);
        const blob = await new Promise((res) => c.toBlob(res, "image/png"));
        const base = stripExt(f.name) || `image_${i}`;
        zip.file(`${base}_${result.width}x${result.height}.png`, blob);
        ok++;
      } catch (e) {
        fail++;
      }
      // 다른 작업이 끼어들 수 있도록 한 박자 양보
      await new Promise((r) => setTimeout(r, 0));
    }
    setStatus(`ZIP 생성 중... (${ok}장)`);
    try {
      const zipBlob = await zip.generateAsync({ type: "blob" });
      const ts = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
      downloadBlob(zipBlob, `pixelmotion_batch_${ts}.zip`);
      setStatus(`일괄 처리 완료: 성공 ${ok} / 실패 ${fail}`);
    } catch (e) {
      setStatus(`ZIP 생성 실패: ${e.message}`);
    }
    $("btn-batch").disabled = false;
  };
  input.click();
});

$("btn-undo").addEventListener("click", undo);

window.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !e.shiftKey) {
    e.preventDefault();
    undo();
  }
});

// ---------- 영역 선택 도구 ----------
function getTool() {
  const r = document.querySelector('input[name="tool"]:checked');
  return r ? r.value : "none";
}
function getBoundsMode() {
  return "touch";  // 옵션 제거 — 항상 걸침 동작
}

function canvasToImageCoord(e) {
  if (!state.source || !state.layout) return null;
  const rect = canvas.getBoundingClientRect();
  const cx = e.clientX - rect.left;
  const cy = e.clientY - rect.top;
  const { x, y, dw, dh, iw, ih } = state.layout;
  const ix = (cx - x) / dw * iw;
  const iy = (cy - y) / dh * ih;
  return { ix, iy };
}

let dragging = false;
let dragStart = null;
let isPanning = false;
let panStart = null;
let spaceHeld = false;
let ctrlShiftHeld = false;

window.addEventListener("keydown", (e) => {
  if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA")) return;
  if (e.code === "Space" && !spaceHeld && !e.ctrlKey && !e.metaKey) {
    spaceHeld = true;
    canvas.style.cursor = "grab";
    e.preventDefault();
  }
  if (e.ctrlKey && e.shiftKey && !ctrlShiftHeld) {
    ctrlShiftHeld = true;
    canvas.style.cursor = "grab";
  }
});
window.addEventListener("keyup", (e) => {
  if (e.code === "Space") {
    spaceHeld = false;
    if (!isPanning && !ctrlShiftHeld) canvas.style.cursor = "";
  }
  if (!e.ctrlKey || !e.shiftKey) {
    if (ctrlShiftHeld) {
      ctrlShiftHeld = false;
      if (!isPanning && !spaceHeld) canvas.style.cursor = "";
    }
  }
});
window.addEventListener("blur", () => {
  spaceHeld = false;
  ctrlShiftHeld = false;
  if (!isPanning) canvas.style.cursor = "";
});

canvas.addEventListener("mousedown", (e) => {
  const tool = getTool();
  // 팬 우선: 미들버튼 / Space / Ctrl+Shift / 손바닥 도구
  const wantsPan = e.button === 1
    || (spaceHeld && e.button === 0)
    || (ctrlShiftHeld && e.button === 0);
  if (wantsPan) {
    e.preventDefault();
    if (state.zoom === "fit") {
      state.zoom = computeFitZoom();
      updateZoomDisplay();
    }
    isPanning = true;
    panStart = { x: e.clientX - state.panX, y: e.clientY - state.panY };
    canvas.style.cursor = "grabbing";
    return;
  }
  if (e.button !== 0) return;
  const p = canvasToImageCoord(e);
  if (!p) return;
  if (tool === "pick") {
    pickColorAt(Math.floor(p.ix), Math.floor(p.iy));
    return;
  }
  if (tool === "brush" || tool === "erase") {
    snapshot();
    // 새 ImageData로 교체 — history의 옛 source가 변경되지 않도록 분리
    const newImg = new ImageData(state.source.width, state.source.height);
    newImg.data.set(state.source.data);
    state.source = newImg;
    pixelDragging = true;
    pixelTool = tool;
    pixelLast = null;
    paintAt(e);
    return;
  }
  if (tool !== "rect" && tool !== "lasso") return;
  dragging = true;
  if (tool === "rect") {
    dragStart = p;
    state.draftSelection = { type: "rect", x1: p.ix, y1: p.iy, x2: p.ix, y2: p.iy };
  } else {
    state.draftSelection = { type: "lasso", points: [{ x: p.ix, y: p.iy }] };
  }
  redraw();
});

canvas.addEventListener("mousemove", (e) => {
  if (isPanning) {
    state.panX = e.clientX - panStart.x;
    state.panY = e.clientY - panStart.y;
    redraw();
    return;
  }
  if (pixelDragging) {
    paintAt(e);
    return;
  }
  if (!dragging) return;
  const p = canvasToImageCoord(e);
  if (!p) return;
  const sel = state.draftSelection;
  if (sel.type === "rect") {
    sel.x2 = p.ix;
    sel.y2 = p.iy;
  } else if (sel.type === "lasso") {
    const last = sel.points[sel.points.length - 1];
    if (Math.abs(last.x - p.ix) > 0.4 || Math.abs(last.y - p.iy) > 0.4) {
      sel.points.push({ x: p.ix, y: p.iy });
    }
  }
  redraw();
});

canvas.addEventListener("mouseup", (e) => {
  if (isPanning) {
    isPanning = false;
    canvas.style.cursor = (spaceHeld || ctrlShiftHeld) ? "grab" : "";
    return;
  }
  if (pixelDragging) {
    pixelDragging = false;
    pixelLast = null;
    return;
  }
  if (!dragging) return;
  dragging = false;
  if (state.draftSelection) {
    if (state.draftSelection.type === "lasso" && state.draftSelection.points.length < 3) {
      state.draftSelection = null;
    } else {
      state.selection = state.draftSelection;
      state.draftSelection = null;
    }
    redraw();
  }
});
canvas.addEventListener("mouseleave", () => {
  if (isPanning) {
    isPanning = false;
    canvas.style.cursor = (spaceHeld || ctrlShiftHeld) ? "grab" : "";
  }
  if (pixelDragging) {
    pixelDragging = false;
    pixelLast = null;
  }
  if (dragging) {
    dragging = false;
    if (state.draftSelection) {
      if (state.draftSelection.type === "lasso" && state.draftSelection.points.length < 3) {
        state.draftSelection = null;
      } else {
        state.selection = state.draftSelection;
        state.draftSelection = null;
      }
      redraw();
    }
  }
});

// ---------- 줌 ----------
function computeFitZoom() {
  if (!state.source) return 1;
  const cw = canvas.clientWidth;
  const ch = canvas.clientHeight;
  const iw = state.source.width;
  const ih = state.source.height;
  if (state.pixelized) {
    return Math.max(1, Math.min(Math.floor(cw * 0.95 / iw), Math.floor(ch * 0.95 / ih)));
  } else {
    return Math.min(cw / iw, ch / ih) * 0.95;
  }
}

function updateZoomDisplay() {
  const d = $("zoom-display");
  if (state.zoom === "fit") d.textContent = "FIT";
  else d.textContent = `${Math.round(state.zoom * 100)}%`;
}

function setZoom(z, anchorX, anchorY) {
  if (z === "fit") {
    state.zoom = "fit";
    state.panX = 0;
    state.panY = 0;
    updateZoomDisplay();
    redraw();
    return;
  }
  z = Math.max(0.1, Math.min(64, z));
  if (state.zoom === "fit" || anchorX === undefined) {
    state.zoom = z;
  } else if (state.layout) {
    const layout = state.layout;
    const cw = canvas.clientWidth;
    const ch = canvas.clientHeight;
    const ix = (anchorX - layout.x) / layout.dw * layout.iw;
    const iy = (anchorY - layout.y) / layout.dh * layout.ih;
    state.zoom = z;
    const newDw = layout.iw * z;
    const newDh = layout.ih * z;
    state.panX = anchorX - cw / 2 + newDw / 2 - ix * z;
    state.panY = anchorY - ch / 2 + newDh / 2 - iy * z;
  } else {
    state.zoom = z;
  }
  updateZoomDisplay();
  redraw();
}

function zoomBy(factor, anchorX, anchorY) {
  const current = state.zoom === "fit" ? computeFitZoom() : state.zoom;
  setZoom(current * factor, anchorX, anchorY);
}

canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const cx = e.clientX - rect.left;
  const cy = e.clientY - rect.top;
  const factor = e.deltaY < 0 ? 1.25 : 1 / 1.25;
  zoomBy(factor, cx, cy);
}, { passive: false });

window.addEventListener("keydown", (e) => {
  if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA")) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const cx = canvas.clientWidth / 2;
  const cy = canvas.clientHeight / 2;
  if (e.key === "+" || e.key === "=") { e.preventDefault(); zoomBy(1.25, cx, cy); }
  else if (e.key === "-" || e.key === "_") { e.preventDefault(); zoomBy(1 / 1.25, cx, cy); }
  else if (e.key === "0") { e.preventDefault(); setZoom("fit"); }
  else if (e.key === "1" && !spaceHeld) { e.preventDefault(); setZoom(1, cx, cy); }
});

$("btn-zoom-in").addEventListener("click", () => zoomBy(1.25, canvas.clientWidth / 2, canvas.clientHeight / 2));
$("btn-zoom-out").addEventListener("click", () => zoomBy(1 / 1.25, canvas.clientWidth / 2, canvas.clientHeight / 2));
$("btn-zoom-fit").addEventListener("click", () => setZoom("fit"));
$("btn-zoom-100").addEventListener("click", () => setZoom(1, canvas.clientWidth / 2, canvas.clientHeight / 2));

function drawSelection() {
  const isDraft = !!state.draftSelection;
  const sel = state.draftSelection || state.selection;
  if (!sel || !state.layout) return;
  const { x, y, dw, dh, iw, ih } = state.layout;
  ctx.save();
  ctx.strokeStyle = "#ffaa00";
  ctx.lineWidth = 1;
  ctx.setLineDash([5, 3]);
  if (sel.type === "rect") {
    const sx1 = Math.min(sel.x1, sel.x2);
    const sy1 = Math.min(sel.y1, sel.y2);
    const sx2 = Math.max(sel.x1, sel.x2);
    const sy2 = Math.max(sel.y1, sel.y2);
    const px1 = x + sx1 / iw * dw;
    const py1 = y + sy1 / ih * dh;
    const px2 = x + sx2 / iw * dw;
    const py2 = y + sy2 / ih * dh;
    ctx.strokeRect(Math.round(px1) + 0.5, Math.round(py1) + 0.5, Math.round(px2 - px1), Math.round(py2 - py1));
  } else if (sel.type === "lasso" && sel.points.length > 1) {
    ctx.beginPath();
    sel.points.forEach((p, i) => {
      const px = x + p.x / iw * dw;
      const py = y + p.y / ih * dh;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    if (!isDraft) ctx.closePath();  // 드래그 중에는 열린 경로, 확정되면 닫음
    ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.restore();
}

function pointInPolygon(px, py, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const xi = points[i].x, yi = points[i].y;
    const xj = points[j].x, yj = points[j].y;
    if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

function buildSelectionMask(sel, W, H, mode) {
  const mask = new Uint8Array(W * H);
  if (sel.type === "rect") {
    const x1 = Math.min(sel.x1, sel.x2);
    const y1 = Math.min(sel.y1, sel.y2);
    const x2 = Math.max(sel.x1, sel.x2);
    const y2 = Math.max(sel.y1, sel.y2);
    const xMin = Math.max(0, Math.floor(x1) - 1);
    const xMax = Math.min(W - 1, Math.ceil(x2) + 1);
    const yMin = Math.max(0, Math.floor(y1) - 1);
    const yMax = Math.min(H - 1, Math.ceil(y2) + 1);
    for (let y = yMin; y <= yMax; y++) {
      for (let x = xMin; x <= xMax; x++) {
        let inSel;
        if (mode === "center") {
          inSel = (x + 0.5 >= x1 && x + 0.5 <= x2 && y + 0.5 >= y1 && y + 0.5 <= y2);
        } else {
          inSel = (x + 1 > x1 && x < x2 && y + 1 > y1 && y < y2);
        }
        if (inSel) mask[y * W + x] = 1;
      }
    }
  } else if (sel.type === "lasso" && sel.points.length >= 3) {
    let xMin = Infinity, yMin = Infinity, xMax = -Infinity, yMax = -Infinity;
    sel.points.forEach((p) => {
      if (p.x < xMin) xMin = p.x;
      if (p.x > xMax) xMax = p.x;
      if (p.y < yMin) yMin = p.y;
      if (p.y > yMax) yMax = p.y;
    });
    const x1 = Math.max(0, Math.floor(xMin) - 1);
    const x2 = Math.min(W - 1, Math.ceil(xMax) + 1);
    const y1 = Math.max(0, Math.floor(yMin) - 1);
    const y2 = Math.min(H - 1, Math.ceil(yMax) + 1);
    const pts = sel.points;
    for (let y = y1; y <= y2; y++) {
      for (let x = x1; x <= x2; x++) {
        let inSel;
        if (mode === "center") {
          inSel = pointInPolygon(x + 0.5, y + 0.5, pts);
        } else {
          inSel = pointInPolygon(x + 0.5, y + 0.5, pts) ||
                  pointInPolygon(x + 0.05, y + 0.05, pts) ||
                  pointInPolygon(x + 0.95, y + 0.05, pts) ||
                  pointInPolygon(x + 0.05, y + 0.95, pts) ||
                  pointInPolygon(x + 0.95, y + 0.95, pts);
        }
        if (inSel) mask[y * W + x] = 1;
      }
    }
  }
  return mask;
}

// 그라데이션 보정: BFS layer마다 색이 (부모 색 + 영역 평균) / 2로 점진 수렴
function fillAreaGradient(src, mask) {
  const W = src.width, H = src.height;
  const sd = src.data;
  let r = 0, g = 0, b = 0, count = 0;
  for (let i = 0; i < W * H; i++) {
    if (mask[i] && sd[i * 4 + 3] > 0) {
      r += sd[i * 4]; g += sd[i * 4 + 1]; b += sd[i * 4 + 2]; count++;
    }
  }
  if (count === 0) return null;
  const avgR = r / count, avgG = g / count, avgB = b / count;

  const out = new ImageData(W, H);
  out.data.set(sd);
  const od = out.data;

  const visited = new Uint8Array(W * H);
  const queue = [];
  for (let i = 0; i < W * H; i++) {
    if (mask[i] && sd[i * 4 + 3] > 0) {
      visited[i] = 1;
      queue.push(i);
    }
  }
  let head = 0;
  let filled = 0;
  while (head < queue.length) {
    const i = queue[head++];
    const x = i % W;
    const y = (i - x) / W;
    const parentR = od[i * 4], parentG = od[i * 4 + 1], parentB = od[i * 4 + 2];
    const newR = Math.round((parentR + avgR) / 2);
    const newG = Math.round((parentG + avgG) / 2);
    const newB = Math.round((parentB + avgB) / 2);
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (const [dx, dy] of dirs) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const ni = ny * W + nx;
      if (visited[ni]) continue;
      if (!mask[ni]) continue;
      if (sd[ni * 4 + 3] > 0) continue;
      visited[ni] = 1;
      od[ni * 4] = newR;
      od[ni * 4 + 1] = newG;
      od[ni * 4 + 2] = newB;
      od[ni * 4 + 3] = 255;
      queue.push(ni);
      filled++;
    }
  }
  if (filled === 0) return null;
  return { image: out, filled, avg: [Math.round(avgR), Math.round(avgG), Math.round(avgB)] };
}

function fillAreaAverage(src, mask) {
  const W = src.width, H = src.height;
  const sd = src.data;
  let r = 0, g = 0, b = 0, count = 0;
  for (let i = 0; i < W * H; i++) {
    if (mask[i] && sd[i * 4 + 3] > 0) {
      r += sd[i * 4];
      g += sd[i * 4 + 1];
      b += sd[i * 4 + 2];
      count++;
    }
  }
  if (count === 0) return null;
  const avgR = Math.round(r / count);
  const avgG = Math.round(g / count);
  const avgB = Math.round(b / count);
  const out = new ImageData(W, H);
  out.data.set(sd);
  const od = out.data;
  let filled = 0;
  for (let i = 0; i < W * H; i++) {
    if (mask[i] && sd[i * 4 + 3] === 0) {
      od[i * 4] = avgR;
      od[i * 4 + 1] = avgG;
      od[i * 4 + 2] = avgB;
      od[i * 4 + 3] = 255;
      filled++;
    }
  }
  return { image: out, filled, avg: [avgR, avgG, avgB] };
}

$("btn-clear-sel").addEventListener("click", () => {
  state.selection = null;
  state.draftSelection = null;
  redraw();
});

// ---------- 색공간 변환 ----------
function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs((h / 60) % 2 - 1));
  const m = l - c / 2;
  let r, g, b;
  if (h < 60) { r = c; g = x; b = 0; }
  else if (h < 120) { r = x; g = c; b = 0; }
  else if (h < 180) { r = 0; g = c; b = x; }
  else if (h < 240) { r = 0; g = x; b = c; }
  else if (h < 300) { r = x; g = 0; b = c; }
  else { r = c; g = 0; b = x; }
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}
function rgbToHex(c) {
  return "#" + [c[0], c[1], c[2]].map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, "0")).join("");
}
function hexToRgb(hex) {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return null;
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

// ---------- 팔레트 ----------
function buildDefaultPalette() {
  const out = [];
  // 회색조 5단계
  for (let i = 0; i <= 4; i++) {
    const v = Math.round(i * 255 / 4);
    out.push([v, v, v]);
  }
  // 7 hues × 3 lightness = 21
  const hues = [0, 30, 60, 120, 180, 240, 300];
  const lights = [0.35, 0.5, 0.7];
  for (const h of hues) {
    for (const l of lights) {
      out.push(hslToRgb(h, 1, l));
    }
  }
  return out;  // 5 + 21 = 26
}

function hsvToRgb(h, s, v) {
  h = ((h % 360) + 360) % 360;
  const c = v * s;
  const x = c * (1 - Math.abs((h / 60) % 2 - 1));
  const m = v - c;
  let r, g, b;
  if (h < 60) { r = c; g = x; b = 0; }
  else if (h < 120) { r = x; g = c; b = 0; }
  else if (h < 180) { r = 0; g = c; b = x; }
  else if (h < 240) { r = 0; g = x; b = c; }
  else if (h < 300) { r = x; g = 0; b = c; }
  else { r = c; g = 0; b = x; }
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const v = max;
  const d = max - min;
  const s = max === 0 ? 0 : d / max;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return [h, s, v];
}
const DEFAULT_PALETTE = buildDefaultPalette();

function extractPalette(imgData) {
  if (!imgData) return [];
  const sd = imgData.data;
  const counts = new Map();
  for (let i = 0; i < sd.length; i += 4) {
    if (sd[i + 3] === 0) continue;
    const key = (sd[i] << 16) | (sd[i + 1] << 8) | sd[i + 2];
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 64)
    .map(([key]) => [(key >> 16) & 255, (key >> 8) & 255, key & 255]);
}

function colorEqual(a, b) {
  return a && b && a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

function renderActiveColor() {
  const box = $("active-color-box");
  const c = state.activeColor;
  box.style.backgroundColor = `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
  box.dataset.rgb = `${c[0]}, ${c[1]}, ${c[2]}`;
}

function renderPalette() {
  const grid = $("palette-grid");
  grid.innerHTML = "";
  state.palette.forEach((color) => {
    const cell = document.createElement("div");
    cell.className = "palette-cell";
    cell.style.backgroundColor = `rgb(${color[0]}, ${color[1]}, ${color[2]})`;
    if (colorEqual(state.activeColor, color)) cell.classList.add("active");
    cell.title = `RGB(${color[0]}, ${color[1]}, ${color[2]})`;
    cell.addEventListener("click", () => {
      state.activeColor = color.slice();
      renderActiveColor();
      renderPalette();
      if ($("color-picker").classList.contains("show")) syncPickerFromActive();
    });
    grid.appendChild(cell);
  });
  const filled = state.palette.length;
  const remaining = filled === 0 ? 8 : (8 - (filled % 8)) % 8;
  for (let i = 0; i < remaining; i++) {
    const empty = document.createElement("div");
    empty.className = "palette-cell empty";
    grid.appendChild(empty);
  }
  $("palette-count").textContent = String(filled);
}

function refreshPalette() {
  const extracted = extractPalette(state.source);
  state.palette = extracted.length > 0 ? extracted : DEFAULT_PALETTE.map((c) => c.slice());
  renderPalette();
}

$("btn-extract-palette").addEventListener("click", refreshPalette);

// ---------- 인라인 색 픽커 (HSV) ----------
let pickerHue = 0;   // 0~360
let pickerS = 0;     // 0~1
let pickerV = 0;     // 0~1

function updatePickerHueGradient() {
  $("picker-area").style.background =
    `linear-gradient(to bottom, transparent, #000), ` +
    `linear-gradient(to right, #fff, hsl(${pickerHue}, 100%, 50%))`;
}

function updatePickerMarkers() {
  $("picker-marker").style.left = (pickerS * 100) + "%";
  $("picker-marker").style.top = ((1 - pickerV) * 100) + "%";
  $("hue-marker").style.left = (pickerHue / 360 * 100) + "%";
}

function updatePickerHex() {
  $("picker-hex").value = rgbToHex(state.activeColor);
}

function applyHSV() {
  state.activeColor = hsvToRgb(pickerHue, pickerS, pickerV);
  renderActiveColor();
  renderPalette();
  updatePickerMarkers();
  updatePickerHex();
}

function syncPickerFromActive() {
  const [h, s, v] = rgbToHsv(...state.activeColor);
  pickerHue = h;
  pickerS = s;
  pickerV = v;
  updatePickerHueGradient();
  updatePickerMarkers();
  updatePickerHex();
}

function svAreaHandler(e) {
  const rect = $("picker-area").getBoundingClientRect();
  pickerS = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  pickerV = Math.max(0, Math.min(1, 1 - (e.clientY - rect.top) / rect.height));
  applyHSV();
}

function hueSliderHandler(e) {
  const rect = $("picker-hue").getBoundingClientRect();
  pickerHue = Math.max(0, Math.min(360, (e.clientX - rect.left) / rect.width * 360));
  updatePickerHueGradient();
  applyHSV();
}

let svDragging = false;
let hueDragging = false;
$("picker-area").addEventListener("mousedown", (e) => {
  svDragging = true;
  svAreaHandler(e);
});
$("picker-hue").addEventListener("mousedown", (e) => {
  hueDragging = true;
  hueSliderHandler(e);
});
window.addEventListener("mousemove", (e) => {
  if (svDragging) svAreaHandler(e);
  if (hueDragging) hueSliderHandler(e);
});
window.addEventListener("mouseup", () => {
  svDragging = false;
  hueDragging = false;
});

$("active-color-box").addEventListener("click", () => {
  const picker = $("color-picker");
  const willShow = !picker.classList.contains("show");
  picker.classList.toggle("show");
  if (willShow) syncPickerFromActive();
});

$("picker-hex").addEventListener("change", (e) => {
  const rgb = hexToRgb(e.target.value.trim());
  if (rgb) {
    state.activeColor = rgb;
    renderActiveColor();
    renderPalette();
    syncPickerFromActive();
  } else {
    updatePickerHex();
  }
});

// ---------- 좌우 반전 ----------
function flipHorizontal(img) {
  if (!img) return null;
  const W = img.width, H = img.height;
  const out = new ImageData(W, H);
  const sd = img.data, od = out.data;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const s = (y * W + x) * 4;
      const d = (y * W + (W - 1 - x)) * 4;
      od[d] = sd[s];
      od[d + 1] = sd[s + 1];
      od[d + 2] = sd[s + 2];
      od[d + 3] = sd[s + 3];
    }
  }
  return out;
}

$("btn-flip-h").addEventListener("click", () => {
  if (!state.source) {
    setStatus("이미지를 먼저 열어주세요");
    return;
  }
  snapshot();
  state.source = flipHorizontal(state.source);
  state.original = flipHorizontal(state.original);
  // 영역 선택은 좌우 좌표 어긋나므로 클리어
  state.selection = null;
  state.draftSelection = null;
  refreshPalette();
  redraw();
  setStatus("좌우 반전 완료");
});

// ---------- 픽셀 편집 (스포이드/브러시/지우개) ----------
let pixelDragging = false;
let pixelTool = null;
let pixelLast = null;  // 마지막 칠한 도트 좌표 (선 보간용)

function pickColorAt(ix, iy) {
  if (!state.source) return false;
  if (ix < 0 || iy < 0 || ix >= state.source.width || iy >= state.source.height) return false;
  const idx = (iy * state.source.width + ix) * 4;
  if (state.source.data[idx + 3] === 0) return false;
  state.activeColor = [
    state.source.data[idx],
    state.source.data[idx + 1],
    state.source.data[idx + 2],
  ];
  renderActiveColor();
  renderPalette();
  if ($("color-picker").classList.contains("show")) syncPickerFromActive();
  return true;
}

function getBrushSize() {
  const r = document.querySelector('input[name="brush-size"]:checked');
  return r ? r.value : "cell";
}

function paintOne(ix, iy, tool) {
  if (!state.source) return;
  if (ix < 0 || iy < 0 || ix >= state.source.width || iy >= state.source.height) return;
  const idx = (iy * state.source.width + ix) * 4;
  const data = state.source.data;
  if (tool === "brush") {
    data[idx] = state.activeColor[0];
    data[idx + 1] = state.activeColor[1];
    data[idx + 2] = state.activeColor[2];
    data[idx + 3] = 255;
  } else if (tool === "erase") {
    data[idx + 3] = 0;
  }
}

function paintPixel(ix, iy, tool) {
  const size = getBrushSize();
  if (size === "cell") {
    const sub = getSub();
    const bx = Math.floor(ix / sub) * sub;
    const by = Math.floor(iy / sub) * sub;
    for (let dy = 0; dy < sub; dy++) {
      for (let dx = 0; dx < sub; dx++) {
        paintOne(bx + dx, by + dy, tool);
      }
    }
  } else {
    paintOne(ix, iy, tool);
  }
  return true;
}

function paintLine(x0, y0, x1, y1, tool) {
  // Bresenham line (드래그 시 빠른 마우스로도 끊기지 않게)
  let dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1;
  let dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  while (true) {
    paintPixel(x0, y0, tool);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
}

function paintAt(e) {
  const p = canvasToImageCoord(e);
  if (!p) return;
  const ix = Math.floor(p.ix), iy = Math.floor(p.iy);
  if (pixelLast && (pixelLast.ix !== ix || pixelLast.iy !== iy)) {
    paintLine(pixelLast.ix, pixelLast.iy, ix, iy, pixelTool);
  } else {
    paintPixel(ix, iy, pixelTool);
  }
  pixelLast = { ix, iy };
  invalidateSourceCache();
  redraw();
}

function getFillMode() {
  const r = document.querySelector('input[name="fill-mode"]:checked');
  return r ? r.value : "avg";
}

$("btn-fill-area").addEventListener("click", () => {
  if (!state.source) {
    setStatus("이미지를 먼저 열어주세요");
    return;
  }
  if (!state.selection) {
    setStatus("영역을 먼저 선택하세요 (사각형/올가미로 드래그)");
    return;
  }
  const bMode = getBoundsMode();
  const fMode = getFillMode();
  const mask = buildSelectionMask(state.selection, state.source.width, state.source.height, bMode);
  const result = fMode === "grad"
    ? fillAreaGradient(state.source, mask)
    : fillAreaAverage(state.source, mask);
  if (!result) {
    setStatus("영역에 색이 있는 도트가 없거나 채울 빈 도트가 없습니다");
    return;
  }
  snapshot();
  state.source = result.image;
  redraw();
  setStatus(`색 보정 완료 (${fMode === "grad" ? "그라데이션" : "평균"}): ${result.filled} 도트 채움`);
});

document.querySelectorAll('input[name="tool"]').forEach((r) => {
  r.addEventListener("change", () => {
    const t = getTool();
    // 영역 도구 → 다른 도구로 바뀌면 selection은 유지(보정에 사용 가능)
    // 단 draft는 무조건 클리어
    state.draftSelection = null;
    // 픽셀 편집 도구로 갈 때 cursor 표시
    if (t === "brush" || t === "erase" || t === "pick") {
      canvas.style.cursor = "crosshair";
    } else {
      canvas.style.cursor = "";
    }
    redraw();
  });
});

window.addEventListener("resize", redraw);
state.palette = DEFAULT_PALETTE.map((c) => c.slice());
renderActiveColor();
renderPalette();
renderTimeline();
redraw();

// ---------- 호버 토스트 ----------
const tooltip = $("tooltip");
function positionTooltip(icon) {
  const rect = icon.getBoundingClientRect();
  tooltip.textContent = icon.dataset.help || "";
  tooltip.classList.add("show");
  // 토스트 사이즈 측정 후 화면 안에 들어가게 위치 조정
  const tw = tooltip.offsetWidth;
  const th = tooltip.offsetHeight;
  let left = rect.right + 12;
  if (left + tw > window.innerWidth - 8) {
    left = rect.left - tw - 12;  // 우측 공간 부족 → 좌측에
  }
  let top = rect.top + rect.height / 2 - th / 2;
  if (top < 8) top = 8;
  if (top + th > window.innerHeight - 8) top = window.innerHeight - th - 8;
  tooltip.style.left = left + "px";
  tooltip.style.top = top + "px";
}
document.querySelectorAll(".help-icon").forEach((icon) => {
  icon.addEventListener("mouseenter", () => positionTooltip(icon));
  icon.addEventListener("mouseleave", () => tooltip.classList.remove("show"));
});

// ---------- 사이드바 토글 ----------
const btnToggle = $("btn-toggle");
btnToggle.addEventListener("click", () => {
  const collapsed = document.body.classList.toggle("sidebar-collapsed");
  btnToggle.textContent = collapsed ? "▶" : "◀";
  // transition 끝난 후 캔버스 다시 그리기
  setTimeout(redraw, 220);
});

// ---------- 모달 시스템 ----------
let currentModalCleanup = null;
function showModal(title, bodyHtml, cleanup) {
  $("modal-title").textContent = title;
  $("modal-body").innerHTML = bodyHtml;
  $("modal-overlay").classList.add("show");
  currentModalCleanup = cleanup || null;
}
function hideModal() {
  $("modal-overlay").classList.remove("show");
  if (currentModalCleanup) {
    try { currentModalCleanup(); } catch (e) {}
    currentModalCleanup = null;
  }
}
$("modal-close").addEventListener("click", hideModal);
$("modal-overlay").addEventListener("click", (e) => {
  if (e.target === $("modal-overlay")) hideModal();
});

function imageDataToCanvas2(img) {
  const c = document.createElement("canvas");
  c.width = img.width;
  c.height = img.height;
  c.getContext("2d").putImageData(img, 0, 0);
  return c;
}

// ---------- 타임라인 ----------
function renderTimeline() {
  const container = $("timeline-frames");
  container.innerHTML = "";
  state.frames.forEach((frame, i) => {
    const div = document.createElement("div");
    div.className = "tl-frame" + (i === state.frameIdx ? " active" : "");
    const c = document.createElement("canvas");
    const size = 50;
    c.width = size; c.height = size;
    const ctx = c.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    // 체커 배경 (간단히)
    for (let py = 0; py < size; py += 6) {
      for (let px = 0; px < size; px += 6) {
        ctx.fillStyle = ((px / 6 + py / 6) % 2 === 0) ? "#888" : "#aaa";
        ctx.fillRect(px, py, 6, 6);
      }
    }
    if (frame.source) {
      const tmp = imageDataToCanvas2(frame.source);
      const ratio = Math.min(size / frame.source.width, size / frame.source.height);
      const w = frame.source.width * ratio;
      const h = frame.source.height * ratio;
      ctx.drawImage(tmp, (size - w) / 2, (size - h) / 2, w, h);
    }
    div.appendChild(c);
    const num = document.createElement("span");
    num.className = "tl-frame-num";
    num.textContent = String(i + 1);
    div.appendChild(num);
    div.addEventListener("click", () => selectFrame(i));
    container.appendChild(div);
    if (i === state.frameIdx) {
      // active 프레임이 보이도록 스크롤
      setTimeout(() => div.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" }), 0);
    }
  });
  $("tl-info").textContent = state.frames.length === 0
    ? "프레임 0개"
    : `프레임 ${state.frameIdx + 1} / ${state.frames.length}`;
}

$("tl-remove").addEventListener("click", () => {
  if (state.frames.length === 0) return;
  removeFrame(state.frameIdx);
});
$("tl-prev").addEventListener("click", () => {
  if (state.frames.length < 2) return;
  selectFrame((state.frameIdx - 1 + state.frames.length) % state.frames.length);
});
$("tl-next").addEventListener("click", () => {
  if (state.frames.length < 2) return;
  selectFrame((state.frameIdx + 1) % state.frames.length);
});

let playInterval = null;
$("tl-play").addEventListener("click", () => {
  if (state.frames.length < 2) return;
  if (playInterval) clearInterval(playInterval);
  const fps = Math.max(1, parseInt($("tl-fps").value, 10) || 12);
  $("tl-play").disabled = true;
  $("tl-stop").disabled = false;
  playInterval = setInterval(() => {
    state.frameIdx = (state.frameIdx + 1) % state.frames.length;
    invalidateSourceCache();
    renderTimeline();
    redraw();
  }, 1000 / fps);
});
$("tl-stop").addEventListener("click", () => {
  if (playInterval) { clearInterval(playInterval); playInterval = null; }
  $("tl-play").disabled = false;
  $("tl-stop").disabled = true;
});
$("tl-fps").addEventListener("input", () => {
  if (playInterval) {
    clearInterval(playInterval);
    const fps = Math.max(1, parseInt($("tl-fps").value, 10) || 12);
    playInterval = setInterval(() => {
      state.frameIdx = (state.frameIdx + 1) % state.frames.length;
      invalidateSourceCache();
      renderTimeline();
      redraw();
    }, 1000 / fps);
  }
});
$("tl-onion").addEventListener("change", redraw);

// ---------- 통합 저장 메뉴 ----------
$("btn-save-menu").addEventListener("click", () => {
  if (state.frames.length === 0) {
    setStatus("프레임이 없습니다 — [+ 이미지 추가]로 시작하세요");
    return;
  }
  const cur = state.frames[state.frameIdx];
  showModal("저장", `
    <div style="display:flex; flex-direction:column; gap:8px; margin-bottom:12px;">
      <label style="display:flex; gap:8px; align-items:center; cursor:pointer;"><input type="radio" name="save-mode" value="png" checked> 현재 프레임 PNG <span style="color:#888; font-size:11px;">(${cur.source.width}×${cur.source.height})</span></label>
      <label style="display:flex; gap:8px; align-items:center; cursor:pointer;"><input type="radio" name="save-mode" value="zip"> 모든 프레임 ZIP <span style="color:#888; font-size:11px;">(${state.frames.length}장)</span></label>
      <label style="display:flex; gap:8px; align-items:center; cursor:pointer;"><input type="radio" name="save-mode" value="sheet"> 스프라이트 시트 PNG <span style="color:#888; font-size:11px;">(${state.frames.length}장 그리드)</span></label>
      <label style="display:flex; gap:8px; align-items:center; cursor:pointer;"><input type="radio" name="save-mode" value="gif"> GIF 애니메이션</label>
    </div>
    <div style="border-top:1px solid #444; padding-top:10px;">
      <div class="modal-row"><label>시트 컬럼 <input type="number" id="sm-cols" value="8" min="1" max="64"></label><label>패딩 <input type="number" id="sm-padding" value="0" min="0" max="32"></label></div>
      <div class="modal-row"><label>GIF FPS <input type="number" id="sm-fps" value="12" min="1" max="60"></label><label>GIF 스케일 <input type="number" id="sm-scale" value="4" min="1" max="16"></label></div>
    </div>
    <div class="modal-row" style="justify-content:flex-end; margin-top:18px;">
      <button id="sm-execute" class="primary">저장</button>
    </div>
  `);
  $("sm-execute").addEventListener("click", async () => {
    const mode = document.querySelector('input[name="save-mode"]:checked').value;
    const ts = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
    if (mode === "png") {
      const c = freshCanvas(state.source);
      const blob = await new Promise((res) => c.toBlob(res, "image/png"));
      const base = stripExt(state.fileName) || "frame";
      const tag = state.pixelized ? `_${state.source.width}x${state.source.height}` : "";
      downloadBlob(blob, `${base}${tag}.png`);
      hideModal();
    } else if (mode === "zip") {
      const zip = new JSZip();
      for (let i = 0; i < state.frames.length; i++) {
        const f = state.frames[i];
        const c = freshCanvas(f.source);
        const blob = await new Promise((res) => c.toBlob(res, "image/png"));
        const base = stripExt(f.fileName) || `frame_${i + 1}`;
        zip.file(`${String(i + 1).padStart(3, "0")}_${base}.png`, blob);
      }
      const zipBlob = await zip.generateAsync({ type: "blob" });
      downloadBlob(zipBlob, `pixelmotion_${ts}.zip`);
      hideModal();
    } else if (mode === "sheet") {
      const cols = Math.max(1, parseInt($("sm-cols").value, 10) || 8);
      const padding = Math.max(0, parseInt($("sm-padding").value, 10) || 0);
      const maxW = Math.max(...state.frames.map(f => f.source.width));
      const maxH = Math.max(...state.frames.map(f => f.source.height));
      const rows = Math.ceil(state.frames.length / cols);
      const sheetW = cols * maxW + (cols + 1) * padding;
      const sheetH = rows * maxH + (rows + 1) * padding;
      const c = document.createElement("canvas");
      c.width = sheetW; c.height = sheetH;
      const ctx = c.getContext("2d");
      ctx.imageSmoothingEnabled = false;
      state.frames.forEach((f, i) => {
        const r = Math.floor(i / cols);
        const cc = i % cols;
        const x = padding + cc * (maxW + padding);
        const y = padding + r * (maxH + padding);
        ctx.drawImage(imageDataToCanvas2(f.source), x, y);
      });
      c.toBlob((blob) => {
        downloadBlob(blob, `sheet_${cols}x${rows}_${maxW}x${maxH}_${ts}.png`);
        hideModal();
      });
    } else if (mode === "gif") {
      if (typeof GIF === "undefined") {
        setStatus("GIF 라이브러리 로드 실패");
        return;
      }
      const fps = Math.max(1, parseInt($("sm-fps").value, 10) || 12);
      const scale = Math.max(1, parseInt($("sm-scale").value, 10) || 4);
      const W = state.frames[0].source.width * scale;
      const H = state.frames[0].source.height * scale;
      const gif = new GIF({
        workers: 2, quality: 10, width: W, height: H,
        workerScript: "https://cdn.jsdelivr.net/npm/gif.js@0.2.0/dist/gif.worker.js",
      });
      state.frames.forEach((f) => {
        const cc = document.createElement("canvas");
        cc.width = W; cc.height = H;
        const cctx = cc.getContext("2d");
        cctx.imageSmoothingEnabled = false;
        cctx.drawImage(imageDataToCanvas2(f.source), 0, 0, W, H);
        gif.addFrame(cc, { delay: 1000 / fps, copy: true });
      });
      const btn = $("sm-execute");
      btn.disabled = true;
      gif.on("progress", (p) => { btn.textContent = `GIF... ${Math.round(p * 100)}%`; });
      gif.on("finished", (blob) => {
        downloadBlob(blob, `animation_${state.frames.length}f_${fps}fps_${ts}.gif`);
        hideModal();
      });
      gif.render();
    }
  });
});

// ---------- (구) 스프라이트 시트 패킹 모달 — 통합 저장 메뉴로 대체 ----------
if (false) $("btn-sheet").addEventListener("click", () => {
  showModal("스프라이트 시트 패킹", `
    <div class="modal-row">
      <button id="sheet-pick">이미지 선택 (여러 장)</button>
      <input type="file" id="sheet-files" accept="image/*" multiple style="display:none;">
      <span class="modal-info" id="sheet-status">파일 미선택</span>
    </div>
    <div class="modal-row">
      <label>컬럼 수 <input type="number" id="sheet-cols" value="8" min="1" max="64"></label>
      <label>패딩 <input type="number" id="sheet-padding" value="0" min="0" max="32"></label>
    </div>
    <div class="modal-info">
      • 이미지 사이즈가 다르면 가장 큰 사이즈로 통일됨 (각 셀)<br>
      • 패딩 = 셀 사이/외곽 빈 공간 (픽셀)
    </div>
    <div class="modal-row" style="justify-content:flex-end; margin-top:18px;">
      <button id="sheet-build" class="primary" disabled>시트 생성 → 다운로드</button>
    </div>
  `);
  let files = [];
  $("sheet-pick").addEventListener("click", () => $("sheet-files").click());
  $("sheet-files").addEventListener("change", () => {
    files = Array.from($("sheet-files").files);
    $("sheet-status").textContent = `${files.length}장 선택됨`;
    $("sheet-build").disabled = files.length === 0;
  });
  $("sheet-build").addEventListener("click", async () => {
    if (files.length === 0) return;
    const cols = Math.max(1, parseInt($("sheet-cols").value, 10) || 8);
    const padding = Math.max(0, parseInt($("sheet-padding").value, 10) || 0);
    $("sheet-build").disabled = true;
    $("sheet-status").textContent = "처리 중...";
    try {
      const images = await Promise.all(files.map((f) => decodeFileToImageData(f)));
      const maxW = Math.max(...images.map((i) => i.width));
      const maxH = Math.max(...images.map((i) => i.height));
      const rows = Math.ceil(images.length / cols);
      const sheetW = cols * maxW + (cols + 1) * padding;
      const sheetH = rows * maxH + (rows + 1) * padding;
      const canvas = document.createElement("canvas");
      canvas.width = sheetW;
      canvas.height = sheetH;
      const ctx = canvas.getContext("2d");
      ctx.imageSmoothingEnabled = false;
      images.forEach((img, i) => {
        const r = Math.floor(i / cols);
        const c = i % cols;
        const x = padding + c * (maxW + padding);
        const y = padding + r * (maxH + padding);
        ctx.drawImage(imageDataToCanvas2(img), x, y);
      });
      canvas.toBlob((blob) => {
        const ts = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
        downloadBlob(blob, `sheet_${cols}x${rows}_${maxW}x${maxH}_${ts}.png`);
        $("sheet-status").textContent = `완료: ${cols}×${rows} (${sheetW}×${sheetH}px)`;
        $("sheet-build").disabled = false;
      });
    } catch (e) {
      $("sheet-status").textContent = "실패: " + e.message;
      $("sheet-build").disabled = false;
    }
  });
});

// ---------- 애니메이션 재생 + GIF Export ----------
$("btn-anim")?.addEventListener("click", () => {
  let frames = [];
  let frameIdx = 0;
  let interval = null;

  showModal("애니메이션 미리보기", `
    <div class="modal-row">
      <button id="anim-pick">프레임 선택 (여러 장)</button>
      <input type="file" id="anim-files" accept="image/*" multiple style="display:none;">
      <span class="modal-info" id="anim-status">프레임 미선택</span>
    </div>
    <div id="anim-stage">
      <canvas id="anim-canvas" width="200" height="200"></canvas>
    </div>
    <div class="modal-row">
      <button id="anim-play">▶ 재생</button>
      <button id="anim-stop">⏸ 정지</button>
      <label>FPS <input type="number" id="anim-fps" value="12" min="1" max="60"></label>
      <label>스케일 <input type="number" id="anim-scale" value="4" min="1" max="16"></label>
      <button id="anim-export-gif" class="primary" style="margin-left:auto;" disabled>GIF 저장</button>
    </div>
    <div class="modal-info">파일 이름순으로 정렬되어 프레임 순서가 결정됩니다 (예: 01.png, 02.png ...)</div>
  `, () => { if (interval) clearInterval(interval); });

  function drawAnimFrame() {
    if (frames.length === 0) return;
    const f = frames[frameIdx];
    const scale = Math.max(1, parseInt($("anim-scale").value, 10) || 4);
    const c = $("anim-canvas");
    c.width = f.width * scale;
    c.height = f.height * scale;
    const ctx = c.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.drawImage(imageDataToCanvas2(f), 0, 0, c.width, c.height);
    $("anim-status").textContent = `${frameIdx + 1}/${frames.length} · ${f.width}×${f.height}`;
  }

  $("anim-pick").addEventListener("click", () => $("anim-files").click());
  $("anim-files").addEventListener("change", async () => {
    const files = Array.from($("anim-files").files).sort((a, b) => a.name.localeCompare(b.name));
    if (files.length === 0) return;
    $("anim-status").textContent = `로딩 중... 0/${files.length}`;
    frames = [];
    for (let i = 0; i < files.length; i++) {
      try {
        frames.push(await decodeFileToImageData(files[i]));
      } catch (e) { /* skip */ }
      $("anim-status").textContent = `로딩 중... ${i + 1}/${files.length}`;
    }
    frameIdx = 0;
    if (frames.length > 0) {
      drawAnimFrame();
      $("anim-export-gif").disabled = false;
    } else {
      $("anim-status").textContent = "로드 실패";
    }
  });

  $("anim-play").addEventListener("click", () => {
    if (frames.length === 0) return;
    if (interval) clearInterval(interval);
    const fps = Math.max(1, parseInt($("anim-fps").value, 10) || 12);
    interval = setInterval(() => {
      frameIdx = (frameIdx + 1) % frames.length;
      drawAnimFrame();
    }, 1000 / fps);
  });
  $("anim-stop").addEventListener("click", () => {
    if (interval) { clearInterval(interval); interval = null; }
  });
  $("anim-scale").addEventListener("input", drawAnimFrame);
  $("anim-fps").addEventListener("input", () => {
    if (interval) {
      clearInterval(interval);
      const fps = Math.max(1, parseInt($("anim-fps").value, 10) || 12);
      interval = setInterval(() => {
        frameIdx = (frameIdx + 1) % frames.length;
        drawAnimFrame();
      }, 1000 / fps);
    }
  });

  $("anim-export-gif").addEventListener("click", () => {
    if (frames.length === 0) return;
    if (typeof GIF === "undefined") {
      $("anim-status").textContent = "GIF 라이브러리 로드 실패 (인터넷 연결 확인)";
      return;
    }
    const fps = Math.max(1, parseInt($("anim-fps").value, 10) || 12);
    const scale = Math.max(1, parseInt($("anim-scale").value, 10) || 4);
    const W = frames[0].width * scale;
    const H = frames[0].height * scale;
    const gif = new GIF({
      workers: 2,
      quality: 10,
      width: W,
      height: H,
      workerScript: "https://cdn.jsdelivr.net/npm/gif.js@0.2.0/dist/gif.worker.js",
    });
    frames.forEach((f) => {
      const c = document.createElement("canvas");
      c.width = W;
      c.height = H;
      const ctx = c.getContext("2d");
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(imageDataToCanvas2(f), 0, 0, W, H);
      gif.addFrame(c, { delay: 1000 / fps, copy: true });
    });
    const btn = $("anim-export-gif");
    btn.disabled = true;
    gif.on("progress", (p) => { btn.textContent = `GIF... ${Math.round(p * 100)}%`; });
    gif.on("finished", (blob) => {
      const ts = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
      downloadBlob(blob, `animation_${frames.length}f_${fps}fps_${ts}.gif`);
      btn.textContent = "GIF 저장";
      btn.disabled = false;
    });
    gif.render();
  });
});
