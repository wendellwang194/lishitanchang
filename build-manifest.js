import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const audioDir = path.join(__dirname, "audio");
const manifestPath = path.join(audioDir, "manifest.js");
const supportedExt = new Set([
  ".mp3",
  ".wav",
  ".ogg",
  ".m4a",
  ".aac",
  ".flac",
  ".webm"
]);

export function buildManifest({ verbose = true } = {}) {
  if (!fs.existsSync(audioDir)) {
    fs.mkdirSync(audioDir, { recursive: true });
  }

  const files = fs
    .readdirSync(audioDir)
    .filter((name) => {
      if (name === "manifest.js") {
        return false;
      }

      const fullPath = path.join(audioDir, name);
      if (!fs.statSync(fullPath).isFile()) {
        return false;
      }

      return supportedExt.has(path.extname(name).toLowerCase());
    })
    .sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));

  const content = `// 由 build-manifest.js 自动生成。\n// 添加或删除音频后，请重新运行：node build-manifest.js\nwindow.AUDIO_FILES = ${JSON.stringify(files, null, 2)};\n`;

  const previous = fs.existsSync(manifestPath) ? fs.readFileSync(manifestPath, "utf8") : "";
  const changed = previous !== content;

  if (changed) {
    fs.writeFileSync(manifestPath, content, "utf8");
  }

  if (verbose) {
    if (changed) {
      console.log(`manifest 已更新，共 ${files.length} 个音频文件。`);
    } else {
      console.log(`manifest 无变化，共 ${files.length} 个音频文件。`);
    }
  }

  return {
    files,
    changed,
    manifestPath,
    audioDir
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  buildManifest({ verbose: true });
}
