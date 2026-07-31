# Full Page Shot

**[简体中文](README.md) · [English](README.en.md)**

One click to capture a full-page screenshot in Chrome — the thing DevTools can already do, without the `F12` → `Ctrl+Shift+P` → type "Capture full size screenshot" dance.

## Why another screenshot extension

Most full-page screenshot extensions scroll the page, grab one viewport at a time, and stitch the pieces together. That approach repeats every `position: fixed` header down the length of the image and leaves visible seams where the tiles meet.

This one doesn't stitch. It attaches Chrome's DevTools Protocol to the tab and issues a single `Page.captureScreenshot` with `captureBeyondViewport: true` — the exact call behind the DevTools command. The renderer composites the whole page in one pass, so fixed elements appear once and there are no seams.

Total footprint: one manifest and about 150 lines of vanilla JavaScript. No build step, no dependencies, no bundler.

## Install

**From a release** — download the zip from [Releases](../../releases), unpack it, then:

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** and select the unpacked folder

The folder you select must contain `manifest.json` directly. If your unzip tool nested it one level deep, go into the inner folder.

**From source** — clone and load the working tree the same way. There is nothing to build.

```bash
git clone https://github.com/firmamento73/fullpage-shot.git
```

Optionally pin the extension to the toolbar via the puzzle-piece icon.

## Usage

Click the toolbar icon, or press `Alt+Shift+S`.

The image is written straight to `Downloads/整页截图/<hostname>-<timestamp>.png` with no save dialog. The toolbar badge reports status: `…` working, `✓` saved, `!` saved but truncated, `✕` failed.

Rebind the shortcut at `chrome://extensions/shortcuts`.

## Configuration

Everything tunable lives in the `CONFIG` block at the top of `background.js`:

| Option | Default | Effect |
| --- | --- | --- |
| `preloadLazyImages` | `true` | Scrolls the page once before capturing so lazy-loaded images resolve. Disable for speed at the cost of blank placeholders. |
| `scrollDelay` | `120` | Milliseconds to wait per viewport during the preload scroll. Raise to 300–500 on slow-loading sites. |
| `format` | `"png"` | `"png"` is lossless but large; `"jpeg"` can be an order of magnitude smaller. |
| `jpegQuality` | `92` | 1–100, JPEG only. |
| `subfolder` | `"整页截图"` | Download subfolder. Empty string saves to the Downloads root. |

Reload the extension from `chrome://extensions` after editing.

## Limitations

**A "debugging this browser" banner appears while capturing.** Chrome mandates this notice for any extension holding the `debugger` permission. It disappears when the capture finishes. Suppressing it requires launching Chrome with `--silent-debugger-extension-api`, which is rarely worth changing your startup flags for.

**Pages taller than 16384px get truncated.** That is Chrome's maximum texture dimension, not something an extension can work around. DevTools has the same ceiling. The badge shows `!` when this happens.

**Internal pages can't be captured.** `chrome://*`, the Web Store, and other privileged pages are off-limits to extensions by design.

**Virtualised lists only capture what's in the DOM.** Infinite-scroll feeds and windowed tables destroy off-screen rows as you scroll, so those rows were never rendered and cannot be photographed. No screenshot tool solves this in general.

## A note on publishing to the Chrome Web Store

The `debugger` permission draws manual review and long turnaround. If you intend to list this publicly, expect to justify the permission in your listing and to document why viewport stitching wasn't sufficient. Loading unpacked, or distributing the zip from Releases, avoids the process entirely.

## Prior art worth knowing

Firefox ships this natively: right-click → Take Screenshot → Save full page. Edge does too: `Ctrl+Shift+S` → Capture full page. This extension exists because Chrome is the one that buries it in DevTools.

## License

MIT — see [LICENSE](LICENSE).
