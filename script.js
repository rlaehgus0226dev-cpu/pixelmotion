const $ = (id) => document.getElementById(id);

const state = {
  frames: [],              // [{ source, original, pixelized, fileName, traceLayer, visible, opacity, name }]
  // 두 슬롯 — 좌(0), 우(1). 우측은 frameIdx=-1이면 비활성(단일 뷰)
  slots: [
    { frameIdx: 0, layout: null },
    { frameIdx: -1, layout: null },
  ],
  activeSlot: 0,           // 마우스 hover/마지막 클릭 슬롯
  selection: null,
  draftSelection: null,
  zoom: "fit",
  panX: 0,
  panY: 0,
  activeColor: [0, 0, 0],
  palette: [],
  tracing: false,
  guideOpacity: 0.5,
  viewMode: "anim",        // "anim" | "layer"
};

// frameIdx, layout은 active slot의 alias
Object.defineProperty(state, "frameIdx", {
  get() { return state.slots[state.activeSlot]?.frameIdx ?? 0; },
  set(v) { const s = state.slots[state.activeSlot]; if (s) s.frameIdx = v; },
});
Object.defineProperty(state, "layout", {
  get() { return state.slots[state.activeSlot]?.layout ?? null; },
  set(v) { const s = state.slots[state.activeSlot]; if (s) s.layout = v; },
});

// 함수에서 참조하는 모듈 변수들 — 위로 끌어올려서 TDZ 회피
let _clipboard = null;
// floatingPaste = { imageData, slotIdx, x, y } — paste 미확정 상태. 마우스 위치 따라 이동
let _floating = null;

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
  const f = state.frames[state.frameIdx];
  history.push({
    frameIdx: state.frameIdx,
    original: f ? f.original : null,
    source: f ? f.source : null,
    pixelized: f ? f.pixelized : false,
    traceLayer: f ? f.traceLayer : null,
  });
  if (history.length > HISTORY_LIMIT) history.shift();
  updateUndoButton();
}

function undo() {
  if (history.length === 0) return;
  const s = history.pop();
  if (s.frameIdx >= 0 && s.frameIdx < state.frames.length) {
    state.frameIdx = s.frameIdx;
    const f = state.frames[s.frameIdx];
    if (f) {
      f.original = s.original;
      f.source = s.source;
      f.pixelized = s.pixelized;
      f.traceLayer = s.traceLayer;
    }
  }
  invalidateSourceCache();
  renderTimeline();
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

let _statusClearTimer = null;
let _toastClearTimer = null;
function setStatus(text, type = "") {
  // 하단 status (보조)
  const el = $("status");
  el.textContent = text;
  el.className = type;
  if (_statusClearTimer) { clearTimeout(_statusClearTimer); _statusClearTimer = null; }
  if (type === "success") {
    _statusClearTimer = setTimeout(() => {
      if (el.textContent === text) { el.textContent = ""; el.className = ""; }
    }, 3000);
  }

  // 캔버스 위 toast (주된 표시)
  const toast = $("toast");
  if (toast) {
    if (_toastClearTimer) { clearTimeout(_toastClearTimer); _toastClearTimer = null; }
    if (text) {
      toast.textContent = text;
      toast.className = "show " + type;
      if (type === "success") {
        _toastClearTimer = setTimeout(() => { toast.className = ""; }, 2000);
      } else if (type === "error") {
        _toastClearTimer = setTimeout(() => { toast.className = ""; }, 4000);
      } else if (type !== "processing") {
        // 일반 info (되돌림, 선택 해제 등): 짧게 1.5초
        _toastClearTimer = setTimeout(() => { toast.className = ""; }, 1500);
      }
      // processing은 명시 변경 전까지 유지
    } else {
      toast.className = "";
    }
  }
}
function getGridSize() {
  const inp = document.getElementById("grid-input");
  if (!inp) return 64;
  let n = parseInt(inp.value, 10);
  if (isNaN(n) || n < 4) n = 4;
  if (n > 512) n = 512;
  return n;
}
function getColorLimit() { return parseInt(document.querySelector('input[name="color"]:checked').value, 10); }
function showGrid() { return $("show-grid").checked; }

function fitCanvasEl(canvasEl, ctxEl) {
  const parent = canvasEl.parentElement;
  const dpr = window.devicePixelRatio || 1;
  const w = parent.clientWidth;
  const h = parent.clientHeight;
  if (canvasEl.width !== Math.round(w * dpr) || canvasEl.height !== Math.round(h * dpr)) {
    canvasEl.width = Math.round(w * dpr);
    canvasEl.height = Math.round(h * dpr);
  }
  canvasEl.style.width = w + "px";
  canvasEl.style.height = h + "px";
  ctxEl.setTransform(dpr, 0, 0, dpr, 0, 0);
}
function fitCanvas() { fitCanvasEl(canvas, ctx); }

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

function drawCheckerboardOn(c, x, y, w, h, tile = 10) {
  for (let py = 0; py < h; py += tile) {
    for (let px = 0; px < w; px += tile) {
      const dark = ((Math.floor(px / tile) + Math.floor(py / tile)) % 2) === 1;
      c.fillStyle = dark ? "#aaaaaa" : "#dcdcdc";
      c.fillRect(x + px, y + py, Math.min(tile, w - px), Math.min(tile, h - py));
    }
  }
}
function drawCheckerboard(x, y, w, h, tile = 10) {
  drawCheckerboardOn(ctx, x, y, w, h, tile);
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
  drawSlot(0, canvas, ctx);
  if (state.slots[1].frameIdx >= 0) {
    drawSlot(1, refCanvas, refCtx);
  }
  // 활성 슬롯 정보로 badge / file-info 갱신
  const af = state.frames[state.slots[state.activeSlot]?.frameIdx ?? 0];
  const badge = $("badge");
  if (af && af.source) {
    badge.textContent = `${af.source.width} × ${af.source.height} px`;
    badge.classList.remove("hidden");
    $("file-info").textContent = `${af.fileName || ""} · ${af.source.width} × ${af.source.height} px`;
  } else {
    badge.classList.add("hidden");
    $("file-info").textContent = "";
  }
  // 우측 패널 해상도 라벨 (있을 때만)
  const resLabel = document.getElementById("res-current");
  if (resLabel) {
    if (af && af.source) resLabel.textContent = `현재 ${af.source.width}×${af.source.height}`;
    else resLabel.textContent = "";
  }
}

function drawSlot(slotIdx, canvasEl, ctxEl) {
  fitCanvasEl(canvasEl, ctxEl);
  const cw = canvasEl.clientWidth;
  const ch = canvasEl.clientHeight;
  ctxEl.fillStyle = "#1e1e1e";
  ctxEl.fillRect(0, 0, cw, ch);

  const slot = state.slots[slotIdx];
  if (!slot) return;
  const f = state.frames[slot.frameIdx];
  if (!f || !f.source) {
    slot.layout = null;
    return;
  }
  const src = f.source;
  const iw = src.width;
  const ih = src.height;

  let dw, dh, x, y;
  if (state.zoom === "fit") {
    if (f.pixelized) {
      const ps = Math.max(1, Math.min(Math.floor(cw * 0.95 / iw), Math.floor(ch * 0.95 / ih)));
      dw = iw * ps; dh = ih * ps;
      ctxEl.imageSmoothingEnabled = false;
    } else {
      const scale = Math.min(cw / iw, ch / ih) * 0.95;
      dw = Math.max(1, Math.floor(iw * scale));
      dh = Math.max(1, Math.floor(ih * scale));
      ctxEl.imageSmoothingEnabled = true;
      ctxEl.imageSmoothingQuality = "high";
    }
    x = Math.floor((cw - dw) / 2);
    y = Math.floor((ch - dh) / 2);
  } else {
    const z = state.zoom;
    dw = Math.max(1, Math.round(iw * z));
    dh = Math.max(1, Math.round(ih * z));
    x = Math.round((cw - dw) / 2 + state.panX);
    y = Math.round((ch - dh) / 2 + state.panY);
    ctxEl.imageSmoothingEnabled = false;
  }
  slot.layout = { x, y, dw, dh, iw, ih };

  drawCheckerboardOn(ctxEl, x, y, dw, dh);

  // 어니언 스킨 — 활성 슬롯 + 애니메이션 모드에서만 (레이어 모드는 별도 stacked 렌더)
  if (slotIdx === state.activeSlot && state.viewMode === "anim") {
    const onionRange = getOnionRange();
    const onionTint = $("onion-tint")?.checked;
    if (onionRange !== 0 && state.frames.length > 1) {
      const total = state.frames.length;
      const maxRange = onionRange === "all" ? total - 1 : onionRange;
      ctxEl.save();
      // 거리별 그리기 (멀수록 흐려짐)
      for (let d = maxRange; d >= 1; d--) {
        const alpha = 0.5 * (1 - (d - 1) / Math.max(1, maxRange));
        const prevIdx = (slot.frameIdx - d + total * d) % total;
        const nextIdx = (slot.frameIdx + d) % total;
        // prev (붉은 틴트)
        if (prevIdx !== slot.frameIdx) {
          const prev = state.frames[prevIdx];
          if (prev && prev.source && prev.visible !== false) {
            drawTintedFrame(ctxEl, prev, x, y, dw, dh, alpha, onionTint ? "#ff5555" : null);
          }
        }
        // next (푸른 틴트)
        if (nextIdx !== slot.frameIdx && nextIdx !== prevIdx) {
          const next = state.frames[nextIdx];
          if (next && next.source && next.visible !== false) {
            drawTintedFrame(ctxEl, next, x, y, dw, dh, alpha, onionTint ? "#5599ff" : null);
          }
        }
      }
      ctxEl.restore();
    }
  }

  // 레이어 모드: 모든 표시(👁) 프레임을 패널 순서대로 stacked.
  // 패널 = 위가 앞 (frames 배열 순으로 그려서 마지막=최상단). 활성 프레임도 동일 순서.
  if (slotIdx === state.activeSlot && state.viewMode === "layer") {
    ctxEl.save();
    state.frames.forEach((fr, i) => {
      if (fr.visible === false) return;
      if (!fr.source) return;
      const op = fr.opacity === undefined ? 1 : fr.opacity;
      if (op <= 0) return;
      ctxEl.globalAlpha = op;
      ctxEl.drawImage(imageDataToCanvas2(fr.source), x, y, dw, dh);
      if (fr.traceLayer) ctxEl.drawImage(imageDataToCanvas2(fr.traceLayer), x, y, dw, dh);
    });
    ctxEl.restore();
    // 레이어 모드에서는 아래 활성 프레임 블록을 건너뜀 → 일찍 빠지기 위해 플래그
    state._layerModeRendered = true;
  } else {
    state._layerModeRendered = false;
  }

  // 활성 프레임 본체 + 트레이싱 (애니메이션 모드일 때만 — 레이어 모드는 위에서 다 그렸음)
  if (!state._layerModeRendered || slotIdx !== state.activeSlot) {
    const guideAlpha = (state.tracing && slotIdx === state.activeSlot) ? state.guideOpacity : 1.0;
    if (guideAlpha > 0) {
      ctxEl.save();
      ctxEl.globalAlpha = guideAlpha;
      ctxEl.drawImage(imageDataToCanvas2(src), x, y, dw, dh);
      ctxEl.restore();
    }
    if (f.traceLayer) {
      ctxEl.drawImage(imageDataToCanvas2(f.traceLayer), x, y, dw, dh);
    }
  }

  // 격자
  if ($("show-grid").checked) {
    drawGridInternal(ctxEl, slotIdx, x, y, dw, dh);
  }

  // 선택 영역 — 활성 슬롯에만
  if (slotIdx === state.activeSlot) {
    drawSelectionInternal(ctxEl, slotIdx);
  }

  // 활성 슬롯 강조 (분할 모드일 때)
  if (state.slots[1].frameIdx >= 0 && slotIdx === state.activeSlot) {
    ctxEl.save();
    ctxEl.strokeStyle = "#4a8";
    ctxEl.lineWidth = 2;
    ctxEl.strokeRect(1, 1, cw - 2, ch - 2);
    ctxEl.restore();
  }

  // floating paste 미리보기 — 활성 슬롯에만
  if (_floating && _floating.slotIdx === slotIdx) {
    const fp = _floating;
    const fpImg = fp.rotated || fp.imageData;
    const px = x + fp.x / iw * dw;
    const py = y + fp.y / ih * dh;
    const pw = fpImg.width / iw * dw;
    const ph = fpImg.height / ih * dh;
    ctxEl.save();
    ctxEl.globalAlpha = 0.75;
    ctxEl.imageSmoothingEnabled = false;
    ctxEl.drawImage(imageDataToCanvas2(fpImg), px, py, pw, ph);
    ctxEl.restore();
    ctxEl.save();
    ctxEl.strokeStyle = "#ffaa00";
    ctxEl.lineWidth = 1;
    ctxEl.setLineDash([4, 3]);
    ctxEl.strokeRect(Math.round(px) + 0.5, Math.round(py) + 0.5, Math.round(pw), Math.round(ph));
    ctxEl.setLineDash([]);
    // 각도 표시
    if (fp.rotation) {
      ctxEl.fillStyle = "rgba(255,170,0,0.95)";
      ctxEl.font = "bold 11px Consolas, monospace";
      ctxEl.fillText(`${Math.round(fp.rotation)}°`, Math.round(px) + 4, Math.round(py) + 13);
    }
    ctxEl.restore();
  }
}

function drawGridInternal(ctxEl, slotIdx, x, y, w, h) {
  const sub = getSub();
  const showSub = $("show-subgrid").checked;
  const slot = state.slots[slotIdx];
  const f = slot ? state.frames[slot.frameIdx] : null;

  if (!showSub && sub > 1) {
    const baseN = getGridSize();
    let bc, br;
    if (f && f.pixelized && f.source) {
      bc = Math.max(1, Math.round(f.source.width / sub));
      br = Math.max(1, Math.round(f.source.height / sub));
    } else if (f && f.source) {
      const d = gridDims(f.source.width, f.source.height, baseN);
      bc = d.cols; br = d.rows;
    } else {
      bc = br = baseN;
    }
    ctxEl.strokeStyle = "#000";
    ctxEl.lineWidth = 1;
    ctxEl.beginPath();
    for (let i = 0; i <= bc; i++) {
      const gx = Math.round(x + w * i / bc) + 0.5;
      ctxEl.moveTo(gx, y); ctxEl.lineTo(gx, y + h);
    }
    for (let j = 0; j <= br; j++) {
      const gy = Math.round(y + h * j / br) + 0.5;
      ctxEl.moveTo(x, gy); ctxEl.lineTo(x + w, gy);
    }
    ctxEl.stroke();
    return;
  }

  let cols, rows;
  if (f && f.source) {
    if (f.pixelized) {
      cols = f.source.width;
      rows = f.source.height;
    } else {
      const dims = gridDims(f.source.width, f.source.height, getGridSize() * sub);
      cols = dims.cols; rows = dims.rows;
    }
  } else {
    cols = rows = getGridSize() * sub;
  }

  ctxEl.strokeStyle = "#000";
  ctxEl.lineWidth = 1;
  ctxEl.beginPath();
  for (let i = 0; i <= cols; i++) {
    if (sub > 1 && i % sub === 0) continue;
    const gx = Math.round(x + w * i / cols) + 0.5;
    ctxEl.moveTo(gx, y); ctxEl.lineTo(gx, y + h);
  }
  for (let j = 0; j <= rows; j++) {
    if (sub > 1 && j % sub === 0) continue;
    const gy = Math.round(y + h * j / rows) + 0.5;
    ctxEl.moveTo(x, gy); ctxEl.lineTo(x + w, gy);
  }
  ctxEl.stroke();

  if (sub > 1) {
    ctxEl.strokeStyle = "#ff3344";
    ctxEl.lineWidth = 1;
    ctxEl.beginPath();
    for (let i = 0; i <= cols; i += sub) {
      const gx = Math.round(x + w * i / cols) + 0.5;
      ctxEl.moveTo(gx, y); ctxEl.lineTo(gx, y + h);
    }
    for (let j = 0; j <= rows; j += sub) {
      const gy = Math.round(y + h * j / rows) + 0.5;
      ctxEl.moveTo(x, gy); ctxEl.lineTo(x + w, gy);
    }
    ctxEl.stroke();
  }
}

function drawSelectionInternal(ctxEl, slotIdx) {
  const isDraft = !!state.draftSelection;
  const sel = state.draftSelection || state.selection;
  const slot = state.slots[slotIdx];
  if (!sel || !slot || !slot.layout) return;
  const { x, y, dw, dh, iw, ih } = slot.layout;
  ctxEl.save();
  ctxEl.strokeStyle = "#ffaa00";
  ctxEl.lineWidth = 1;
  ctxEl.setLineDash([5, 3]);
  if (sel.type === "rect") {
    const sx1 = Math.min(sel.x1, sel.x2);
    const sy1 = Math.min(sel.y1, sel.y2);
    const sx2 = Math.max(sel.x1, sel.x2);
    const sy2 = Math.max(sel.y1, sel.y2);
    const px1 = x + sx1 / iw * dw;
    const py1 = y + sy1 / ih * dh;
    const px2 = x + sx2 / iw * dw;
    const py2 = y + sy2 / ih * dh;
    ctxEl.strokeRect(Math.round(px1) + 0.5, Math.round(py1) + 0.5, Math.round(px2 - px1), Math.round(py2 - py1));
  } else if (sel.type === "lasso" && sel.points.length > 1) {
    ctxEl.beginPath();
    sel.points.forEach((p, i) => {
      const px = x + p.x / iw * dw;
      const py = y + p.y / ih * dh;
      if (i === 0) ctxEl.moveTo(px, py);
      else ctxEl.lineTo(px, py);
    });
    if (!isDraft) ctxEl.closePath();
    ctxEl.stroke();
  } else if (sel.type === "mask" && sel.mask) {
    // 마스크 셀을 반투명 오렌지로 채워 표시
    const off = document.createElement("canvas");
    off.width = sel.w; off.height = sel.h;
    const oc = off.getContext("2d");
    const od = new ImageData(sel.w, sel.h);
    for (let i = 0; i < sel.mask.length; i++) {
      if (sel.mask[i]) {
        od.data[i * 4 + 0] = 255;
        od.data[i * 4 + 1] = 170;
        od.data[i * 4 + 2] = 0;
        od.data[i * 4 + 3] = 80;
      }
    }
    oc.putImageData(od, 0, 0);
    ctxEl.imageSmoothingEnabled = false;
    ctxEl.drawImage(off, x, y, dw, dh);
  }
  ctxEl.setLineDash([]);
  ctxEl.restore();
}

// ---------- 이미지/프레임 로드 ----------
const STANDARD_GRIDS = [8, 16, 32, 48, 64, 128, 256];

// 이미지 사이즈에 맞는 권장 격자값
function suggestGridForImage(w, h) {
  const minDim = Math.min(w, h);
  // 16 이상 격자 중 정확히 나뉘는 값들 → 64에 가장 가까운 것 선택
  const exact = STANDARD_GRIDS.filter(n => minDim % n === 0 && n >= 16);
  if (exact.length > 0) {
    return exact.reduce((a, b) => Math.abs(a - 64) < Math.abs(b - 64) ? a : b);
  }
  return 64;
}

// 이미지를 격자 N의 정수배 사이즈로 bilinear 리사이즈 (정렬용)
function alignImageToGrid(imgData, gridN) {
  const W = imgData.width, H = imgData.height;
  const newW = Math.max(gridN, Math.round(W / gridN) * gridN);
  const newH = Math.max(gridN, Math.round(H / gridN) * gridN);
  if (newW === W && newH === H) return imgData;
  const src = document.createElement("canvas");
  src.width = W; src.height = H;
  src.getContext("2d").putImageData(imgData, 0, 0);
  const out = document.createElement("canvas");
  out.width = newW; out.height = newH;
  const oc = out.getContext("2d");
  oc.imageSmoothingEnabled = true;
  oc.imageSmoothingQuality = "high";
  oc.drawImage(src, 0, 0, newW, newH);
  return oc.getImageData(0, 0, newW, newH);
}

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
    let imgData = cctx.getImageData(0, 0, c.width, c.height);
    const W = imgData.width, H = imgData.height;
    const autoCleanup = document.getElementById("auto-cleanup")?.checked;

    if (autoCleanup) {
      // A+B: 권장 격자로 input 갱신 + 격자 정렬 리사이즈 + 자동 도트화
      const useGrid = suggestGridForImage(W, H);
      const gridInp = document.getElementById("grid-input");
      if (gridInp) gridInp.value = String(useGrid);
      imgData = alignImageToGrid(imgData, useGrid);
      addFrame(imgData, file.name);
      // 즉시 도트화
      pixelizeFrame(state.frames[state.frameIdx]);
      invalidateSourceCache();
      refreshPalette();
      renderTimeline();
      redraw();
      const sub = getSub();
      setStatus(`자동 정리: ${W}×${H} → 격자 ${useGrid}${sub > 1 ? `×${sub} 세분` : ''} 도트화 완료`, "success");
    } else {
      addFrame(imgData, file.name);
      // 격자가 안 맞으면 토스트로 추천
      const curGrid = getGridSize();
      if (W % curGrid !== 0 || H % curGrid !== 0) {
        const suggested = suggestGridForImage(W, H);
        if (suggested !== curGrid) {
          setStatus(`${W}×${H} 추가 — 격자 ${suggested} 추천 (정확히 나뉨). 탑바 [AI 자동 정리] ON 시 한번에 처리.`);
        }
      }
    }
  } finally {
    URL.revokeObjectURL(url);
  }
}

