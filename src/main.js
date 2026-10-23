import {
  segmentDrawing, toggleHoleAt, isTapRestorable, paintStroke, snapshotEdits, restoreEdits,
} from "./segment.js";
import { buildInflatedMesh, disposeModel } from "./inflate.js";
import { buildCleanTexture } from "./texture.js";
import { detectNonChromeBrowser, chromeIntentUrl, detectIosInApp, kakaoOpenExternalUrl } from "./browser.js";
import { PreviewScene } from "./previewScene.js";
import { ARScene } from "./arScene.js";
import { supportsQuickLook, exportUsdz } from "./quicklook.js";

const $ = (id) => document.getElementById(id);

const uploadBox = $("uploadBox");
const fileInput = $("fileInput");
const uploadPlaceholder = $("uploadPlaceholder");
const previewImg = $("previewImg");
const depthSlider = $("depthSlider");
const convertBtn = $("convertBtn");
const statusText = $("statusText");
const previewWrap = $("previewWrap");
const previewCanvas = $("previewCanvas");
const goArBtn = $("goArBtn");
const arSupportText = $("arSupportText");

const setupScreen = $("setup-screen");
const arScreenEl = $("ar-screen");
const arOverlay = $("ar-overlay");
const arHint = $("arHint");
const arControls = $("arControls");
const captureBtn = $("captureBtn");
const resetBtn = $("resetBtn");
const exitArBtn = $("exitArBtn");
const modeToggle = $("modeToggle");

let sourceImage = null; // HTMLImageElement
let segmentation = null; // from segmentDrawing(); toggleHoleAt() edits it in place
let modelGroup = null; // THREE.Group, lives in exactly one scene at a time

const preview = new PreviewScene(previewCanvas);

const nonChromeBrowser = detectNonChromeBrowser();
const isSamsungInternet = nonChromeBrowser === "samsung";
for (const a of document.querySelectorAll(".chrome-link")) {
  a.href = chromeIntentUrl();
  a.hidden = !nonChromeBrowser;
}
$("browserTip").hidden = !nonChromeBrowser;
const inAppNames = { naver: "네이버 앱", kakao: "카카오톡" };
if (inAppNames[nonChromeBrowser]) {
  $("browserTipText").innerHTML =
    `${inAppNames[nonChromeBrowser]}에서는 AR 기능(내 공간에 놓기, 사진 촬영)을 쓸 수 없어요.<br />Chrome에서 열어주세요.`;
  $("browserTipFallback").hidden = false;
}

const iosInApp = detectIosInApp();
if (iosInApp) {
  $("browserTip").hidden = false;
  $("browserTipText").innerHTML =
    `${inAppNames[iosInApp]}에서는 아이폰 AR 화면이 열리지 않을 수 있어요.<br />Safari에서 열어주세요.`;
  const link = $("browserTip").querySelector(".chrome-link");
  if (iosInApp === "kakao") {
    link.textContent = "Safari로 열기";
    link.href = kakaoOpenExternalUrl();
    link.hidden = false;
  }
  $("browserTipFallback").textContent =
    "버튼이 없거나 안 열리면, 화면의 메뉴(⋯)에서 'Safari로 열기' 또는 '다른 브라우저로 열기'를 눌러주세요.";
  $("browserTipFallback").hidden = false;
}

// iPhone/iPad: no WebXR, so "AR로 내 공간에 놓기" becomes a link that opens
// the model in Apple's AR viewer (it has its own move/rotate/scale + shutter).
const quickLook = supportsQuickLook();
const quickLookLink = $("quickLookLink");
const QUICK_LOOK_HINT =
  "아이폰에서는 애플 AR 화면이 열려요. 손가락으로 옮기고 돌리고 크기를 바꿀 수 있고, 아래 흰 셔터 버튼을 누르면 '사진' 앱에 저장돼요.";

let arSupported = false;
if (quickLook) {
  goArBtn.hidden = true;
  quickLookLink.hidden = false;
  arSupportText.textContent = QUICK_LOOK_HINT;
} else {
  ARScene.isSupported().then((supported) => {
    arSupported = supported;
    arSupportText.textContent = supported
      ? ""
      : "이 브라우저/기기는 WebXR AR을 지원하지 않아요. Android Chrome 최신 버전에서 열어보세요.";
  });
}

let usdzUrl = null;
let usdzVersion = 0;

