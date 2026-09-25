import { segmentDrawing } from "./segment.js";
import { buildInflatedMesh, disposeModel } from "./inflate.js";
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
let segmentation = null; // {mask, width, height}
let modelGroup = null; // THREE.Group, lives in exactly one scene at a time

const preview = new PreviewScene(previewCanvas);

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

function rebuildModel({ resetView }) {
  const next = buildInflatedMesh(sourceImage, segmentation, thickness());
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
    rebuildModel({ resetView: true });

    previewWrap.hidden = false;
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
const saveShotBtn = $("saveShotBtn");
const shareShotBtn = $("shareShotBtn");
const closeShotBtn = $("closeShotBtn");
const arToast = $("arToast");

let lastShot = null; // { file, url }
let toastTimer = null;

function showToast(text, ms = 3500) {
  arToast.textContent = text;
  arToast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (arToast.hidden = true), ms);
}

captureBtn.addEventListener("click", async () => {
  if (!arScene) return;
  captureBtn.disabled = true;
  try {
    const result = await arScene.requestCapture();
    if (!result.ok) {
      const chrome = (navigator.userAgent.match(/Chrome\/(\d+)/) || [])[1] || "?";
      showToast(
        result.error?.message === "NO_CAMERA_ACCESS"
          ? `이 폰에서는 AR 사진 저장이 지원되지 않아요. 폰의 스크린샷 기능(전원+볼륨 아래)을 이용해주세요. (코드: ${result.error.code}, Chrome ${chrome})`
          : "캡처에 실패했어요: " + (result.error?.message || result.error),
        8000
      );
      return;
    }
    const blob = await pixelsToJpeg(result);
    if (lastShot) URL.revokeObjectURL(lastShot.url);
    const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
    lastShot = {
      file: new File([blob], `photo-ar-${stamp}.jpg`, { type: "image/jpeg" }),
      url: URL.createObjectURL(blob),
    };
    captureImg.src = lastShot.url;
    shareShotBtn.hidden = !(navigator.canShare && navigator.canShare({ files: [lastShot.file] }));
    captureSheet.hidden = false;
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

saveShotBtn.addEventListener("click", () => {
  if (!lastShot) return;
  const a = document.createElement("a");
  a.href = lastShot.url;
  a.download = lastShot.file.name;
  arOverlay.appendChild(a);
  a.click();
  a.remove();
  showToast("저장을 시작했어요. 알림창이나 '내 파일 → 다운로드'에서 확인할 수 있어요.");
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