function isFrameBlank(f) {
  if (!f || !f.source) return true;
  const d = f.source.data;
  for (let i = 3; i < d.length; i += 4) {
    if (d[i] !== 0) return false;
  }
  // traceLayer도 비어야 진짜 blank
  if (f.traceLayer) {
    const td = f.traceLayer.data;
    for (let i = 3; i < td.length; i += 4) {
      if (td[i] !== 0) return false;
    }
  }
  return true;
}

function isFrameUntitledBlank(f) {
  return f && f.fileName === "untitled" && isFrameBlank(f);
}

function addInitialBlankFrame() {
  const n = getGridSize() * getSub();
  const img = new ImageData(n, n);
  state.frames.push({
    source: img,
    original: img,
    pixelized: true,
    fileName: "untitled",
    name: "프레임 1",
    traceLayer: null,
    visible: true,
    opacity: 1.0,
  });
  state.frameIdx = 0;
  state.zoom = "fit";
  state.panX = 0;
  state.panY = 0;
  invalidateSourceCache();
}

function nearestUpscale(img, factor) {
  if (!img || factor < 2) return img;
  const oldW = img.width, oldH = img.height;
  const newW = oldW * factor, newH = oldH * factor;
  const out = new ImageData(newW, newH);
  const sd = img.data, od = out.data;
  for (let y = 0; y < newH; y++) {
    const sy = (y / factor) | 0;
    for (let x = 0; x < newW; x++) {
      const sx = (x / factor) | 0;
      const si = (sy * oldW + sx) * 4;
      const di = (y * newW + x) * 4;
      od[di] = sd[si];
      od[di + 1] = sd[si + 1];
      od[di + 2] = sd[si + 2];
      od[di + 3] = sd[si + 3];
    }
  }
  return out;
}

function expandResolutionFactor(factor) {
  if (state.frames.length === 0) {
    setStatus("프레임이 없습니다", "error");
    return;
  }
  const f = state.frames[state.frameIdx];
  if (!f || !f.source) return;
  if (factor < 2) return;
  const newW = f.source.width * factor;
  const newH = f.source.height * factor;
  if (newW > 4096 || newH > 4096) {
    setStatus(`너무 큽니다 (${newW}×${newH}). 4096 이하로`, "error");
    return;
  }
  snapshot();
  f.source = nearestUpscale(f.source, factor);
  if (f.original) f.original = nearestUpscale(f.original, factor);
  if (f.traceLayer) f.traceLayer = nearestUpscale(f.traceLayer, factor);
  f.pixelized = true;
  // sub UI를 1로 리셋 (이미 충분히 잘게)
  const subSel = document.getElementById("sub-select");
  if (subSel) subSel.value = "1";
  // 격자 input을 새 도트 수로 업데이트 (자유 입력이라 항상 가능)
  const gridInp = document.getElementById("grid-input");
  if (gridInp) gridInp.value = String(Math.min(512, newW));
  state.selection = null;
  state.draftSelection = null;
  invalidateSourceCache();
  refreshPalette();
  renderTimeline();
  redraw();
  setStatus(`해상도 ×${factor} 확대 → ${newW}×${newH}`, "success");
}

function resizeBlankCanvas() {
  const f = state.frames[state.frameIdx];
  if (!f || !isFrameUntitledBlank(f)) return false;
  const n = getGridSize() * getSub();
  if (f.source && f.source.width === n && f.source.height === n) return false;
  const img = new ImageData(n, n);
  f.source = img;
  f.original = img;
  f.traceLayer = null;
  f.pixelized = true;
  state.zoom = "fit";
  state.panX = 0;
  state.panY = 0;
  invalidateSourceCache();
  updateZoomDisplay();
  renderTimeline();
  redraw();
  return true;
}