/** Re-exports the current model for AR Quick Look; the link is unusable until done. */
async function refreshQuickLook() {
  const version = ++usdzVersion;
  quickLookLink.classList.add("preparing");
  quickLookLink.removeAttribute("href");
  try {
    const url = await exportUsdz(modelGroup);
    if (version !== usdzVersion) {
      URL.revokeObjectURL(url); // a newer model replaced this one meanwhile
      return;
    }
    if (usdzUrl) URL.revokeObjectURL(usdzUrl);
    usdzUrl = url;
    quickLookLink.href = url;
    quickLookLink.classList.remove("preparing");
    arSupportText.textContent = QUICK_LOOK_HINT;
  } catch (err) {
    console.error(err);
    if (version === usdzVersion) arSupportText.textContent = "AR 파일을 만들지 못했어요: " + (err?.message || err);
  }
}

let arScene = null;
function getArScene() {
  if (!arScene) {
    arScene = new ARScene({
      overlayEl: arOverlay,
      onPlacementChanged: (isPlaced) => {
        arHint.hidden = isPlaced;
        arControls.hidden = !isPlaced;
        modeToggle.hidden = !isPlaced;
        if (isPlaced) {
          showToast("한 손가락으로 끌면 이동, '회전'을 누르고 좌우로 밀면 돌아가요. 두 손가락을 벌리거나 오므리면 크기가 바뀌어요.", 5000);
        }
      },
      onSessionEnd: () => {
        exitArUI();
      },
    });
  }
  return arScene;
}

// ---------- Upload ----------
uploadBox.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", async () => {
  const file = fileInput.files && fileInput.files[0];
  if (!file) return;

  const url = URL.createObjectURL(file);
  const img = new Image();
  img.crossOrigin = "anonymous";
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = reject;
    img.src = url;
  });

  sourceImage = img;
  usdzVersion++; // drop any in-flight export of the previous photo
  quickLookLink.classList.add("preparing");
  quickLookLink.removeAttribute("href");
  previewImg.src = url;
  previewImg.hidden = false;
  uploadPlaceholder.hidden = true;
  convertBtn.disabled = false;
  previewWrap.hidden = true;
  goArBtn.disabled = true;
  statusText.textContent = "";
});

// ---------- Convert to 3D ----------
const thickness = () => 0.2 + (Number(depthSlider.value) / 100) * 1.2;

let cleanTexture = null; // photo with paper between crayon strokes repainted

function rebuildModel({ resetView, maskChanged }) {
  if (maskChanged || !cleanTexture) cleanTexture = buildCleanTexture(sourceImage, segmentation);
  const next = buildInflatedMesh(cleanTexture, segmentation, thickness());
  const prev = modelGroup;
  modelGroup = next;
  preview.setModel(modelGroup, { resetView });
  if (prev) disposeModel(prev);
  if (quickLook) refreshQuickLook();
}

convertBtn.addEventListener("click", async () => {
  if (!sourceImage) return;
  convertBtn.disabled = true;
  statusText.textContent = "그림을 오려내는 중...";
  await new Promise((r) => setTimeout(r, 30)); // let the status text paint

  try {
    segmentation = segmentDrawing(sourceImage);
    resetEditor();
    statusText.textContent = "입체로 부풀리는 중...";
    await new Promise((r) => setTimeout(r, 30));
    rebuildModel({ resetView: true, maskChanged: true });

    previewWrap.hidden = false;
    drawCutout();
    goArBtn.disabled = !arSupported;
    statusText.textContent = "완료! 아래 미리보기를 돌려서 앞뒤를 확인해보세요.";
  } catch (err) {
    console.error(err);
    statusText.textContent = "3D 변환 중 오류가 발생했어요: " + (err?.message || err);
  } finally {
    convertBtn.disabled = false;
  }
});

depthSlider.addEventListener("change", () => {
  if (modelGroup && segmentation) rebuildModel({ resetView: false });
});

// ---------- Cut-out editor ----------
const cutoutCanvas = $("cutoutCanvas");
const editTools = $("editTools");
const brushSizes = $("brushSizes");
const undoBtn = $("undoBtn");
const BRUSH_CSS_PX = { thin: 5, thick: 14 }; // radius on screen, independent of photo size

let tool = "tap"; // "tap" | "restore" | "erase"
let brushSize = "thin";
let undoStack = [];
let cutoutPhoto = null; // ImageData of cleanTexture at working size
let cutoutPhotoSource = null;
let brushCursor = null; // {x, y, r} in working pixels while painting

