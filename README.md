# 点击发声网页

## 文件结构

- `index.html`：页面结构
- `style.css`：动画与视觉样式
- `script.js`：点击交互与音频播放逻辑
- `audio/`：存放你的音频文件
- `audio/manifest.js`：音频清单（自动生成）
- `build-manifest.js`：手动扫描 `audio/` 并生成 `manifest.js`
- `watch-manifest.js`：自动监听 `audio/` 并实时更新 `manifest.js`

## 使用方式

### 方式一：手动更新

1. 把音频文件放入 `audio/` 文件夹。
2. 在当前目录运行：

```bash
node build-manifest.js
```

3. 刷新页面。

### 方式二：自动更新（推荐）

在当前目录运行：

```bash
node watch-manifest.js
```

保持这个终端窗口开启。之后你在 `audio/` 内新增、删除、重命名音频文件时，`manifest.js` 会自动更新。

## 注意

- 监听脚本只负责更新清单，不会自动帮你刷新浏览器页面。
- 如果页面看起来没变化，先强制刷新：`Cmd + Shift + R`。