function addFrame(imgData, fileName) {
  const idx = state.frames.length + 1;
  state.frames.push({
    source: imgData,
    original: imgData,
    pixelized: false,
    fileName: fileName || `frame_${idx}`,
    name: stripExt(fileName) || `프레임 ${idx}`,
    traceLayer: null,  // ImageData (사용자가 트레이싱 모드에서 그리면 lazy 생성)
    visible: true,
    opacity: 1.0,
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
  // 시작 시 자동 생성된 빈 untitled 프레임 1장만 있으면 제거 후 첨부
  if (files.length > 0 && state.frames.length === 1 && isFrameUntitledBlank(state.frames[0])) {
    state.frames = [];
    state.frameIdx = 0;
    clearHistory();
  }
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
  const sel = document.getElementById("sub-select");
  return sel ? parseInt(sel.value, 10) : 1;
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
  // traceLayer 사이즈를 새 source에 맞춤 (NEAREST 보간)
  if (frame.traceLayer && (frame.traceLayer.width !== result.width || frame.traceLayer.height !== result.height)) {
    frame.traceLayer = resizeImageDataNearest(frame.traceLayer, result.width, result.height);
  }
}

async function applyPixelize() {
  if (state.frames.length === 0) {
    setStatus("이미지를 먼저 추가하세요", "error");
    return;
  }
  const range = getApplyRange();
  const btn = $("btn-pixelize");
  btn.classList.add("processing");
  try {
    if (range === "all") {
      snapshot();
      const total = state.frames.length;
      for (let i = 0; i < total; i++) {
        setStatus(`도트화 처리 중... ${i + 1}/${total}`, "processing");
        await new Promise((r) => setTimeout(r, 0));
        pixelizeFrame(state.frames[i]);
      }
      setStatus(`도트화 완료 (${total} 프레임)`, "success");
    } else {
      if (!state.pixelized) snapshot();
      setStatus("도트화 처리 중...", "processing");
      await new Promise((r) => setTimeout(r, 0));
      pixelizeFrame(state.frames[state.frameIdx]);
      setStatus("도트화 완료", "success");
    }
    invalidateSourceCache();
    refreshPalette();
    renderTimeline();
    redraw();
  } catch (e) {
    setStatus("도트화 실패: " + e.message, "error");
  } finally {
    btn.classList.remove("processing");
  }
}

$("btn-pixelize").addEventListener("click", applyPixelize);

document.getElementById("grid-input")?.addEventListener("change", (e) => {
  // 입력 정상화 (clamp)
  const n = getGridSize();
  if (e.target.value !== String(n)) e.target.value = String(n);
  if (resizeBlankCanvas()) return;
  if (state.pixelized) applyPixelize(); else redraw();
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
document.getElementById("sub-select")?.addEventListener("change", () => {
  if (resizeBlankCanvas()) return;
  if (state.pixelized) applyPixelize(); else redraw();
});

// ---------- 배경 제거 (서버 rembg) ----------
$("btn-bg").addEventListener("click", async () => {
  if (!state.original) {
    setStatus("이미지를 먼저 열어주세요");
    return;
  }
  $("btn-bg").disabled = true;
  $("btn-bg").classList.add("processing");
  const precise = $("bg-precise").checked;
  setStatus(
    precise
      ? "배경 제거 중 (정밀)... 첫 호출 시 ~170MB 추가 다운로드, 시간 걸림"
      : "배경 제거 중...",
    "processing"
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
    setStatus("배경 제거 완료", "success");
  } catch (e) {
    history.pop();
    updateUndoButton();
    setStatus("배경 제거 실패: " + e.message, "error");
  } finally {
    $("btn-bg").disabled = false;
    $("btn-bg").classList.remove("processing");
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
// 내부 도구 값: "none" | "rect" | "lasso" | "brush" | "erase" | "pick"
// 단, UI 버튼은 "select"(rect|lasso 통합) / "brush" / "erase" / "pick" 만 노출
const TOOL_KEYS = {
  "m": "rect", "l": "lasso",
  "i": "pick", "b": "brush", "e": "erase",
};
const TOOL_LABEL = {
  none: "선택 없음", rect: "선택 (사각형)", lasso: "선택 (올가미)",
  pick: "스포이드", brush: "브러시", erase: "지우개",
};

let _activeTool = "none";
function getTool() { return _activeTool; }
function isSelectTool(t) { return t === "rect" || t === "lasso"; }

function setTool(t, opts = {}) {
  _activeTool = t || "none";
  // 도구 라디오 동기화 — rect/lasso면 "select" 라디오 활성
  let radioVal = _activeTool;
  if (isSelectTool(_activeTool)) radioVal = "select";
  const tr = document.querySelector(`input[name="tool"][value="${radioVal}"]`);
  if (tr) tr.checked = true;
  // 선택 도구의 sub-mode (rect/lasso) 라디오 동기화
  if (isSelectTool(_activeTool)) {
    const r = document.querySelector(`input[name="select-mode"][value="${_activeTool}"]`);
    if (r) r.checked = true;
  }
  // 도구별 옵션은 모두 항상 표시 (tool-prop 동적 토글 안 함)
  // 라벨 갱신
  const labelText = TOOL_LABEL[_activeTool] || "선택 없음";
  const nameBadge = document.getElementById("tool-name-badge");
  if (nameBadge) nameBadge.textContent = labelText;
  // 커서
  if (_activeTool === "brush" || _activeTool === "erase" || _activeTool === "pick") {
    canvas.style.cursor = "crosshair";
  } else {
    canvas.style.cursor = "";
  }
  state.draftSelection = null;
  redraw();
  if (!opts.silent) setStatus(`도구: ${labelText}`);
}
function getBoundsMode() {
  return "touch";  // 옵션 제거 — 항상 걸침 동작
}

function canvasToImageCoord(e, slotIdx = state.activeSlot) {
  const slot = state.slots[slotIdx];
  if (!slot || !slot.layout) return null;
  const f = state.frames[slot.frameIdx];
  if (!f) return null;
  const canvasEl = slotIdx === 0 ? canvas : refCanvas;
  const rect = canvasEl.getBoundingClientRect();
  const cx = e.clientX - rect.left;
  const cy = e.clientY - rect.top;
  const { x, y, dw, dh, iw, ih } = slot.layout;
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

function setActiveSlot(slotIdx) {
  if (state.activeSlot === slotIdx) return false;
  state.activeSlot = slotIdx;
  redraw();
  return true;
}

function onCanvasMouseDown(e, slotIdx) {
  // 슬롯 1이 비활성(frameIdx<0)이면 클릭 무시
  if (slotIdx === 1 && state.slots[1].frameIdx < 0) return;

  // floating paste 활성: 클릭으로 그 위치에 확정 (도구 무시)
  if (_floating) {
    e.preventDefault();
    setActiveSlot(slotIdx);
    commitFloating();
    return;
  }

  setActiveSlot(slotIdx);
  const tool = getTool();
  // 팬 우선: 미들버튼 / Space / Ctrl+Shift
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
    (slotIdx === 0 ? canvas : refCanvas).style.cursor = "grabbing";
    return;
  }
  // 좌클릭(0) 또는 우클릭(2)만 처리
  if (e.button !== 0 && e.button !== 2) return;
  const p = canvasToImageCoord(e, slotIdx);
  if (!p) return;

  // 우클릭 + 브러시 → 임시 지우개 (Aseprite 스타일)
  let effectiveTool = tool;
  if (e.button === 2) {
    if (tool !== "brush") return;  // 브러시일 때만 의미 있음
    effectiveTool = "erase";
    e.preventDefault();
  }

  if (effectiveTool === "pick") {
    pickColorAt(Math.floor(p.ix), Math.floor(p.iy));
    return;
  }
  if (effectiveTool === "brush" || effectiveTool === "erase") {
    snapshot();
    // 트레이싱 모드: traceLayer를 새 ImageData로 교체. 일반 모드: source 교체
    const f = state.frames[state.frameIdx];
    if (f) {
      if (state.tracing) {
        const tl = f.traceLayer;
        const w = f.source.width, h = f.source.height;
        const newImg = new ImageData(w, h);
        if (tl && tl.width === w && tl.height === h) newImg.data.set(tl.data);
        f.traceLayer = newImg;
      } else {
        const newImg = new ImageData(f.source.width, f.source.height);
        newImg.data.set(f.source.data);
        f.source = newImg;
      }
    }
    pixelDragging = true;
    pixelTool = effectiveTool;
    pixelLast = null;
    paintAt(e);
    return;
  }
  // 좌클릭만 영역 선택 도구로
  if (e.button !== 0) return;
  if (tool !== "rect" && tool !== "lasso") return;
  dragging = true;
  if (tool === "rect") {
    dragStart = p;
    state.draftSelection = { type: "rect", x1: p.ix, y1: p.iy, x2: p.ix, y2: p.iy };
  } else {
    state.draftSelection = { type: "lasso", points: [{ x: p.ix, y: p.iy }] };
  }
  redraw();
}
canvas.addEventListener("mousedown", (e) => onCanvasMouseDown(e, 0));
canvas.addEventListener("contextmenu", (e) => e.preventDefault());
// refCanvas mousedown 등록은 refCanvas 변수가 선언된 후 (아래에서)

window.addEventListener("mousemove", (e) => {
  // floating paste — 활성 슬롯의 마우스 좌표로 따라 이동
  if (_floating) {
    const slotIdx = state.activeSlot;
    const slot = state.slots[slotIdx];
    if (slot && slot.layout) {
      const canvasEl = slotIdx === 0 ? canvas : refCanvas;
      const rect = canvasEl.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      const ix = (cx - slot.layout.x) / slot.layout.dw * slot.layout.iw;
      const iy = (cy - slot.layout.y) / slot.layout.dh * slot.layout.ih;
      const fpImg = _floating.rotated || _floating.imageData;
      _floating.slotIdx = slotIdx;
      _floating.x = Math.round(ix - fpImg.width / 2);
      _floating.y = Math.round(iy - fpImg.height / 2);
      redraw();
    }
    return;
  }
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

window.addEventListener("mouseup", (e) => {
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
  if (sel.type === "mask" && sel.mask && sel.w === W && sel.h === H) {
    mask.set(sel.mask);
    return mask;
  }
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
  renderShadeStrip();
}

// 활성 색의 명암 단계 4개 (V −25%, −12%, +12%, +25%) 자동 표시
const SHADE_STEPS = [
  { d: -0.25, label: "−−" },
  { d: -0.12, label: "−" },
  { d:  0.12, label: "+" },
  { d:  0.25, label: "++" },
];
function renderShadeStrip() {
  const strip = $("shade-strip");
  if (!strip) return;
  const c = state.activeColor;
  const [h, s, v] = rgbToHsv(c[0], c[1], c[2]);
  strip.innerHTML = "";
  SHADE_STEPS.forEach(step => {
    const newV = Math.max(0, Math.min(1, v + step.d));
    const sc = hsvToRgb(h, s, newV);
    const cell = document.createElement("div");
    cell.className = "shade-cell";
    cell.style.backgroundColor = `rgb(${sc[0]}, ${sc[1]}, ${sc[2]})`;
    cell.dataset.label = step.label;
    cell.title = `명도 ${step.d > 0 ? '+' : ''}${Math.round(step.d * 100)}%  →  RGB(${sc[0]}, ${sc[1]}, ${sc[2]})`;
    cell.addEventListener("click", () => {
      state.activeColor = sc.slice();
      renderActiveColor();
      renderPalette();
      if ($("color-picker").classList.contains("show")) syncPickerFromActive();
    });
    strip.appendChild(cell);
  });
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

$("btn-flip-h").addEventListener("click", (e) => {
  if (state.frames.length === 0) {
    setStatus("프레임이 없습니다", "error");
    return;
  }
  snapshot();
  // Shift 클릭 = 모든 프레임 일괄
  const targets = e.shiftKey ? state.frames : [state.frames[state.frameIdx]];
  for (const f of targets) {
    if (!f) continue;
    f.source = flipHorizontal(f.source);
    f.original = flipHorizontal(f.original);
    if (f.traceLayer) f.traceLayer = flipHorizontal(f.traceLayer);
  }
  state.selection = null;
  state.draftSelection = null;
  invalidateSourceCache();
  refreshPalette();
  renderTimeline();
  redraw();
  setStatus(e.shiftKey ? `모든 프레임 좌우 반전 (${targets.length}장)` : "좌우 반전 완료", "success");
});

// ---------- 트레이싱 ----------
$("tracing-mode").addEventListener("change", () => {
  state.tracing = $("tracing-mode").checked;
  redraw();
});
$("guide-opacity").addEventListener("input", () => {
  state.guideOpacity = parseInt($("guide-opacity").value, 10) / 100;
  $("guide-opacity-val").textContent = $("guide-opacity").value + "%";
  redraw();
});
$("btn-clear-trace").addEventListener("click", () => {
  const f = state.frames[state.frameIdx];
  if (!f) {
    setStatus("프레임이 없습니다");
    return;
  }
  if (!f.traceLayer) {
    setStatus("트레이스가 비어있습니다");
    return;
  }
  snapshot();
  f.traceLayer = null;
  redraw();
  setStatus("트레이스 지움");
});

function resizeImageDataNearest(img, newW, newH) {
  if (!img) return null;
  if (img.width === newW && img.height === newH) return img;
  const tmp = imageDataToCanvas2(img);
  const c = document.createElement("canvas");
  c.width = newW;
  c.height = newH;
  const ctx = c.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(tmp, 0, 0, newW, newH);
  return ctx.getImageData(0, 0, newW, newH);
}

function compositeFrame(frame) {
  // source + traceLayer 합친 ImageData 반환
  if (!frame.source) return null;
  if (!frame.traceLayer) return frame.source;
  const c = document.createElement("canvas");
  c.width = frame.source.width;
  c.height = frame.source.height;
  const ctx = c.getContext("2d");
  ctx.drawImage(imageDataToCanvas2(frame.source), 0, 0);
  ctx.drawImage(imageDataToCanvas2(frame.traceLayer), 0, 0);
  return ctx.getImageData(0, 0, c.width, c.height);
}

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

function getCellVariation() {
  const r = document.querySelector('input[name="cell-variation"]:checked');
  return r ? r.value : "off";
}

const VARIATION_AMOUNT = { off: 0, low: 0.04, mid: 0.10, high: 0.20 };

function hashNoise(x, y) {
  // 결정론적 노이즈 -1 ~ 1. 같은 (x, y)는 항상 같은 값
  let h = (((x | 0) * 374761393) + ((y | 0) * 668265263)) | 0;
  h = (h ^ (h >>> 13)) >>> 0;
  h = (h * 1274126177) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return (h / 4294967295) * 2 - 1;
}

function applyCellVariation(baseColor, x, y, level) {
  if (level === "off") return baseColor;
  const amt = VARIATION_AMOUNT[level] || 0;
  if (amt === 0) return baseColor;
  const [h, s, v] = rgbToHsv(baseColor[0], baseColor[1], baseColor[2]);
  const newV = Math.max(0, Math.min(1, v + hashNoise(x, y) * amt));
  return hsvToRgb(h, s, newV);
}

function getEditTarget() {
  // 트레이싱 모드면 traceLayer (없으면 생성), 아니면 source
  const f = state.frames[state.frameIdx];
  if (!f) return null;
  if (state.tracing) {
    if (!f.traceLayer || f.traceLayer.width !== f.source.width || f.traceLayer.height !== f.source.height) {
      f.traceLayer = new ImageData(f.source.width, f.source.height);
    }
    return f.traceLayer;
  }
  return f.source;
}

function paintOne(ix, iy, tool, color) {
  const target = getEditTarget();
  if (!target) return;
  if (ix < 0 || iy < 0 || ix >= target.width || iy >= target.height) return;
  const idx = (iy * target.width + ix) * 4;
  const data = target.data;
  if (tool === "brush") {
    const c = color || state.activeColor;
    data[idx] = c[0];
    data[idx + 1] = c[1];
    data[idx + 2] = c[2];
    data[idx + 3] = 255;
  } else if (tool === "erase") {
    data[idx + 3] = 0;
  }
}

function paintPixel(ix, iy, tool) {
  _paintPixelOnce(ix, iy, tool);
  // 좌우 대칭 (수직 중앙축)
  if (document.getElementById("symmetry-h")?.checked) {
    const target = getEditTarget();
    if (target) {
      const mx = target.width - 1 - ix;
      if (mx !== ix && mx >= 0 && mx < target.width) {
        _paintPixelOnce(mx, iy, tool);
      }
    }
  }
  return true;
}

function _paintPixelOnce(ix, iy, tool) {
  const size = getBrushSize();
  if (size === "cell") {
    const target = getEditTarget();
    if (!target) return false;
    if (state.pixelized) {
      // 도트화 후: target 사이즈 = N*sub × M*sub. 큰 격자 1셀 = sub × sub 도트
      const sub = getSub();
      const bx = Math.floor(ix / sub) * sub;
      const by = Math.floor(iy / sub) * sub;
      const variation = (tool === "brush") ? getCellVariation() : "off";
      for (let dy = 0; dy < sub; dy++) {
        for (let dx = 0; dx < sub; dx++) {
          const px = bx + dx, py = by + dy;
          const c = (variation !== "off")
            ? applyCellVariation(state.activeColor, px, py, variation)
            : null;
          paintOne(px, py, tool, c);
        }
      }
    } else {
      // 도트화 전: target = 원본 크기. 큰 격자 1셀 = gridDims로 계산한 cellSize × cellSize 픽셀
      const n = getGridSize();
      const sub = getSub();
      const dims = gridDims(target.width, target.height, n * sub);
      const cs = dims.cellSize;
      const cellX = Math.floor(ix / cs);
      const cellY = Math.floor(iy / cs);
      const x0 = Math.floor(cellX * cs);
      const y0 = Math.floor(cellY * cs);
      const x1 = Math.min(target.width, Math.floor((cellX + 1) * cs));
      const y1 = Math.min(target.height, Math.floor((cellY + 1) * cs));
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          paintOne(x, y, tool);
        }
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

// 도구 라디오 — "select"는 rect/lasso 중 현재 sub-mode 사용
document.querySelectorAll('input[name="tool"]').forEach((r) => {
  r.addEventListener("change", () => {
    if (r.value === "select") {
      const sm = document.querySelector('input[name="select-mode"]:checked');
      setTool(sm ? sm.value : "rect");
    } else {
      setTool(r.value);
    }
  });
});

// select-mode 라디오 변경 → 무조건 선택 도구로 전환 (현재 도구 무관)
// 즉 브러시 사용 중이라도 사각형/올가미 클릭 시 즉시 그 도구로 전환됨
// 부모 "선택" 라디오는 setTool 안에서 자동 ON/OFF 동기화
document.querySelectorAll('input[name="select-mode"]').forEach((r) => {
  r.addEventListener("change", () => {
    setTool(r.value);
  });
});

window.addEventListener("resize", redraw);
state.palette = DEFAULT_PALETTE.map((c) => c.slice());
renderActiveColor();
renderPalette();
addInitialBlankFrame();
renderTimeline();
redraw();
setTool("none", { silent: true });

document.querySelectorAll(".res-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const factor = parseInt(btn.dataset.factor, 10);
    if (!factor || factor < 2) return;
    expandResolutionFactor(factor);
  });
});

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
  // summary 안에 있으면 클릭이 details 토글로 전파되지 않도록
  icon.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); });
});

// ---------- 좌/우 패널 토글 ----------
const btnToggleLeft = $("btn-toggle-left");
const btnToggleRight = $("btn-toggle-right");
const userToggled = { left: false, right: false };

btnToggleLeft?.addEventListener("click", () => {
  userToggled.left = true;
  const collapsed = document.body.classList.toggle("leftpanel-collapsed");
  btnToggleLeft.textContent = collapsed ? "▶" : "◀";
  setTimeout(redraw, 220);
});
btnToggleRight?.addEventListener("click", () => {
  userToggled.right = true;
  const collapsed = document.body.classList.toggle("rightpanel-collapsed");
  btnToggleRight.textContent = collapsed ? "◀" : "▶";
  setTimeout(redraw, 220);
});

function applyResponsive() {
  const w = window.innerWidth;
  if (!userToggled.left) {
    if (w < 1000) document.body.classList.add("leftpanel-collapsed");
    else document.body.classList.remove("leftpanel-collapsed");
    if (btnToggleLeft) btnToggleLeft.textContent = document.body.classList.contains("leftpanel-collapsed") ? "▶" : "◀";
  }
  if (!userToggled.right) {
    if (w < 1280) document.body.classList.add("rightpanel-collapsed");
    else document.body.classList.remove("rightpanel-collapsed");
    if (btnToggleRight) btnToggleRight.textContent = document.body.classList.contains("rightpanel-collapsed") ? "◀" : "▶";
  }
}
applyResponsive();
let _respTimer = null;
window.addEventListener("resize", () => {
  if (_respTimer) clearTimeout(_respTimer);
  _respTimer = setTimeout(applyResponsive, 100);
});

// ---------- 드래그 앤 드롭 ----------
(function setupDragDrop() {
  const stage = $("stage");
  let dragCount = 0;
  stage.addEventListener("dragenter", (e) => {
    if (!e.dataTransfer || !e.dataTransfer.types.includes("Files")) return;
    dragCount++;
    stage.classList.add("dragover");
    e.preventDefault();
  });
  stage.addEventListener("dragleave", (e) => {
    dragCount--;
    if (dragCount <= 0) {
      dragCount = 0;
      stage.classList.remove("dragover");
    }
  });
  stage.addEventListener("dragover", (e) => {
    if (!e.dataTransfer || !e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  });
  stage.addEventListener("drop", async (e) => {
    e.preventDefault();
    dragCount = 0;
    stage.classList.remove("dragover");
    if (!e.dataTransfer) return;
    const files = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith("image/"));
    if (files.length === 0) {
      setStatus("이미지 파일이 아닙니다", "error");
      return;
    }
    setStatus(`${files.length}개 이미지 추가 중...`, "processing");
    if (state.frames.length === 1 && isFrameUntitledBlank(state.frames[0])) {
      state.frames = [];
      state.frameIdx = 0;
      clearHistory();
    }
    for (const f of files) {
      await loadImageFromFile(f);
    }
    setStatus(`${files.length}개 프레임 추가됨`, "success");
  });
})();

// ---------- 단축키: 도구 전환 / F1 안내 / Ctrl+S 저장 / ESC 모달 닫기 ----------
// TOOL_KEYS / TOOL_LABEL 은 위에서 정의됨

window.addEventListener("keydown", (e) => {
  // INPUT/TEXTAREA에 포커스 있으면 단축키 무시
  const t = e.target;
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;

  // ESC: 모달 닫기 / floating 취소 / 선택 해제
  if (e.key === "Escape") {
    if ($("modal-overlay").classList.contains("show")) {
      e.preventDefault();
      hideModal();
      return;
    }
    if (_floating) {
      e.preventDefault();
      cancelFloating();
      return;
    }
    if (state.selection || state.draftSelection) {
      state.selection = null;
      state.draftSelection = null;
      redraw();
    }
    return;
  }

  // F1 또는 Shift+? : 단축키 안내
  if (e.key === "F1" || (e.key === "?" && e.shiftKey)) {
    e.preventDefault();
    showShortcutsModal();
    return;
  }

  // Ctrl+S: 저장 메뉴
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
    e.preventDefault();
    $("btn-save-menu").click();
    return;
  }

  // Ctrl+C / Ctrl+V / Ctrl+X / Ctrl+D
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey) {
    const k = e.key.toLowerCase();
    if (k === "c") { e.preventDefault(); copySelection(false); return; }
    if (k === "v") { e.preventDefault(); pasteClipboard(); return; }
    if (k === "x") { e.preventDefault(); copySelection(true); return; }
    if (k === "d") { e.preventDefault(); duplicateCurrentFrame(); return; }
  }

  // 프레임 이동 ← / →
  if (!e.ctrlKey && !e.metaKey && !e.altKey) {
    if (e.key === "ArrowLeft" && state.frames.length > 1) {
      e.preventDefault();
      selectFrame((state.frameIdx - 1 + state.frames.length) % state.frames.length);
      return;
    }
    if (e.key === "ArrowRight" && state.frames.length > 1) {
      e.preventDefault();
      selectFrame((state.frameIdx + 1) % state.frames.length);
      return;
    }
  }

  // Delete / Backspace = 선택 영역 비우기
  if ((e.key === "Delete" || e.key === "Backspace") && state.selection) {
    e.preventDefault();
    clearSelectionContent();
    return;
  }

  // Ctrl+Shift+I = 선택 반전
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "i") {
    e.preventDefault();
    invertSelection();
    return;
  }

  // R: floating paste 회전
  if (_floating && !e.ctrlKey && !e.metaKey && !e.altKey) {
    if (e.key === "r" || e.key === "R") {
      e.preventDefault();
      if (e.shiftKey) {
        // 임의 각도 입력
        const cur = Math.round(_floating.rotation || 0);
        const inp = prompt("회전 각도 (0~359°)", String(cur));
        if (inp !== null) {
          const v = parseFloat(inp);
          if (!isNaN(v)) rotateFloating(v, true);
        }
      } else {
        rotateFloating(90);
      }
      return;
    }
  }

  // 도구 전환 (modifier 없을 때만)
  if (!e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
    const key = e.key.toLowerCase();
    if (TOOL_KEYS[key]) {
      e.preventDefault();
      setTool(TOOL_KEYS[key]);
    }
  }
});

$("btn-shortcuts")?.addEventListener("click", () => showShortcutsModal());

// ===== 스타일 변환 (수채화/유화/연필/잉크/소프트) =====

// Sobel edge magnitude
function computeEdges(imgData) {
  const W = imgData.width, H = imgData.height;
  const data = imgData.data;
  const gray = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) {
    gray[i] = 0.299 * data[i*4] + 0.587 * data[i*4+1] + 0.114 * data[i*4+2];
  }
  const edges = new Float32Array(W * H);
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      const gx = -gray[i-W-1] + gray[i-W+1]
               - 2*gray[i-1] + 2*gray[i+1]
               - gray[i+W-1] + gray[i+W+1];
      const gy = -gray[i-W-1] - 2*gray[i-W] - gray[i-W+1]
               + gray[i+W-1] + 2*gray[i+W] + gray[i+W+1];
      edges[i] = Math.sqrt(gx*gx + gy*gy);
    }
  }
  return edges;
}

