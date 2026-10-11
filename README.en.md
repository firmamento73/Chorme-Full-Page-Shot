# Full Page Shot · Scroll Archive

[简体中文](README.md) · [English](README.en.md)

<img src="icons/icon-128.png" alt="Full Page Shot icon" width="80">

Chrome Manifest V3 extension with two modes: **F12 full-page screenshot** for a one-shot PNG, and **scroll archive** for lazy or virtual lists, continuous long PNGs and image-based PDFs. Xiaohongshu-style note cards can also be saved as a searchable, self-contained HTML overview.

## F12 full-page mode

Select **F12 整页截图** at the top of the popup and click its capture button. It uses `Page.getLayoutMetrics` and `Page.captureScreenshot(captureBeyondViewport: true)`, the same capture path as DevTools' **Capture full size screenshot**. Keep the target tab's DevTools closed. PNGs go directly to the `整页截图` download folder; reopening the popup shows progress or errors. The new icon includes 16, 32, 48 and 128 pixel Chrome assets.

Optional pre-scrolling defaults on (120 ms per screen, maximum 200 screens). Floating UI is hidden temporarily by default; turn this off to preserve page appearance. Existing manual exclusions still apply. Scroll position, styles, floating UI and the selected archive container are restored after completion or failure.

This mode captures the currently retained full document. It cannot reconstruct recycled virtual rows, capture an inner scroll container, or guarantee asynchronous lazy content finishes loading. Documents over 16384 CSS pixels on either edge or 64 million CSS pixels in area are refused explicitly instead of silently truncated. Chrome may impose lower limits depending on pixel ratio and memory. Use scroll archive for those pages. Modes cannot run simultaneously on the same tab, but tasks on other tabs continue. No additional permissions are required.

## Install and use

Download `fullpage-shot-VERSION.zip` from the Assets of the [latest release](https://github.com/firmamento73/Chorme-Full-Page-Shot/releases/latest).

Extract the release ZIP. Open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select the folder containing `manifest.json`. Chrome 118+ is required. No build step is needed.

Open the target page in your logged-in browser and close its DevTools. Click the extension icon or press `Alt+Shift+S`. Select the whole document or a scroll container. Version **2.2.0** defaults to background capture: the job remains attached to the original tab while you browse elsewhere. Jobs on different tabs run independently; the popup can pause other jobs. Existing debugger permission is sufficient; no new host permissions are added. Disable the background option for foreground compatibility mode.

Replace the original extension files, reload the extension, then refresh the page. Continuous exports first repair old overlapping viewports by pixel registration. Occluded pixels and unrelated rescans may still require recapture. Manual scrolling of the source page, navigation, closure, resize, or debugger disconnection still pauses its job. Background drawing cannot guarantee every website loads correctly when hidden or that system resources remain available.

Export choices are a single streamed PNG, bounded split PNGs, a single long PDF page, or A4 paginated PDF volumes. The streamed PNG does not require a full-height canvas. The long PDF places original image blocks with touching edges; the physical page may be scaled down for PDF limits, preserving embedded image pixels. A4 pages may have remainder whitespace and viewer page separators. PDFs do not contain searchable text. Frames are joined using overlapping pixels, with a bounded full-viewport checkpoint per job. Duplicate areas are cropped; changed bottom content can replace the old tail at a verified overlap. Default seamless capture halves the scroll step and retries twice, then pauses before adding an unverified frame. Continuous output repairs overlapping independent fragments where possible and refuses remaining unverified seams; explicit force-order joining may retain duplicates or misalignment. HTML remains a self-contained card overview. Exports are saved under `网页归档`.

Saved images and checkpoints use local IndexedDB transactions. Refreshing a whole-document capture rescans from the top, deduplicates note IDs, and starts a separate screenshot strip. Selected internal containers cannot be safely identified across reloads and require a new task. URL query parameters and hashes remain part of task identity.

An explicit visible end marker plus loaded content can confirm completion. A stable bottom without a site end marker is reported as **unconfirmed completeness**. Load failures pause by default. Optional incomplete capture preserves placeholders and marks the affected fragments.

## Limitations and validation

The first release supports vertical visible-tab capture of the main document or a scroll container. It does not descend into iframes or closed Shadow DOM. CSS background images, canvas, animations, and custom skeletons may require site adapters. Visible fixed UI, small pinned sticky UI, popovers and dialogs are temporarily hidden before capture and restored on pause/end. The selected scroll body, its ancestors and large fixed reading shells are protected. Open shadow roots and dynamically inserted widgets are scanned. Generic absolute-positioned content is preserved; use the manual exclusion picker for ambiguous overlays. USER-origin filtering CSS avoids site CSP/style overrides, with reversible local shadow styles and inline fallbacks. Hidden widgets do not count as pending content images or seam anchors. Manual exclusions bind to live nodes; replacement pauses collection, and page reload requires reselection. Changing exclusions or the filtering option requires a new capture rather than mixing old pixels. With seamless capture enabled, unverifiable overlaps trigger shorter-scroll retries and then pause the job; captured content remains saved. Disabling seamless capture permits independent strips.

The user-supplied 2.0.1 PDF confirms capture from a real Xiaohongshu session and revealed repeated floating UI. The current overlay and background capture behavior still needs verification in the user's browser; test a small batch first.

The cloud browser administrator blocks unpacked-extension installation and direct `file://` navigation. Automated browser tests use a test-only extension-API bridge with real Chromium rendering and CDP screenshots. Exported standalone HTML is served locally for rendering checks. This does not validate actual extension installation, activeTab user-gesture grants, service-worker lifecycle, or local file opening. Test infrastructure is excluded from release packages.

```bash
node --test tests/core.test.js tests/seams.test.js
BROWSER_TEST_SEAMS=1 python tests/browser_test.py
BROWSER_TEST_INDEPENDENT=1 python tests/browser_test.py
BROWSER_TEST_OVERLAYS=1 python tests/browser_test.py
BROWSER_TEST_STARTUP=1 python tests/browser_test.py
python tests/browser_test.py
python scripts/package.py
```

Browser tests require Playwright, Pillow, PyMuPDF and Chromium. Set `CHROMIUM_BINARY` if needed. General results are written under `dist/test-artifacts`; overlay pixel/PDF results are under `dist/overlay-artifacts`, and independent/background/continuous export results under `dist/independent-artifacts`.

## Permissions and license

Uses `activeTab`, `scripting`, `debugger`, `storage`, and `downloads`, with no persistent all-site host permission. Page resources use the existing browser session. Capture/export data is not uploaded to external services. Chrome displays its debugger notice during capture. File pages additionally require enabling file-URL access in the extension settings.

MIT; see [LICENSE](LICENSE). Bundled pdf-lib retains its [MIT license](vendor/pdf-lib-LICENSE.md).