function drawCutout() {
  const { width: W, height: H, mask } = segmentation;
  if (cutoutPhotoSource !== cleanTexture) {
    const c = document.createElement("canvas");
    c.width = W;
    c.height = H;
    const cx = c.getContext("2d", { willReadFrequently: true });
    cx.drawImage(cleanTexture, 0, 0, W, H);
    cutoutPhoto = cx.getImageData(0, 0, W, H);
    cutoutPhotoSource = cleanTexture;
  }

  if (cutoutCanvas.width !== W || cutoutCanvas.height !== H) {
    cutoutCanvas.width = W;
    cutoutCanvas.height = H;
  }
  const ctx = cutoutCanvas.getContext("2d");
  const cell = Math.max(6, Math.round(Math.max(W, H) / 40));
  for (let y = 0; y < H; y += cell) {
    for (let x = 0; x < W; x += cell) {
      ctx.fillStyle = ((x / cell + y / cell) & 1) ? "#2a2c36" : "#1d1f27";
      ctx.fillRect(x, y, cell, cell);
    }
  }

  const out = new ImageData(new Uint8ClampedArray(cutoutPhoto.data), W, H);
  for (let i = 0; i < W * H; i++) {
    if (mask[i]) continue;
    // Removed paper that a tap brings back: faint pink. Everything else removed: transparent.
    if (isTapRestorable(segmentation, i)) out.data.set([255, 90, 130, 70], i * 4);
    else out.data[i * 4 + 3] = 0;
  }
  const layer = document.createElement("canvas");
  layer.width = W;
  layer.height = H;
  layer.getContext("2d").putImageData(out, 0, 0);
  ctx.drawImage(layer, 0, 0);

  if (brushCursor) {
    ctx.beginPath();
    ctx.arc(brushCursor.x, brushCursor.y, brushCursor.r, 0, Math.PI * 2);
    ctx.lineWidth = Math.max(1, W / 300);
    ctx.strokeStyle = tool === "erase" ? "#ff6b8b" : "#7ef0a0";
    ctx.stroke();
  }
}

function canvasPoint(e) {
  const rect = cutoutCanvas.getBoundingClientRect();
  return {
    x: ((e.clientX - rect.left) / rect.width) * segmentation.width,
    y: ((e.clientY - rect.top) / rect.height) * segmentation.height,
    r: (BRUSH_CSS_PX[brushSize] / rect.width) * segmentation.width,
  };
}

function pushUndo() {
  undoStack.push(snapshotEdits(segmentation));
  if (undoStack.length > 30) undoStack.shift();
  undoBtn.disabled = false;
}

function resetEditor() {
  undoStack = [];
  undoBtn.disabled = true;
  cutoutPhotoSource = null;
  brushCursor = null;
}

function setTool(next) {
  tool = next;
  for (const b of editTools.querySelectorAll("button[data-tool]")) {
    b.classList.toggle("active", b.dataset.tool === tool);
  }
  brushSizes.hidden = tool === "tap";
  // While brushing, a finger drag paints instead of scrolling the page.
  cutoutCanvas.style.touchAction = tool === "tap" ? "manipulation" : "none";
}

editTools.addEventListener("click", (e) => {
  const b = e.target.closest("button[data-tool]");
  if (b) setTool(b.dataset.tool);
});

brushSizes.addEventListener("click", (e) => {
  const b = e.target.closest("button[data-size]");
  if (!b) return;
  brushSize = b.dataset.size;
  for (const x of brushSizes.querySelectorAll("button")) x.classList.toggle("active", x === b);
});

undoBtn.addEventListener("click", () => {
  const snap = undoStack.pop();
  if (!snap || !segmentation) return;
  restoreEdits(segmentation, snap);
  undoBtn.disabled = undoStack.length === 0;
  rebuildModel({ resetView: false, maskChanged: true });
  drawCutout();
});

let stroke = null; // active brush drag: {pointerId, x, y}
let redrawQueued = false;
function queueRedraw() {
  if (redrawQueued) return;
  redrawQueued = true;
  requestAnimationFrame(() => {
    redrawQueued = false;
    drawCutout();
  });
}