// 종이 결 (저주파 + 고주파 노이즈 혼합)
function generatePaperTexture(W, H, coarseSize = 32) {
  const tex = new Float32Array(W * H);
  const cw = Math.ceil(W / coarseSize) + 2;
  const ch = Math.ceil(H / coarseSize) + 2;
  const coarse = new Float32Array(cw * ch);
  for (let i = 0; i < coarse.length; i++) coarse[i] = Math.random();
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const fx = x / coarseSize, fy = y / coarseSize;
      const x0 = Math.floor(fx), y0 = Math.floor(fy);
      const tx = fx - x0, ty = fy - y0;
      const v00 = coarse[y0 * cw + x0];
      const v10 = coarse[y0 * cw + x0 + 1];
      const v01 = coarse[(y0+1) * cw + x0];
      const v11 = coarse[(y0+1) * cw + x0 + 1];
      const cv = v00*(1-tx)*(1-ty) + v10*tx*(1-ty) + v01*(1-tx)*ty + v11*tx*ty;
      tex[y*W + x] = cv * 0.6 + Math.random() * 0.4;
    }
  }
  return tex;
}

function upscaleBilinear(src, scale) {
  const W = src.width, H = src.height;
  const newW = Math.round(W * scale), newH = Math.round(H * scale);
  const sc = document.createElement("canvas");
  sc.width = W; sc.height = H;
  sc.getContext("2d").putImageData(src, 0, 0);
  const out = document.createElement("canvas");
  out.width = newW; out.height = newH;
  const oc = out.getContext("2d");
  oc.imageSmoothingEnabled = true;
  oc.imageSmoothingQuality = "high";
  oc.drawImage(sc, 0, 0, newW, newH);
  return out;
}

// === 수채화 (정통) — edge bleed + 종이 결 + 톤 압축 + 색 번짐
function renderWatercolor(src, opts) {
  const scale = opts.scale || 8;
  const blur = opts.blur || 2;
  const edge = opts.edge || 1.5;
  const paper = opts.paper || 0.4;
  const up = upscaleBilinear(src, scale);
  const newW = up.width, newH = up.height;

  // 부드러운 베이스 + 색 번짐 (saturate 살짝)
  const base = document.createElement("canvas");
  base.width = newW; base.height = newH;
  const bc = base.getContext("2d");
  bc.filter = blur > 0 ? `blur(${blur}px) saturate(115%)` : "saturate(115%)";
  bc.drawImage(up, 0, 0);
  bc.filter = "none";
  // 색 번짐 추가 합성
  bc.globalAlpha = 0.35;
  bc.filter = `blur(${blur * 2 + 1}px) saturate(130%)`;
  bc.drawImage(up, 0, 0);
  bc.filter = "none"; bc.globalAlpha = 1;

  const result = bc.getImageData(0, 0, newW, newH);
  const data = result.data;

  // edge bleed — Sobel 엣지에 곱셈 곱셈 곱셈으로 어둡게
  if (edge > 0) {
    const edges = computeEdges(result);
    for (let i = 0; i < newW * newH; i++) {
      if (data[i*4+3] === 0) continue;
      const e = Math.min(1, edges[i] / 100);
      if (e > 0.08) {
        const k = 1 - e * edge * 0.18;
        data[i*4]   = data[i*4] * k;
        data[i*4+1] = data[i*4+1] * k;
        data[i*4+2] = data[i*4+2] * k;
      }
    }
  }

  // 종이 결
  if (paper > 0) {
    const tex = generatePaperTexture(newW, newH, 28);
    for (let i = 0; i < newW * newH; i++) {
      if (data[i*4+3] === 0) continue;
      const t = (tex[i] - 0.5) * paper * 0.5;
      const k = 1 + t;
      data[i*4]   = Math.max(0, Math.min(255, data[i*4] * k));
      data[i*4+1] = Math.max(0, Math.min(255, data[i*4+1] * k));
      data[i*4+2] = Math.max(0, Math.min(255, data[i*4+2] * k));
    }
  }

  // 톤 압축 (수채화는 순흑·순백 안 씀)
  for (let i = 0; i < data.length; i += 4) {
    if (data[i+3] === 0) continue;
    data[i]   = 14 + (data[i] / 255) * 226;
    data[i+1] = 14 + (data[i+1] / 255) * 226;
    data[i+2] = 14 + (data[i+2] / 255) * 226;
  }
  return result;
}

