# Full Page Shot

**[简体中文](README.md) · [English](README.en.md)**

一键在 Chrome 里保存整页长图 —— DevTools 本来就能做，只是被埋在 `F12` → `Ctrl+Shift+P` → 搜 "Capture full size screenshot" 这一串操作后面。

## 和别的截图扩展有什么不一样

多数整页截图扩展的做法是：截一屏、滚一段、再截一屏，最后拼起来。这样做的后果是 `position: fixed` 的导航栏会沿着长图重复出现十几次，拼接处还常有错位。

这个不拼。它把 Chrome DevTools Protocol 附加到当前标签页，发一条带 `captureBeyondViewport: true` 的 `Page.captureScreenshot` —— 正是 DevTools 那个命令的底层调用。渲染器一次性合成整页，所以固定元素只出现一次，也没有接缝。

全部代码就是一个 manifest 加约 150 行原生 JavaScript。无构建、无依赖、无打包器。

## 安装

**用发布包**：从 [Releases](../../releases) 下载 zip，解压后：

1. 打开 `chrome://extensions`
2. 打开右上角的**开发者模式**
3. 点**加载未打包的扩展程序**，选中解压出的文件夹

选中的那一层必须直接包含 `manifest.json`。Windows 的「全部解压」有时会多套一层文件夹，那就进到里面那层再选。另外注意，双击 zip 进去浏览只是预览，没有真正解压，Chrome 读不到。

**用源码**：clone 下来直接按同样方式加载，没有需要编译的东西。

```bash
git clone https://github.com/firmamento73/fullpage-shot.git
```

建议点地址栏右边的拼图图标，把它固定到工具栏。

## 使用

点工具栏图标，或按 `Alt+Shift+S`。

图片直接写入 `下载/整页截图/站点名-时间戳.png`，不弹保存对话框。图标角标就是状态：`…` 处理中，`✓` 已保存，`!` 已保存但被截断，`✕` 失败。

改快捷键去 `chrome://extensions/shortcuts`。

## 配置

可调项都在 `background.js` 顶部的 `CONFIG` 里：

| 字段 | 默认值 | 作用 |
| --- | --- | --- |
| `preloadLazyImages` | `true` | 截图前先滚一遍页面，让懒加载图片就位。关掉更快，代价是长图里可能留白。 |
| `scrollDelay` | `120` | 预滚动时每屏等待的毫秒数。加载慢的站点调到 300–500。 |
| `format` | `"png"` | `"png"` 无损但文件大；`"jpeg"` 体积能小一个数量级。 |
| `jpegQuality` | `92` | 1–100，仅 JPEG 生效。 |
| `subfolder` | `"整页截图"` | 下载子目录。留空字符串则存到下载根目录。 |

改完回 `chrome://extensions` 点该扩展的刷新按钮生效。

## 限制

**截图时页面顶部会出现「正在调试此浏览器」的黄条。** 这是 Chrome 对持有 `debugger` 权限的扩展的强制提示，截完自动消失。想彻底关掉只能用 `--silent-debugger-extension-api` 启动 Chrome，一般不值得为此改启动方式。

**超过 16384 像素高的页面会被截断。** 这是 Chrome 单张贴图的尺寸上限，扩展绕不过去，DevTools 自带的功能也是同样的天花板。触发时角标显示 `!`。

**内部页面拍不了。** `chrome://*`、扩展商店等特权页面本就不对扩展开放。

**虚拟滚动的列表只能拍到 DOM 里真实存在的部分。** 无限流和窗口化表格在滚动时会销毁屏幕外的行，那些行根本没被渲染过，自然也拍不到。这个问题没有通用解法。

## 关于上架 Chrome 应用商店

`debugger` 权限会触发人工审核，周期偏长。如果打算公开上架，要准备好在说明里论证为什么需要这个权限、以及为什么滚动拼接方案不够用。走「加载未打包」或者直接分发 Releases 里的 zip 则完全不涉及审核。

## 顺带一提

Firefox 原生就有：右键 → 截屏 → 保存整页。Edge 也有：`Ctrl+Shift+S` → 捕获整页。这个扩展存在的原因是 Chrome 偏偏把它藏在 DevTools 里。

## 许可证

MIT，见 [LICENSE](LICENSE)。
