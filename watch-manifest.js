import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildManifest } from "./build-manifest.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const audioDir = path.join(__dirname, "audio");

if (!fs.existsSync(audioDir)) {
  fs.mkdirSync(audioDir, { recursive: true });
}

let timer = null;
let building = false;

function runBuild(reason = "") {
  if (building) {
    return;
  }

  building = true;
  try {
    const result = buildManifest({ verbose: false });
    const state = result.changed ? "已更新" : "无变化";
    const reasonLabel = reason ? `，触发：${reason}` : "";
    console.log(`[manifest] ${state}（${result.files.length} 个音频）${reasonLabel}`);
  } catch (error) {
    console.error("[manifest] 更新失败：", error);
  } finally {
    building = false;
  }
}

function queueBuild(reason = "") {
  if (timer) {
    clearTimeout(timer);
  }

  timer = setTimeout(() => {
    timer = null;
    runBuild(reason);
  }, 180);
}

runBuild("启动初始化");
console.log(`[manifest] 正在监听：${audioDir}`);

fs.watch(audioDir, { persistent: true }, (eventType, filename) => {
  const name = filename ? String(filename) : "";
  if (name === "manifest.js") {
    return;
  }

  queueBuild(`${eventType}${name ? `:${name}` : ""}`);
});