// === 유화 — 큰 붓터치 + 진한 색
function renderOil(src, opts) {
  const scale = opts.scale || 8;
  const blur = opts.blur || 1.5;
  const sat = opts.sat || 1.3;
  const brush = Math.max(2, Math.round(opts.brush || 5));
  const up = upscaleBilinear(src, scale);
  const newW = up.width, newH = up.height;

  const out = document.createElement("canvas");
  out.width = newW; out.height = newH;
  const oc = out.getContext("2d");
  oc.filter = `blur(${blur}px) saturate(${sat * 100}%)`;
  oc.drawImage(up, 0, 0);
  oc.filter = "none";

  const result = oc.getImageData(0, 0, newW, newH);
  const data = result.data;

  // 붓터치 — brush×brush 셀마다 한 방향 노이즈 + 인접 평균
  for (let y = 0; y < newH; y += brush) {
    for (let x = 0; x < newW; x += brush) {
      const offset = (Math.random() - 0.5) * 28;
      for (let dy = 0; dy < brush && y+dy < newH; dy++) {
        for (let dx = 0; dx < brush && x+dx < newW; dx++) {
          const i = ((y+dy) * newW + (x+dx)) * 4;
          if (data[i+3] === 0) continue;
          data[i]   = Math.max(0, Math.min(255, data[i] + offset));
          data[i+1] = Math.max(0, Math.min(255, data[i+1] + offset));
          data[i+2] = Math.max(0, Math.min(255, data[i+2] + offset));
        }
      }
    }
  }
  return result;
}

// === 연필 스케치
function renderPencil(src, opts) {
  const scale = opts.scale || 8;
  const edge = opts.edge || 2;
  const paper = opts.paper || 0.5;
  const contrast = opts.contrast || 1.2;
  const up = upscaleBilinear(src, scale);
  const newW = up.width, newH = up.height;

  const gc = document.createElement("canvas");
  gc.width = newW; gc.height = newH;
  const gctx = gc.getContext("2d");
  gctx.filter = `grayscale(100%) contrast(${contrast * 100}%)`;
  gctx.drawImage(up, 0, 0);
  gctx.filter = "none";

  const result = gctx.getImageData(0, 0, newW, newH);
  const data = result.data;
  const edges = computeEdges(result);
  const paperColor = 245;

  for (let i = 0; i < newW * newH; i++) {
    if (data[i*4+3] === 0) {
      data[i*4]   = paperColor;
      data[i*4+1] = paperColor - 5;
      data[i*4+2] = paperColor - 12;
      data[i*4+3] = 255;
      continue;
    }
    const gray = data[i*4];
    const e = Math.min(1, edges[i] / 70);
    const shading = Math.min(1, (1 - gray/255) * 0.65 + e * 0.5 * edge);
    const final = Math.round(paperColor - shading * paperColor);
    data[i*4]   = final;
    data[i*4+1] = final;
    data[i*4+2] = final;
    data[i*4+3] = 255;
  }

  if (paper > 0) {
    const tex = generatePaperTexture(newW, newH, 24);
    for (let i = 0; i < newW * newH; i++) {
      const t = (tex[i] - 0.5) * paper * 50;
      data[i*4]   = Math.max(0, Math.min(255, data[i*4] + t));
      data[i*4+1] = Math.max(0, Math.min(255, data[i*4+1] + t));
      data[i*4+2] = Math.max(0, Math.min(255, data[i*4+2] + t));
    }
  }
  return result;
}

// === 잉크 — 깔끔한 색 채움 + 검은 라인
function renderInk(src, opts) {
  const scale = opts.scale || 8;
  const blur = opts.blur || 1;
  const edge = opts.edge || 1.8;
  const threshold = opts.threshold || 35;
  const up = upscaleBilinear(src, scale);
  const newW = up.width, newH = up.height;

  const out = document.createElement("canvas");
  out.width = newW; out.height = newH;
  const oc = out.getContext("2d");
  oc.filter = `blur(${blur}px) saturate(115%)`;
  oc.drawImage(up, 0, 0);
  oc.filter = "none";

  const result = oc.getImageData(0, 0, newW, newH);
  const data = result.data;
  const edges = computeEdges(result);

  for (let i = 0; i < newW * newH; i++) {
    if (data[i*4+3] === 0) continue;
    if (edges[i] > threshold) {
      const ink = Math.min(1, (edges[i] - threshold) / 80) * edge;
      const k = Math.max(0, 1 - ink);
      data[i*4]   = Math.round(data[i*4] * k);
      data[i*4+1] = Math.round(data[i*4+1] * k);
      data[i*4+2] = Math.round(data[i*4+2] * k);
    }
  }
  return result;
}

// === 소프트 (기존)
function renderSoft(src, opts) {
  const scale = opts.scale || 8;
  const blur = opts.blur || 3;
  const noise = opts.noise || 10;
  const bleed = opts.bleed || 2;
  const up = upscaleBilinear(src, scale);
  const newW = up.width, newH = up.height;

  const out = document.createElement("canvas");
  out.width = newW; out.height = newH;
  const oc = out.getContext("2d");
  oc.filter = blur > 0 ? `blur(${blur}px)` : "none";
  oc.drawImage(up, 0, 0);
  oc.filter = "none";
  if (bleed > 0) {
    oc.save();
    oc.filter = `blur(${bleed * 1.5}px) saturate(120%)`;
    oc.globalAlpha = 0.45;
    oc.drawImage(up, 0, 0);
    oc.filter = "none"; oc.globalAlpha = 1;
    oc.restore();
  }
  const result = oc.getImageData(0, 0, newW, newH);
  const data = result.data;
  if (noise > 0) {
    for (let i = 0; i < data.length; i += 4) {
      if (data[i+3] === 0) continue;
      const n = (Math.random() - 0.5) * noise * 2;
      data[i]   = Math.max(0, Math.min(255, data[i] + n));
      data[i+1] = Math.max(0, Math.min(255, data[i+1] + n));
      data[i+2] = Math.max(0, Math.min(255, data[i+2] + n));
    }
  }
  return result;
}

// 스타일 프리셋 정의
const STYLE_PRESETS = {
  watercolor: {
    label: "🎨 수채화 (정통)",
    desc: "엣지 진해짐 + 종이 결 + 톤 압축 + 색 번짐",
    sliders: [
      { id: "scale", label: "사이즈", min: 2, max: 16, step: 1, def: 8, fmt: v => `×${v}` },
      { id: "blur",  label: "물감 번짐", min: 0, max: 6, step: 0.5, def: 2 },
      { id: "edge",  label: "가장자리 진해짐", min: 0, max: 3, step: 0.1, def: 1.5 },
      { id: "paper", label: "종이 결", min: 0, max: 1, step: 0.05, def: 0.4 },
    ],
    render: renderWatercolor,
  },
  oil: {
    label: "🖌 유화",
    desc: "큰 붓터치 + 진한 채도",
    sliders: [
      { id: "scale", label: "사이즈", min: 2, max: 16, step: 1, def: 8, fmt: v => `×${v}` },
      { id: "blur",  label: "부드러움", min: 0, max: 4, step: 0.5, def: 1.5 },
      { id: "sat",   label: "채도", min: 1, max: 2, step: 0.05, def: 1.3 },
      { id: "brush", label: "붓 크기 (px)", min: 2, max: 12, step: 1, def: 5 },
    ],
    render: renderOil,
  },
  pencil: {
    label: "✏ 연필 스케치",
    desc: "회색조 + 엣지 강조 + 종이 결",
    sliders: [
      { id: "scale",    label: "사이즈", min: 2, max: 16, step: 1, def: 8, fmt: v => `×${v}` },
      { id: "edge",     label: "엣지 강조", min: 0, max: 4, step: 0.1, def: 2 },
      { id: "contrast", label: "대비", min: 0.8, max: 2, step: 0.05, def: 1.2 },
      { id: "paper",    label: "종이 결", min: 0, max: 1.5, step: 0.05, def: 0.5 },
    ],
    render: renderPencil,
  },
  ink: {
    label: "🖋 잉크",
    desc: "깔끔 색 채움 + 검은 라인",
    sliders: [
      { id: "scale",     label: "사이즈", min: 2, max: 16, step: 1, def: 8, fmt: v => `×${v}` },
      { id: "blur",      label: "색 부드러움", min: 0, max: 3, step: 0.25, def: 1 },
      { id: "edge",      label: "라인 진하기", min: 0, max: 3, step: 0.1, def: 1.8 },
      { id: "threshold", label: "라인 임계치", min: 10, max: 80, step: 5, def: 35 },
    ],
    render: renderInk,
  },
  soft: {
    label: "💨 소프트 블러",
    desc: "단순 흐림 + 노이즈",
    sliders: [
      { id: "scale", label: "사이즈", min: 2, max: 16, step: 1, def: 8, fmt: v => `×${v}` },
      { id: "blur",  label: "부드러움", min: 0, max: 10, step: 0.5, def: 3 },
      { id: "bleed", label: "색 번짐", min: 0, max: 8, step: 0.5, def: 2 },
      { id: "noise", label: "노이즈", min: 0, max: 40, step: 1, def: 10 },
    ],
    render: renderSoft,
  },
};

$("btn-watercolor")?.addEventListener("click", () => {
  const f = state.frames[state.frameIdx];
  if (!f || !f.source) { setStatus("프레임이 없습니다", "error"); return; }
  const W = f.source.width, H = f.source.height;

  let curStyle = "watercolor";
  let lastFullOpts = null;
  let renderTimer = null;

  const styleOpts = Object.entries(STYLE_PRESETS).map(([k, p]) => `<option value="${k}"${k===curStyle?' selected':''}>${p.label}</option>`).join("");

  showModal("🎨 스타일 변환", `
    <div class="modal-row" style="margin-bottom:12px;">
      <label>스타일 <select id="sty-select" style="min-width:200px;">${styleOpts}</select></label>
      <span id="sty-desc" class="modal-info" style="margin:0;"></span>
    </div>
    <div style="display:flex; gap:14px; margin-bottom:12px;">
      <div style="flex:1;">
        <div style="font-size:11px; color:#888; margin-bottom:4px;">원본 (도트)</div>
        <div style="background:#1a1a1a; border:1px solid #333; padding:6px; display:flex; justify-content:center; align-items:center; min-height:240px; border-radius:4px;">
          <canvas id="sty-source-preview" style="image-rendering:pixelated; image-rendering:crisp-edges; max-width:100%; max-height:240px; background:transparent;"></canvas>
        </div>
      </div>
      <div style="flex:1;">
        <div style="font-size:11px; color:#888; margin-bottom:4px;">변환 결과 <span id="sty-result-info" style="color:#666;"></span></div>
        <div style="background:#1a1a1a; border:1px solid #333; padding:6px; display:flex; justify-content:center; align-items:center; min-height:240px; border-radius:4px;">
          <canvas id="sty-result-preview" style="max-width:100%; max-height:240px; background:transparent;"></canvas>
        </div>
      </div>
    </div>
    <div id="sty-sliders" style="display:grid; grid-template-columns: auto 1fr 50px; gap:6px 10px; align-items:center; margin-bottom:10px;"></div>
    <div class="modal-info" style="font-size:11px;">슬라이더 조절 시 우측 미리보기 자동 갱신 (가벼운 사이즈). [PNG 저장]은 슬라이더 사이즈로 풀 렌더, [적용]은 source 교체 (Ctrl+Z).</div>
    <div class="modal-row" style="justify-content:flex-end;">
      <button id="sty-apply">현재 프레임에 적용</button>
      <button id="sty-save" class="primary">PNG 저장</button>
    </div>
  `);

  const srcPv = $("sty-source-preview");
  const srcDisp = Math.min(240, Math.max(W, H) * 4);
  const ratio = srcDisp / Math.max(W, H);
  srcPv.width = Math.round(W * ratio);
  srcPv.height = Math.round(H * ratio);
  const sctx = srcPv.getContext("2d");
  sctx.imageSmoothingEnabled = false;
  sctx.drawImage(imageDataToCanvas2(f.source), 0, 0, srcPv.width, srcPv.height);

  function rebuildSliders() {
    const preset = STYLE_PRESETS[curStyle];
    $("sty-desc").textContent = preset.desc;
    const cont = $("sty-sliders");
    cont.innerHTML = "";
    preset.sliders.forEach(s => {
      const label = document.createElement("label");
      label.style.fontSize = "12px";
      label.textContent = s.label;
      const input = document.createElement("input");
      input.type = "range";
      input.id = `sty-${s.id}`;
      input.min = s.min; input.max = s.max; input.step = s.step;
      input.value = s.def;
      input.style.width = "100%";
      const val = document.createElement("span");
      val.id = `sty-${s.id}-val`;
      val.style.cssText = "font-family:Consolas,monospace; font-size:11px; color:#4a8; text-align:right;";
      val.textContent = s.fmt ? s.fmt(s.def) : String(s.def);
      cont.appendChild(label);
      cont.appendChild(input);
      cont.appendChild(val);
      input.addEventListener("input", () => {
        val.textContent = s.fmt ? s.fmt(parseFloat(input.value)) : input.value;
        debounceUpdate();
      });
    });
  }

  function gatherOpts() {
    const preset = STYLE_PRESETS[curStyle];
    const opts = {};
    preset.sliders.forEach(s => {
      const inp = $(`sty-${s.id}`);
      opts[s.id] = parseFloat(inp.value);
    });
    return opts;
  }

  function updateResult() {
    const preset = STYLE_PRESETS[curStyle];
    const opts = gatherOpts();
    // 미리보기는 가벼운 사이즈 (max 256)
    const pvScale = Math.max(2, Math.min(opts.scale, Math.floor(256 / Math.max(W, H))));
    const pvOpts = { ...opts, scale: pvScale };
    const result = preset.render(f.source, pvOpts);
    lastFullOpts = opts;
    const rc = $("sty-result-preview");
    rc.width = result.width; rc.height = result.height;
    rc.getContext("2d").putImageData(result, 0, 0);
    $("sty-result-info").textContent = `미리보기 ${result.width}×${result.height} / 저장 시 ${W*opts.scale}×${H*opts.scale}`;
  }

  function debounceUpdate() {
    if (renderTimer) clearTimeout(renderTimer);
    renderTimer = setTimeout(updateResult, 100);
  }

  $("sty-select").addEventListener("change", (e) => {
    curStyle = e.target.value;
    rebuildSliders();
    updateResult();
  });

  $("sty-save").addEventListener("click", () => {
    if (!lastFullOpts) return;
    const preset = STYLE_PRESETS[curStyle];
    const o = lastFullOpts;
    setStatus(`렌더링 중... (${W*o.scale}×${H*o.scale})`, "processing");
    setTimeout(() => {
      const full = preset.render(f.source, o);
      const c = freshCanvas(full);
      c.toBlob((blob) => {
        const ts = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
        const base = stripExt(f.fileName) || "frame";
        downloadBlob(blob, `${base}_${curStyle}_${full.width}x${full.height}_${ts}.png`);
        setStatus(`저장 완료: ${full.width}×${full.height}`, "success");
      });
    }, 30);
  });

  $("sty-apply").addEventListener("click", () => {
    if (!lastFullOpts) return;
    if (!confirm(`현재 프레임의 source를 ${STYLE_PRESETS[curStyle].label} 결과로 교체합니다 (Ctrl+Z로 되돌리기). 진행?`)) return;
    snapshot();
    const preset = STYLE_PRESETS[curStyle];
    const full = preset.render(f.source, lastFullOpts);
    f.source = full;
    f.pixelized = false;
    invalidateSourceCache();
    refreshPalette();
    renderTimeline();
    redraw();
    hideModal();
    setStatus(`${preset.label} 적용`, "success");
  });

  rebuildSliders();
  updateResult();
});

