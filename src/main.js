import { segmentDrawing, toggleHoleAt } from "./segment.js";
import { buildInflatedMesh, disposeModel } from "./inflate.js";
import { buildCleanTexture } from "./texture.js";
import { PreviewScene } from "./previewScene.js";
import { ARScene } from "./arScene.js";

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

// Samsung Internet runs WebXR AR but never grants "camera-access", so the
// in-app shutter can't include the room. Point those users to Chrome.
const isSamsungInternet = /SamsungBrowser\//.test(navigator.userAgent);
const chromeIntentUrl =
  `intent://${location.host}${location.pathname}${location.search}` +
  "#Intent;scheme=https;package=com.android.chrome;" +
  `S.browser_fallback_url=${encodeURIComponent("https://play.google.com/store/apps/details?id=com.android.chrome")};end`;
for (const a of document.querySelectorAll(".chrome-link")) {
  a.href = chromeIntentUrl;
  a.hidden = !isSamsungInternet;
}
$("browserTip").hidden = !isSamsungInternet;

let arSupported = false;
ARScene.isSupported().then((supported) => {
  arSupported = supported;
  arSupportText.textContent = supported
    ? ""
    : "이 브라우저/기기는 WebXR AR을 지원하지 않아요. Android Chrome 최신 버전에서 열어보세요.";
});

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
}

convertBtn.addEventListener("click", async () => {
  if (!sourceImage) return;
  convertBtn.disabled = true;
  statusText.textContent = "그림을 오려내는 중...";
  await new Promise((r) => setTimeout(r, 30)); // let the status text paint

  try {
    segmentation = segmentDrawing(sourceImage);
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

function drawCutout() {
  const { width: W, height: H, mask, holeLabels, holes } = segmentation;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const cx = c.getContext("2d", { willReadFrequently: true });
  cx.drawImage(cleanTexture, 0, 0, W, H);
  const cutoutPhoto = cx.getImageData(0, 0, W, H);

  cutoutCanvas.width = W;
  cutoutCanvas.height = H;
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
    const id = holeLabels[i];
    if (id >= 0 && holes[id].toggleable) {
      // Removed enclosed paper: faint pink so it's clear it can be tapped back.
      out.data.set([255, 90, 130, 70], i * 4);
    } else {
      out.data[i * 4 + 3] = 0;
    }
  }
  const layer = document.createElement("canvas");
  layer.width = W;
  layer.height = H;
  layer.getContext("2d").putImageData(out, 0, 0);
  ctx.drawImage(layer, 0, 0);
}

cutoutCanvas.addEventListener("click", (e) => {
  if (!segmentation) return;
  const rect = cutoutCanvas.getBoundingClientRect();
  const x = ((e.clientX - rect.left) / rect.width) * segmentation.width;
  const y = ((e.clientY - rect.top) / rect.height) * segmentation.height;
  if (toggleHoleAt(segmentation, x, y)) {
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