cutoutCanvas.addEventListener("pointerdown", (e) => {
  if (!segmentation || tool === "tap") return;
  e.preventDefault();
  cutoutCanvas.setPointerCapture(e.pointerId);
  const p = canvasPoint(e);
  pushUndo();
  paintStroke(segmentation, p.x, p.y, p.x, p.y, p.r, tool === "restore" ? 1 : -1);
  stroke = { pointerId: e.pointerId, x: p.x, y: p.y };
  brushCursor = p;
  queueRedraw();
});

cutoutCanvas.addEventListener("pointermove", (e) => {
  if (!stroke || e.pointerId !== stroke.pointerId) return;
  const p = canvasPoint(e);
  paintStroke(segmentation, stroke.x, stroke.y, p.x, p.y, p.r, tool === "restore" ? 1 : -1);
  stroke.x = p.x;
  stroke.y = p.y;
  brushCursor = p;
  queueRedraw();
});

function endStroke(e) {
  if (!stroke || e.pointerId !== stroke.pointerId) return;
  stroke = null;
  brushCursor = null;
  // The 3D model is only rebuilt once per stroke; the cut-out view updated live.
  rebuildModel({ resetView: false, maskChanged: true });
  drawCutout();
}
cutoutCanvas.addEventListener("pointerup", endStroke);
cutoutCanvas.addEventListener("pointercancel", endStroke);

cutoutCanvas.addEventListener("click", (e) => {
  if (!segmentation || tool !== "tap") return;
  const p = canvasPoint(e);
  const before = snapshotEdits(segmentation);
  if (toggleHoleAt(segmentation, p.x, p.y)) {
    undoStack.push(before);
    undoBtn.disabled = false;
    rebuildModel({ resetView: false, maskChanged: true });
    drawCutout();
  }
});

// ---------- Enter AR ----------
goArBtn.addEventListener("click", async () => {
  if (!modelGroup) return;
  const scene = getArScene();
  modelGroup.position.set(0, 0, 0);
  modelGroup.rotation.set(0, 0, 0);
  modelGroup.scale.setScalar(0.4); // ~40cm tall/wide in the room to start
  scene.setModel(modelGroup); // moves it out of the preview scene automatically

  setupScreen.classList.remove("active");
  arScreenEl.classList.add("active");
  arHint.hidden = false;
  arControls.hidden = true;
  modeToggle.hidden = true;
  setMode("move");

  try {
    await scene.start();
  } catch (err) {
    console.error(err);
    alert("AR 세션을 시작하지 못했어요: " + (err?.message || err));
    exitArUI();
  }
});

function exitArUI() {
  arScreenEl.classList.remove("active");
  setupScreen.classList.add("active");
  captureSheet.hidden = true;
  shotThumb.hidden = true;
  noCapturePanel.hidden = true;
  arOverlay.classList.remove("clean");
  if (modelGroup) {
    modelGroup.position.set(0, 0, 0);
    modelGroup.rotation.set(0, 0, 0);
    modelGroup.scale.setScalar(1);
    modelGroup.visible = true;
    preview.setModel(modelGroup); // bring it back to the turntable preview
  }
}

exitArBtn.addEventListener("click", async () => {
  if (arScene) await arScene.end();
});

function setMode(mode) {
  for (const b of modeToggle.querySelectorAll("button")) {
    b.classList.toggle("active", b.dataset.mode === mode);
  }
  if (arScene) arScene.setInteractionMode(mode);
}
modeToggle.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-mode]");
  if (btn) setMode(btn.dataset.mode);
});

resetBtn.addEventListener("click", () => {
  if (arScene) arScene.resetPlacement();
});

// Taps on our buttons shouldn't also count as an AR "select" (which would
// re-place the model right after pressing ↺, for example).
arOverlay.addEventListener("beforexrselect", (e) => {
  if (e.target.closest("#arControls, .ar-ui")) e.preventDefault();
});

// ---------- Capture ----------
const captureSheet = $("captureSheet");
const captureImg = $("captureImg");
const shareShotBtn = $("shareShotBtn");
const closeShotBtn = $("closeShotBtn");
const arToast = $("arToast");
const shutterFlash = $("shutterFlash");
const shotThumb = $("shotThumb");
const shotThumbImg = $("shotThumbImg");

let lastShot = null; // { file, url }
let toastTimer = null;

function showToast(text, ms = 3500, { success = false } = {}) {
  arToast.textContent = text;
  arToast.classList.toggle("success", success);
  arToast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (arToast.hidden = true), ms);
}