// ===== 재생 미리보기 모달 =====
$("btn-preview")?.addEventListener("click", () => {
  if (state.frames.length < 1) { setStatus("프레임이 없습니다", "error"); return; }
  let timer = null;
  let idx = 0;
  let dir = 1;
  const sizes = [1, 2, 4, 8];
  showModal("재생 미리보기", `
    <div style="display:flex; gap:8px; align-items:center; margin-bottom:12px;">
      <label>FPS <input type="number" id="pv-fps" value="${$('tl-fps').value}" min="1" max="60" style="width:48px;"></label>
      <label>모드
        <select id="pv-mode">
          <option value="loop" ${getPlayMode()==='loop'?'selected':''}>루프</option>
          <option value="once" ${getPlayMode()==='once'?'selected':''}>원샷</option>
          <option value="pingpong" ${getPlayMode()==='pingpong'?'selected':''}>핑퐁</option>
        </select>
      </label>
      <button id="pv-play" class="primary">▶ 재생</button>
      <button id="pv-stop" disabled>⏸ 정지</button>
      <span id="pv-info" class="modal-info" style="margin-left:auto;">프레임 1/${state.frames.length}</span>
    </div>
    <div id="pv-stage" style="background:#111; border:1px solid #333; border-radius:6px; padding:14px; display:flex; gap:14px; justify-content:center; align-items:center; min-height:240px; flex-wrap:wrap;">
      ${sizes.map(s => `<div style="text-align:center;">
        <canvas class="pv-canvas" data-scale="${s}" style="image-rendering:pixelated; background:transparent; border:1px solid #333;"></canvas>
        <div style="font-size:11px; color:#888; margin-top:4px;">×${s}</div>
      </div>`).join('')}
    </div>
    <div class="modal-info" style="margin-top:8px;">실제 표시: 픽셀 NEAREST 보간 / 4단계 동시 재생</div>
  `, () => { if (timer) clearInterval(timer); });

  function drawAt(i) {
    const f = state.frames[i];
    if (!f || !f.source) return;
    const src = compositeFrame(f) || f.source;
    document.querySelectorAll(".pv-canvas").forEach(c => {
      const sc = parseInt(c.dataset.scale, 10);
      c.width = src.width * sc;
      c.height = src.height * sc;
      const ctx = c.getContext("2d");
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(imageDataToCanvas2(src), 0, 0, c.width, c.height);
    });
    $("pv-info").textContent = `프레임 ${i + 1}/${state.frames.length}`;
  }

  function step() {
    const N = state.frames.length;
    const mode = $("pv-mode").value;
    if (mode === "pingpong") {
      let next = idx + dir;
      if (next >= N) { dir = -1; next = idx - 1; }
      else if (next < 0) { dir = 1; next = idx + 1; }
      idx = Math.max(0, Math.min(N - 1, next));
    } else if (mode === "once") {
      if (idx + 1 >= N) { stop(); return; }
      idx++;
    } else {
      idx = (idx + 1) % N;
    }
    drawAt(idx);
  }
  function start() {
    if (timer) clearInterval(timer);
    const fps = Math.max(1, parseInt($("pv-fps").value, 10) || 12);
    dir = 1;
    timer = setInterval(step, 1000 / fps);
    $("pv-play").disabled = true;
    $("pv-stop").disabled = false;
  }
  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
    $("pv-play").disabled = false;
    $("pv-stop").disabled = true;
  }
  $("pv-play").addEventListener("click", start);
  $("pv-stop").addEventListener("click", stop);
  $("pv-fps").addEventListener("input", () => { if (timer) start(); });
  drawAt(idx);
});

// ---------- 복사 / 붙여넣기 / 잘라내기 ----------

function copySelection(cut = false) {
  if (!state.selection || !state.source) {
    setStatus("선택 영역이 없습니다", "error");
    return;
  }
  const W = state.source.width, H = state.source.height;
  const target = state.tracing ? state.frames[state.frameIdx]?.traceLayer : state.source;
  const src = target || state.source;
  const mask = buildSelectionMask(state.selection, W, H, "touch");
  // bounding box
  let xMin = Infinity, yMin = Infinity, xMax = -1, yMax = -1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (mask[y * W + x]) {
        if (x < xMin) xMin = x;
        if (x > xMax) xMax = x;
        if (y < yMin) yMin = y;
        if (y > yMax) yMax = y;
      }
    }
  }
  if (xMax < 0) {
    setStatus("선택 영역이 비어있습니다", "error");
    return;
  }
  const w = xMax - xMin + 1;
  const h = yMax - yMin + 1;
  const out = new ImageData(w, h);
  const sd = src.data;
  const od = out.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx = xMin + x;
      const sy = yMin + y;
      if (!mask[sy * W + sx]) continue;
      const si = (sy * W + sx) * 4;
      const di = (y * w + x) * 4;
      od[di] = sd[si];
      od[di + 1] = sd[si + 1];
      od[di + 2] = sd[si + 2];
      od[di + 3] = sd[si + 3];
    }
  }
  _clipboard = { imageData: out, x: xMin, y: yMin };

  if (cut) {
    snapshot();
    const f = state.frames[state.frameIdx];
    if (state.tracing && f && f.traceLayer) {
      const newImg = new ImageData(f.traceLayer.width, f.traceLayer.height);
      newImg.data.set(f.traceLayer.data);
      for (let i = 0; i < W * H; i++) {
        if (mask[i]) newImg.data[i * 4 + 3] = 0;
      }
      f.traceLayer = newImg;
    } else if (f) {
      const newImg = new ImageData(f.source.width, f.source.height);
      newImg.data.set(f.source.data);
      for (let i = 0; i < W * H; i++) {
        if (mask[i]) newImg.data[i * 4 + 3] = 0;
      }
      f.source = newImg;
    }
    invalidateSourceCache();
    refreshPalette();
    renderTimeline();
    redraw();
    setStatus(`잘라내기 ${w}×${h}`, "success");
  } else {
    setStatus(`복사 ${w}×${h}`, "success");
  }
}

// NEAREST 회전 — 출력 픽셀마다 역회전해서 가장 가까운 소스 픽셀 색을 그대로
function rotateImageNearest(img, angleDeg) {
  if (!img) return null;
  const a = ((angleDeg % 360) + 360) % 360;
  if (a === 0) return img;
  const rad = a * Math.PI / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  const W = img.width, H = img.height;
  const cx = W / 2, cy = H / 2;
  // 새 bbox
  const corners = [[-cx,-cy],[cx,-cy],[-cx,cy],[cx,cy]];
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [x, y] of corners) {
    const nx = x * cos - y * sin;
    const ny = x * sin + y * cos;
    if (nx < minX) minX = nx; if (nx > maxX) maxX = nx;
    if (ny < minY) minY = ny; if (ny > maxY) maxY = ny;
  }
  const newW = Math.ceil(maxX - minX);
  const newH = Math.ceil(maxY - minY);
  const ncx = newW / 2, ncy = newH / 2;
  const out = new ImageData(newW, newH);
  const od = out.data, sd = img.data;
  for (let y = 0; y < newH; y++) {
    for (let x = 0; x < newW; x++) {
      const dx = x - ncx, dy = y - ncy;
      // 역회전 → 소스 좌표
      const sx = dx * cos + dy * sin + cx;
      const sy = -dx * sin + dy * cos + cy;
      const ix = Math.floor(sx), iy = Math.floor(sy);
      if (ix >= 0 && ix < W && iy >= 0 && iy < H) {
        const si = (iy * W + ix) * 4;
        const di = (y * newW + x) * 4;
        od[di] = sd[si];
        od[di+1] = sd[si+1];
        od[di+2] = sd[si+2];
        od[di+3] = sd[si+3];
      }
    }
  }
  return out;
}

function pasteClipboard() {
  if (!_clipboard) {
    setStatus("클립보드가 비어있습니다", "error");
    return;
  }
  // floating 모드 시작 — 마우스 따라 이동, 클릭으로 확정
  _floating = {
    imageData: _clipboard.imageData,  // 원본 (회전의 시드)
    rotated: _clipboard.imageData,    // 현재 표시되는 회전된 버전
    rotation: 0,
    slotIdx: state.activeSlot,
    x: _clipboard.x,
    y: _clipboard.y,
  };
  document.body.classList.add("floating-paste");
  redraw();
  setStatus("이동: 마우스 / 회전: R(90°) / Shift+R(임의각) / 확정: 클릭 / 취소: ESC");
}

function rotateFloating(deltaDeg, absolute = false) {
  if (!_floating) return;
  const newRot = absolute ? deltaDeg : (_floating.rotation + deltaDeg);
  _floating.rotation = ((newRot % 360) + 360) % 360;
  _floating.rotated = rotateImageNearest(_floating.imageData, _floating.rotation);
  // 회전 후 크기 변경 시 마우스 위치 중심 유지
  redraw();
}

function commitFloating() {
  if (!_floating) return;
  const fp = _floating;
  const slot = state.slots[fp.slotIdx];
  if (!slot) { cancelFloating(); return; }
  const f = state.frames[slot.frameIdx];
  if (!f || !f.source) { cancelFloating(); return; }
  snapshot();
  let target;
  if (state.tracing) {
    if (!f.traceLayer || f.traceLayer.width !== f.source.width || f.traceLayer.height !== f.source.height) {
      f.traceLayer = new ImageData(f.source.width, f.source.height);
    }
    const newImg = new ImageData(f.traceLayer.width, f.traceLayer.height);
    newImg.data.set(f.traceLayer.data);
    f.traceLayer = newImg;
    target = newImg;
  } else {
    const newImg = new ImageData(f.source.width, f.source.height);
    newImg.data.set(f.source.data);
    f.source = newImg;
    target = newImg;
  }
  const clip = fp.rotated || fp.imageData;
  let pasted = 0;
  for (let y = 0; y < clip.height; y++) {
    for (let x = 0; x < clip.width; x++) {
      const sx = fp.x + x;
      const sy = fp.y + y;
      if (sx < 0 || sx >= target.width || sy < 0 || sy >= target.height) continue;
      const ci = (y * clip.width + x) * 4;
      if (clip.data[ci + 3] === 0) continue;
      const ti = (sy * target.width + sx) * 4;
      target.data[ti] = clip.data[ci];
      target.data[ti + 1] = clip.data[ci + 1];
      target.data[ti + 2] = clip.data[ci + 2];
      target.data[ti + 3] = clip.data[ci + 3];
      pasted++;
    }
  }
  _floating = null;
  document.body.classList.remove("floating-paste");
  invalidateSourceCache();
  refreshPalette();
  renderTimeline();
  redraw();
  setStatus(`붙여넣기 ${pasted}px`, "success");
}

