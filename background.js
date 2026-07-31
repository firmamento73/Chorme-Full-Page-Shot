/**
 * 一键整页截图
 *
 * 原理：附加 Chrome DevTools Protocol 调试器到当前标签页，
 * 调用 Page.captureScreenshot 并开启 captureBeyondViewport，
 * 这正是 DevTools 命令面板里 "Capture full size screenshot" 走的同一条路径。
 */

// ── 可调参数 ────────────────────────────────────────────────
const CONFIG = {
  // 截图前先滚一遍页面，触发懒加载图片。关掉可以更快，但长图里可能出现空白占位。
  preloadLazyImages: true,
  // 每屏滚动后的等待毫秒数，网络慢的站点可以调大。
  scrollDelay: 120,
  // 图片格式："png"（无损，文件大）或 "jpeg"（体积小）。
  format: "png",
  // 仅在 jpeg 下生效，1–100。
  jpegQuality: 92,
  // 下载到「下载」目录下的子文件夹，留空则直接放根目录。
  subfolder: "整页截图",
};

// Chrome 单张贴图的尺寸上限，超过会被截断或直接失败。
const MAX_DIMENSION = 16384;
const PROTOCOL_VERSION = "1.3";

let running = false;

chrome.action.onClicked.addListener((tab) => {
  capture(tab);
});

async function capture(tab) {
  if (running) return;

  const url = tab?.url || "";
  if (!tab?.id || !/^(https?|file):/i.test(url)) {
    flash("✕", "#c0392b");
    return;
  }

  running = true;
  flash("…", "#4a5568");

  const target = { tabId: tab.id };
  let attached = false;

  try {
    await chrome.debugger.attach(target, PROTOCOL_VERSION);
    attached = true;

    if (CONFIG.preloadLazyImages) {
      await preload(target);
    }

    // 懒加载可能撑高了页面，所以在滚动之后再量一次尺寸。
    const metrics = await send(target, "Page.getLayoutMetrics");
    const content = metrics.cssContentSize || metrics.contentSize;

    const width = clamp(Math.ceil(content.width));
    const height = clamp(Math.ceil(content.height));

    const params = {
      format: CONFIG.format,
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width, height, scale: 1 },
    };
    if (CONFIG.format === "jpeg") {
      params.quality = CONFIG.jpegQuality;
    }

    const { data } = await send(target, "Page.captureScreenshot", params);

    await chrome.downloads.download({
      url: `data:image/${CONFIG.format};base64,${data}`,
      filename: buildFilename(url),
      saveAs: false,
    });

    const truncated =
      Math.ceil(content.height) > MAX_DIMENSION ||
      Math.ceil(content.width) > MAX_DIMENSION;
    flash(truncated ? "!" : "✓", truncated ? "#d68910" : "#2d7a4f");
  } catch (err) {
    console.error("[整页截图]", err);
    flash("✕", "#c0392b");
  } finally {
    if (attached) {
      try {
        await chrome.debugger.detach(target);
      } catch (_) {
        /* 标签页可能已经关了，忽略 */
      }
    }
    running = false;
  }
}

/** 快速滚一遍整页，让 lazy-load 的图片先加载出来，再回到顶部。 */
async function preload(target) {
  await send(target, "Runtime.evaluate", {
    awaitPromise: true,
    expression: `(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const step = Math.max(window.innerHeight, 200);
      const startY = window.scrollY;
      let guard = 0;
      for (let y = 0; y < document.documentElement.scrollHeight && guard < 200; y += step) {
        window.scrollTo(0, y);
        await wait(${CONFIG.scrollDelay});
        guard++;
      }
      window.scrollTo(0, 0);
      await wait(250);
      return startY;
    })()`,
  });
}

function send(target, method, params) {
  return chrome.debugger.sendCommand(target, method, params);
}

function clamp(n) {
  return Math.max(1, Math.min(n, MAX_DIMENSION));
}

function buildFilename(url) {
  let host = "page";
  try {
    host = new URL(url).hostname.replace(/^www\./, "") || "page";
  } catch (_) {
    /* file:// 之类的，用默认名 */
  }

  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const stamp =
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;

  const safeHost = host.replace(/[^a-z0-9.\-]/gi, "_");
  const name = `${safeHost}-${stamp}.${CONFIG.format === "jpeg" ? "jpg" : "png"}`;

  return CONFIG.subfolder ? `${CONFIG.subfolder}/${name}` : name;
}

/** 在图标上打一个短暂的角标，作为状态反馈。 */
function flash(text, color) {
  chrome.action.setBadgeBackgroundColor({ color });
  chrome.action.setBadgeText({ text });
  if (text !== "…") {
    setTimeout(() => chrome.action.setBadgeText({ text: "" }), 2000);
  }
}