function restartAnimation(el, cls) {
  el.classList.remove(cls);
  void el.offsetWidth; // reflow so the same animation can play again
  el.classList.add(cls);
}

function saveToDevice(shot) {
  const a = document.createElement("a");
  a.href = shot.url;
  a.download = shot.file.name;
  arOverlay.appendChild(a);
  a.click();
  a.remove();
}

captureBtn.addEventListener("click", async () => {
  if (!arScene) return;
  captureBtn.disabled = true;
  try {
    const result = await arScene.requestCapture();
    // Flash only on success (it's DOM-only, so it never lands in the image).
    if (result.ok) restartAnimation(shutterFlash, "go");
    if (!result.ok) {
      if (result.error?.message === "NO_CAMERA_ACCESS") showNoCapturePanel(result.error.code);
      else showToast("캡처에 실패했어요: " + (result.error?.message || result.error), 8000);
      return;
    }
    const blob = await pixelsToJpeg(result);
    if (lastShot) URL.revokeObjectURL(lastShot.url);
    const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
    lastShot = {
      file: new File([blob], `photo-ar-${stamp}.jpg`, { type: "image/jpeg" }),
      url: URL.createObjectURL(blob),
    };
    // Still inside the tap's user-activation window, so Chrome allows the download.
    saveToDevice(lastShot);

    captureImg.src = lastShot.url;
    shotThumbImg.src = lastShot.url;
    shotThumb.hidden = false;
    restartAnimation(shotThumb, "pop");
    shareShotBtn.hidden = !(navigator.canShare && navigator.canShare({ files: [lastShot.file] }));
    showToast("✓ 사진을 저장했어요 (갤러리 → Download 앨범)", 3000, { success: true });
  } catch (err) {
    console.error(err);
    showToast("캡처에 실패했어요: " + (err?.message || err), 6000);
  } finally {
    captureBtn.disabled = false;
  }
});

function pixelsToJpeg({ pixels, width, height }) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  const image = ctx.createImageData(width, height);
  const row = width * 4;
  for (let y = 0; y < height; y++) {
    // WebGL rows come bottom-up.
    image.data.set(pixels.subarray((height - 1 - y) * row, (height - y) * row), y * row);
  }
  ctx.putImageData(image, 0, 0);
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("이미지 변환 실패"))), "image/jpeg", 0.92)
  );
}

shotThumb.addEventListener("click", () => {
  if (lastShot) captureSheet.hidden = false;
});

shareShotBtn.addEventListener("click", async () => {
  if (!lastShot) return;
  try {
    await navigator.share({ files: [lastShot.file] });
  } catch (err) {
    if (err?.name !== "AbortError") showToast("공유하지 못했어요: " + (err?.message || err));
  }
});

closeShotBtn.addEventListener("click", () => {
  captureSheet.hidden = true;
});

// ---------- When the browser can't capture the camera ----------
const noCapturePanel = $("noCapturePanel");
const CLEAN_SHOT_SECONDS = 5;

function showNoCapturePanel(code) {
  const version = (navigator.userAgent.match(/Chrome\/(\d+)/) || [])[1] || "?";
  $("noCaptureText").textContent = isSamsungInternet
    ? "삼성 인터넷은 AR 사진 촬영을 지원하지 않아요. Chrome에서 열면 📸 버튼으로 바로 저장돼요."
    : "이 브라우저는 AR 사진 촬영을 지원하지 않아요.";
  $("noCaptureCode").textContent = `(코드: ${code}, ${isSamsungInternet ? "Samsung Internet" : "Chrome"} ${version})`;
  $("cleanShotBtn").textContent = `버튼 숨기고 직접 캡처 (${CLEAN_SHOT_SECONDS}초)`;
  noCapturePanel.hidden = false;
}

$("noCaptureCloseBtn").addEventListener("click", () => {
  noCapturePanel.hidden = true;
});

$("cleanShotBtn").addEventListener("click", () => {
  noCapturePanel.hidden = true;
  arToast.hidden = true;
  arOverlay.classList.add("clean");
  setTimeout(() => {
    arOverlay.classList.remove("clean");
    showToast("버튼이 다시 나타났어요. 캡처한 사진은 갤러리의 스크린샷 앨범에 있어요.", 4000);
  }, CLEAN_SHOT_SECONDS * 1000);
});