function cancelFloating() {
  if (!_floating) return;
  _floating = null;
  document.body.classList.remove("floating-paste");
  redraw();
  setStatus("취소됨");
}

// ---------- 참조 캔버스 (슬롯 1) ----------
const refCanvas = $("ref-canvas");
const refCtx = refCanvas.getContext("2d");
refCanvas.addEventListener("mousedown", (e) => onCanvasMouseDown(e, 1));
refCanvas.addEventListener("contextmenu", (e) => e.preventDefault());

// 마우스 hover로 활성 슬롯 자동 전환 (드래그 중에는 변경 안 함)
canvas.addEventListener("mouseenter", () => {
  if (!isPanning && !pixelDragging && !dragging) setActiveSlot(0);
});
refCanvas.addEventListener("mouseenter", () => {
  if (state.slots[1].frameIdx < 0) return;
  if (!isPanning && !pixelDragging && !dragging) setActiveSlot(1);
});

function renderRefFrameOptions() {
  const select = $("ref-frame-header");
  if (!select) return;
  const prev = select.value;
  select.innerHTML = '<option value="-1">비어있음</option>';
  state.frames.forEach((f, i) => {
    const opt = document.createElement("option");
    opt.value = i;
    opt.textContent = `프레임 ${i + 1}${i === state.frameIdx ? " (현재)" : ""}`;
    select.appendChild(opt);
  });
  // 현재 슬롯 1 frameIdx 복원
  const refIdx = state.slots[1].frameIdx;
  if (refIdx >= 0 && refIdx < state.frames.length) {
    select.value = refIdx;
  } else {
    select.value = "-1";
  }
}

function fitCanvas2(canvas, ctx) {
  const dpr = window.devicePixelRatio || 1;
  const parent = canvas.parentElement;
  const w = parent.clientWidth;
  const h = parent.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  canvas.style.width = w + "px";
  canvas.style.height = h + "px";
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function renderRefCanvas() {
  // drawSlot(1)이 redraw에서 처리. 호환성용 빈 함수.
  if (false) {  // 더 이상 사용 안 함
  fitCanvas2(refCanvas, refCtx);
  const cw = refCanvas.clientWidth;
  const ch = refCanvas.clientHeight;
  refCtx.fillStyle = "#1a1a1a";
  refCtx.fillRect(0, 0, cw, ch);
  const refIdx = state.slots[1].frameIdx;
  if (refIdx < 0 || refIdx >= state.frames.length) return;
  const f = state.frames[refIdx];
  if (!f || !f.source) return;

  const iw = f.source.width;
  const ih = f.source.height;
  const scale = Math.min(cw / iw, ch / ih) * 0.9;
  const dw = Math.max(1, Math.floor(iw * scale));
  const dh = Math.max(1, Math.floor(ih * scale));
  const x = Math.floor((cw - dw) / 2);
  const y = Math.floor((ch - dh) / 2);
  refCtx.imageSmoothingEnabled = false;
  // 체커
  for (let py = 0; py < dh; py += 10) {
    for (let px = 0; px < dw; px += 10) {
      const dark = ((Math.floor(px / 10) + Math.floor(py / 10)) % 2) === 1;
      refCtx.fillStyle = dark ? "#aaaaaa" : "#dcdcdc";
      refCtx.fillRect(x + px, y + py, Math.min(10, dw - px), Math.min(10, dh - py));
    }
  }
  refCtx.drawImage(imageDataToCanvas2(f.source), x, y, dw, dh);
  if (f.traceLayer) refCtx.drawImage(imageDataToCanvas2(f.traceLayer), x, y, dw, dh);
  }  // if (false) 닫음
}

$("ref-frame-header")?.addEventListener("change", (e) => {
  const idx = parseInt(e.target.value, 10);
  state.slots[1].frameIdx = idx;
  if (idx < 0) {
    document.body.classList.remove("ref-on");
    setTimeout(() => redraw(), 220);
  } else {
    document.body.classList.add("ref-on");
    setTimeout(() => { redraw(); renderRefCanvas(); }, 220);
  }
  // Space/단축키가 select에 잡히지 않도록 포커스 해제
  e.target.blur();
});
window.addEventListener("resize", () => {
  if (document.body.classList.contains("ref-on")) renderRefCanvas();
});

function showShortcutsModal() {
  showModal("단축키 안내", `
    <div style="display:grid; grid-template-columns: auto 1fr; gap:6px 18px; font-size:13px;">
      <div style="font-weight:bold; color:#4a8; grid-column:1/-1; margin-top:4px;">파일/되돌리기</div>
      <kbd>Ctrl+S</kbd><span>저장 메뉴</span>
      <kbd>Ctrl+Z</kbd><span>되돌리기 (배경/도트화/편집)</span>

      <div style="font-weight:bold; color:#4a8; grid-column:1/-1; margin-top:8px;">도구</div>
      <kbd>V</kbd><span>없음 / <kbd>M</kbd> 사각형 / <kbd>L</kbd> 올가미</span>
      <kbd>B</kbd><span>브러시 / <kbd>E</kbd> 지우개 / <kbd>I</kbd> 스포이드</span>
      <kbd>브러시 우클릭</kbd><span>임시 지우개 (Aseprite 스타일)</span>

      <div style="font-weight:bold; color:#4a8; grid-column:1/-1; margin-top:8px;">선택 영역</div>
      <kbd>Ctrl+C</kbd><span>복사 / <kbd>Ctrl+X</kbd> 잘라내기 / <kbd>Ctrl+V</kbd> 붙여넣기</span>
      <kbd>Delete</kbd><span>선택 영역 비우기 (= 지우기)</span>
      <kbd>Ctrl+Shift+I</kbd><span>선택 반전</span>

      <div style="font-weight:bold; color:#4a8; grid-column:1/-1; margin-top:8px;">붙여넣기 후 (floating)</div>
      <kbd>마우스 이동</kbd><span>위치 조정</span>
      <kbd>R</kbd><span>90° 회전 (NEAREST 픽셀 재정의)</span>
      <kbd>Shift+R</kbd><span>임의 각도 입력</span>
      <kbd>클릭</kbd><span>확정 / <kbd>ESC</kbd> 취소</span>

      <div style="font-weight:bold; color:#4a8; grid-column:1/-1; margin-top:8px;">프레임</div>
      <kbd>← / →</kbd><span>이전/다음 프레임</span>
      <kbd>Ctrl+D</kbd><span>현재 프레임 복제</span>
      <kbd>Shift + ↔ 반전</kbd><span>모든 프레임 일괄 좌우 반전</span>

      <div style="font-weight:bold; color:#4a8; grid-column:1/-1; margin-top:8px;">화면</div>
      <kbd>휠</kbd><span>커서 기준 줌</span>
      <kbd>+ / -</kbd><span>줌 인/아웃</span>
      <kbd>0</kbd><span>FIT / <kbd>1</kbd> 100%</span>
      <kbd>Space / Ctrl+Shift / 미들버튼 + 드래그</kbd><span>팬</span>

      <div style="font-weight:bold; color:#4a8; grid-column:1/-1; margin-top:8px;">기타</div>
      <kbd>ESC</kbd><span>모달 닫기 / 선택 해제 / floating 취소</span>
      <kbd>F1</kbd><span>이 단축키 안내</span>
      <kbd>드래그앤드롭</kbd><span>이미지 → 새 프레임</span>
    </div>
  `);
}

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
function updateEmptyState() {
  const el = $("empty-state");
  if (!el) return;
  if (state.frames.length === 0) el.classList.remove("hidden");
  else el.classList.add("hidden");
}

function renderTimeline() {
  updateEmptyState();
  if (typeof renderRefFrameOptions === "function") renderRefFrameOptions();
  if (typeof renderRefCanvas === "function" && document.body.classList.contains("ref-on")) renderRefCanvas();
  if (typeof renderLayersPanel === "function") renderLayersPanel();
  const container = $("timeline-frames");
  container.innerHTML = "";
  state.frames.forEach((frame, i) => {
    const div = document.createElement("div");
    let cls = "tl-frame";
    if (i === state.frameIdx) cls += " active";
    if (frame.visible === false) cls += " hidden-layer";
    div.className = cls;
    div.draggable = true;

    const c = document.createElement("canvas");
    const size = 56;
    c.width = size; c.height = size;
    const ctx = c.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    for (let py = 0; py < size; py += 8) {
      for (let px = 0; px < size; px += 8) {
        ctx.fillStyle = ((px / 8 + py / 8) % 2 === 0) ? "#888" : "#aaa";
        ctx.fillRect(px, py, 8, 8);
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

    div.addEventListener("click", () => {
      if (i !== state.frameIdx) selectFrame(i);
    });

    // 드래그 순서 변경
    div.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("text/plain", String(i));
      div.classList.add("dragging");
    });
    div.addEventListener("dragend", () => {
      div.classList.remove("dragging");
      document.querySelectorAll(".tl-frame.drop-target").forEach(el => el.classList.remove("drop-target"));
    });
    div.addEventListener("dragover", (e) => { e.preventDefault(); div.classList.add("drop-target"); });
    div.addEventListener("dragleave", () => div.classList.remove("drop-target"));
    div.addEventListener("drop", (e) => {
      e.preventDefault();
      div.classList.remove("drop-target");
      const fromIdx = parseInt(e.dataTransfer.getData("text/plain"), 10);
      const toIdx = i;
      if (isNaN(fromIdx) || fromIdx === toIdx) return;
      const moved = state.frames.splice(fromIdx, 1)[0];
      state.frames.splice(toIdx, 0, moved);
      if (state.frameIdx === fromIdx) state.frameIdx = toIdx;
      else if (fromIdx < state.frameIdx && toIdx >= state.frameIdx) state.frameIdx--;
      else if (fromIdx > state.frameIdx && toIdx <= state.frameIdx) state.frameIdx++;
      invalidateSourceCache();
      renderTimeline();
      redraw();
    });

    container.appendChild(div);
    if (i === state.frameIdx) {
      setTimeout(() => div.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" }), 0);
    }
  });
  $("tl-info").textContent = state.frames.length === 0
    ? "프레임 0개"
    : `프레임 ${state.frameIdx + 1} / ${state.frames.length}`;
}

// ===== 레이어 패널 (우측 Photoshop 스타일) =====
function renderLayersPanel() {
  const list = document.getElementById("layers-list");
  if (!list) return;
  list.innerHTML = "";
  // 위 = 앞 (Photoshop 컨벤션) → 마지막 프레임이 패널 최상단
  const order = state.frames.map((_, i) => i).reverse();
  order.forEach((i) => {
    const f = state.frames[i];
    const item = document.createElement("div");
    item.className = "layer-item" + (i === state.frameIdx ? " active" : "");
    item.dataset.idx = String(i);
    item.draggable = true;

    // 표시 토글
    const visBtn = document.createElement("button");
    visBtn.className = "layer-vis" + (f.visible === false ? " off" : "");
    visBtn.textContent = f.visible === false ? "·" : "👁";
    visBtn.title = f.visible === false ? "표시" : "숨김";
    visBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      f.visible = f.visible === false ? true : false;
      renderLayersPanel();
      renderTimeline();
      redraw();
    });

    // 썸네일
    const thumbWrap = document.createElement("div");
    thumbWrap.className = "layer-thumb";
    const c = document.createElement("canvas");
    c.width = 36; c.height = 36;
    const ctxT = c.getContext("2d");
    ctxT.imageSmoothingEnabled = false;
    if (f.source) {
      const tmp = imageDataToCanvas2(f.source);
      const ratio = Math.min(36 / f.source.width, 36 / f.source.height);
      const w = f.source.width * ratio, h = f.source.height * ratio;
      ctxT.drawImage(tmp, (36 - w) / 2, (36 - h) / 2, w, h);
    }
    thumbWrap.appendChild(c);

    // 이름 (더블클릭 편집)
    const nameDiv = document.createElement("div");
    nameDiv.className = "layer-name";
    nameDiv.textContent = f.name || `프레임 ${i + 1}`;
    nameDiv.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      const input = document.createElement("input");
      input.type = "text";
      input.value = f.name || `프레임 ${i + 1}`;
      nameDiv.innerHTML = "";
      nameDiv.appendChild(input);
      input.focus();
      input.select();
      const commit = () => {
        f.name = input.value.trim() || `프레임 ${i + 1}`;
        renderLayersPanel();
      };
      input.addEventListener("blur", commit);
      input.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") { commit(); ev.preventDefault(); }
        else if (ev.key === "Escape") { renderLayersPanel(); }
      });
    });

    // 불투명도 슬라이더
    const opWrap = document.createElement("div");
    opWrap.className = "layer-opacity";
    const opIn = document.createElement("input");
    opIn.type = "range";
    opIn.min = "0"; opIn.max = "100";
    const opPct = Math.round((f.opacity === undefined ? 1 : f.opacity) * 100);
    opIn.value = String(opPct);
    opIn.style.setProperty("--p", opPct + "%");
    opIn.addEventListener("input", (e) => {
      e.stopPropagation();
      f.opacity = parseInt(opIn.value, 10) / 100;
      opVal.textContent = opIn.value + "%";
      opIn.style.setProperty("--p", opIn.value + "%");
      redraw();
    });
    opIn.addEventListener("click", (e) => e.stopPropagation());
    const opVal = document.createElement("span");
    opVal.className = "layer-opacity-val";
    opVal.textContent = opPct + "%";
    opWrap.appendChild(opIn);
    opWrap.appendChild(opVal);

    item.appendChild(visBtn);
    item.appendChild(thumbWrap);
    const center = document.createElement("div");
    center.className = "layer-name-wrap";
    center.appendChild(nameDiv);
    item.appendChild(center);
    item.appendChild(opWrap);

    item.addEventListener("click", () => {
      if (i !== state.frameIdx) selectFrame(i);
    });

    // 드래그 순서 변경
    item.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("text/plain", String(i));
      item.classList.add("dragging");
    });
    item.addEventListener("dragend", () => {
      item.classList.remove("dragging");
      document.querySelectorAll(".layer-item.drop-target").forEach(el => el.classList.remove("drop-target"));
    });
    item.addEventListener("dragover", (e) => {
      e.preventDefault();
      item.classList.add("drop-target");
    });
    item.addEventListener("dragleave", () => item.classList.remove("drop-target"));
    item.addEventListener("drop", (e) => {
      e.preventDefault();
      item.classList.remove("drop-target");
      const fromIdx = parseInt(e.dataTransfer.getData("text/plain"), 10);
      const toIdx = i;
      if (isNaN(fromIdx) || fromIdx === toIdx) return;
      const moved = state.frames.splice(fromIdx, 1)[0];
      state.frames.splice(toIdx, 0, moved);
      // active frame 인덱스 보정
      if (state.frameIdx === fromIdx) state.frameIdx = toIdx;
      else if (fromIdx < state.frameIdx && toIdx >= state.frameIdx) state.frameIdx--;
      else if (fromIdx > state.frameIdx && toIdx <= state.frameIdx) state.frameIdx++;
      invalidateSourceCache();
      renderLayersPanel();
      renderTimeline();
      redraw();
    });

    list.appendChild(item);
  });
  const cnt = document.getElementById("layer-count");
  if (cnt) cnt.textContent = String(state.frames.length);
}

// 모드 토글
function setViewMode(mode) {
  if (mode !== "anim" && mode !== "layer") return;
  state.viewMode = mode;
  document.querySelectorAll(".mode-btn").forEach((b) => b.classList.remove("active"));
  const btn = document.getElementById(mode === "anim" ? "mode-anim" : "mode-layer");
  if (btn) btn.classList.add("active");
  redraw();
  setStatus(mode === "anim" ? "🎬 애니메이션 모드" : "🍰 레이어 모드 (표시 ON 모두 겹침)");
}

document.getElementById("mode-anim")?.addEventListener("click", () => setViewMode("anim"));
document.getElementById("mode-layer")?.addEventListener("click", () => setViewMode("layer"));

document.getElementById("btn-layers-all-show")?.addEventListener("click", () => {
  state.frames.forEach(f => f.visible = true);
  renderLayersPanel();
  renderTimeline();
  redraw();
});
document.getElementById("btn-layers-all-hide")?.addEventListener("click", () => {
  state.frames.forEach(f => f.visible = false);
  renderLayersPanel();
  renderTimeline();
  redraw();
});

document.getElementById("btn-layer-add")?.addEventListener("click", () => addBlankFrame());

function addBlankFrame() {
  const f = state.frames[state.frameIdx];
  const n = (f && f.pixelized && f.source)
    ? f.source.width
    : (getGridSize() * getSub());
  const img = new ImageData(n, n);
  const idx = state.frames.length + 1;
  state.frames.push({
    source: img, original: img,
    pixelized: true,
    fileName: "untitled",
    name: `프레임 ${idx}`,
    traceLayer: null,
    visible: true, opacity: 1.0,
  });
  state.frameIdx = state.frames.length - 1;
  state.zoom = "fit";
  state.panX = 0; state.panY = 0;
  state.selection = null;
  state.draftSelection = null;
  invalidateSourceCache();
  updateZoomDisplay();
  refreshPalette();
  renderTimeline();
  redraw();
  setStatus(`빈 프레임 추가됨 (${n}×${n})`, "success");
}

function clearSelectionContent() {
  if (!state.selection || !state.source) return;
  const W = state.source.width, H = state.source.height;
  const mask = buildSelectionMask(state.selection, W, H, "touch");
  const f = state.frames[state.frameIdx];
  if (!f) return;
  snapshot();
  const target = state.tracing && f.traceLayer ? f.traceLayer : f.source;
  const newImg = new ImageData(W, H);
  newImg.data.set(target.data);
  let cleared = 0;
  for (let i = 0; i < W * H; i++) {
    if (mask[i] && newImg.data[i * 4 + 3] > 0) {
      newImg.data[i * 4 + 3] = 0;
      cleared++;
    }
  }
  if (state.tracing) f.traceLayer = newImg;
  else f.source = newImg;
  invalidateSourceCache();
  refreshPalette();
  renderTimeline();
  redraw();
  setStatus(`${cleared} 도트 비움`, "success");
}

function invertSelection() {
  if (!state.source) return;
  const W = state.source.width, H = state.source.height;
  if (!state.selection) {
    // 선택 없으면 전체 = 빈 영역으로 반전 → 그냥 전체 사각형 선택
    state.selection = { type: "rect", x1: 0, y1: 0, x2: W, y2: H };
    redraw();
    setStatus("전체 선택", "success");
    return;
  }
  // 기존 선택을 마스크화 → 반전 마스크 → bounding rect 또는 다각형으로 변환은 어려우니
  // 마스크 자체를 selection으로 보관하는 새 형식 도입: type: "mask"
  const mask = buildSelectionMask(state.selection, W, H, "touch");
  const inv = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) inv[i] = mask[i] ? 0 : 1;
  state.selection = { type: "mask", mask: inv, w: W, h: H };
  redraw();
  setStatus("선택 반전", "success");
}

function duplicateCurrentFrame() {
  if (state.frames.length === 0) return;
  const cur = state.frames[state.frameIdx];
  if (!cur || !cur.source) return;
  const cloneImg = (img) => {
    if (!img) return null;
    const out = new ImageData(img.width, img.height);
    out.data.set(img.data);
    return out;
  };
  const idx = state.frames.length + 1;
  const dup = {
    source: cloneImg(cur.source),
    original: cloneImg(cur.original),
    pixelized: cur.pixelized,
    fileName: cur.fileName,
    name: (cur.name || `프레임 ${state.frameIdx + 1}`) + " 복사",
    traceLayer: cloneImg(cur.traceLayer),
    visible: true, opacity: 1.0,
  };
  // 현재 프레임 바로 다음에 삽입
  state.frames.splice(state.frameIdx + 1, 0, dup);
  state.frameIdx = state.frameIdx + 1;
  state.selection = null;
  state.draftSelection = null;
  invalidateSourceCache();
  refreshPalette();
  renderTimeline();
  redraw();
  setStatus(`프레임 복제됨 (${state.frameIdx + 1}/${state.frames.length})`, "success");
}

document.getElementById("btn-layer-dup")?.addEventListener("click", duplicateCurrentFrame);

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
let playDirection = 1;  // 핑퐁용

function getPlayMode() {
  const sel = document.getElementById("tl-play-mode");
  return sel ? sel.value : "loop";
}

function playStep() {
  if (state.frames.length < 2) return;
  const N = state.frames.length;
  const mode = getPlayMode();
  if (mode === "pingpong") {
    let next = state.frameIdx + playDirection;
    if (next >= N) { playDirection = -1; next = state.frameIdx - 1; }
    else if (next < 0) { playDirection = 1; next = state.frameIdx + 1; }
    state.frameIdx = Math.max(0, Math.min(N - 1, next));
  } else if (mode === "once") {
    if (state.frameIdx + 1 >= N) {
      // 끝 → 정지
      stopPlayback();
      return;
    }
    state.frameIdx = state.frameIdx + 1;
  } else {
    state.frameIdx = (state.frameIdx + 1) % N;
  }
  invalidateSourceCache();
  renderTimeline();
  redraw();
}

function startPlayback() {
  if (state.frames.length < 2) return;
  if (playInterval) clearInterval(playInterval);
  playDirection = 1;
  const fps = Math.max(1, parseInt($("tl-fps").value, 10) || 12);
  $("tl-play").disabled = true;
  $("tl-stop").disabled = false;
  playInterval = setInterval(playStep, 1000 / fps);
}

function stopPlayback() {
  if (playInterval) { clearInterval(playInterval); playInterval = null; }
  $("tl-play").disabled = false;
  $("tl-stop").disabled = true;
}

$("tl-play").addEventListener("click", startPlayback);
$("tl-stop").addEventListener("click", stopPlayback);
$("tl-fps").addEventListener("input", () => {
  if (playInterval) {
    clearInterval(playInterval);
    const fps = Math.max(1, parseInt($("tl-fps").value, 10) || 12);
    playInterval = setInterval(playStep, 1000 / fps);
  }
});
$("tl-play-mode")?.addEventListener("change", () => { playDirection = 1; });
$("onion-range")?.addEventListener("change", redraw);
$("onion-tint")?.addEventListener("change", redraw);
// (tl-add 제거됨 — + 이미지는 상단 탑바에만)

// 어니언 범위 헬퍼
function getOnionRange() {
  const el = $("onion-range");
  if (!el) return 0;
  const v = el.value;
  if (v === "0") return 0;
  if (v === "all") return "all";
  return parseInt(v, 10) || 0;
}

// 색 틴트 적용해서 프레임 그리기 (어니언 스킨용)
function drawTintedFrame(ctxEl, frame, x, y, dw, dh, alpha, tintColor) {
  ctxEl.globalAlpha = alpha;
  if (!tintColor) {
    ctxEl.drawImage(imageDataToCanvas2(frame.source), x, y, dw, dh);
    if (frame.traceLayer) ctxEl.drawImage(imageDataToCanvas2(frame.traceLayer), x, y, dw, dh);
    return;
  }
  // 틴트: 오프스크린에 프레임 그리고 source-atop으로 색 곱셈
  const off = document.createElement("canvas");
  off.width = frame.source.width;
  off.height = frame.source.height;
  const oc = off.getContext("2d");
  oc.drawImage(imageDataToCanvas2(frame.source), 0, 0);
  if (frame.traceLayer) oc.drawImage(imageDataToCanvas2(frame.traceLayer), 0, 0);
  oc.globalCompositeOperation = "source-atop";
  oc.fillStyle = tintColor;
  oc.fillRect(0, 0, off.width, off.height);
  ctxEl.drawImage(off, x, y, dw, dh);
}

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
      <div class="modal-row">
        <span style="font-size:12px; color:#aaa;">출력 모드</span>
        <div class="radio-group">
          <input type="radio" name="output-mode" id="om-comp" value="combined" checked><label for="om-comp">합친 결과</label>
          <input type="radio" name="output-mode" id="om-src" value="source"><label for="om-src">원본만</label>
          <input type="radio" name="output-mode" id="om-trc" value="trace"><label for="om-trc">트레이스만</label>
        </div>
      </div>
      <div class="modal-row"><label>시트 컬럼 <input type="number" id="sm-cols" value="8" min="1" max="64"></label><label>패딩 <input type="number" id="sm-padding" value="0" min="0" max="32"></label></div>
      <div class="modal-row"><label>GIF FPS <input type="number" id="sm-fps" value="12" min="1" max="60"></label><label>GIF 스케일 <input type="number" id="sm-scale" value="4" min="1" max="16"></label></div>
    </div>
    <div class="modal-row" style="justify-content:flex-end; margin-top:18px;">
      <button id="sm-execute" class="primary">저장</button>
    </div>
  `);
  $("sm-execute").addEventListener("click", async () => {
    const mode = document.querySelector('input[name="save-mode"]:checked').value;
    const outputMode = document.querySelector('input[name="output-mode"]:checked').value;
    const ts = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);

    function frameImage(f) {
      if (outputMode === "source") return f.source;
      if (outputMode === "trace") return f.traceLayer || new ImageData(f.source.width, f.source.height);
      return compositeFrame(f) || f.source;
    }

    if (mode === "png") {
      const f = state.frames[state.frameIdx];
      const img = frameImage(f);
      const c = freshCanvas(img);
      const blob = await new Promise((res) => c.toBlob(res, "image/png"));
      const base = stripExt(state.fileName) || "frame";
      const tag = state.pixelized ? `_${img.width}x${img.height}` : "";
      downloadBlob(blob, `${base}${tag}.png`);
      hideModal();
    } else if (mode === "zip") {
      const zip = new JSZip();
      for (let i = 0; i < state.frames.length; i++) {
        const f = state.frames[i];
        const img = frameImage(f);
        const c = freshCanvas(img);
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
      const imgs = state.frames.map(frameImage);
      const maxW = Math.max(...imgs.map(i => i.width));
      const maxH = Math.max(...imgs.map(i => i.height));
      const rows = Math.ceil(imgs.length / cols);
      const sheetW = cols * maxW + (cols + 1) * padding;
      const sheetH = rows * maxH + (rows + 1) * padding;
      const c = document.createElement("canvas");
      c.width = sheetW; c.height = sheetH;
      const ctx = c.getContext("2d");
      ctx.imageSmoothingEnabled = false;
      imgs.forEach((img, i) => {
        const r = Math.floor(i / cols);
        const cc = i % cols;
        const x = padding + cc * (maxW + padding);
        const y = padding + r * (maxH + padding);
        ctx.drawImage(imageDataToCanvas2(img), x, y);
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
      const imgs = state.frames.map(frameImage);
      const W = imgs[0].width * scale;
      const H = imgs[0].height * scale;
      const gif = new GIF({
        workers: 2, quality: 10, width: W, height: H,
        workerScript: "https://cdn.jsdelivr.net/npm/gif.js@0.2.0/dist/gif.worker.js",
      });
      imgs.forEach((img) => {
        const cc = document.createElement("canvas");
        cc.width = W; cc.height = H;
        const cctx = cc.getContext("2d");
        cctx.imageSmoothingEnabled = false;
        cctx.drawImage(imageDataToCanvas2(img), 0, 0, W, H);
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
