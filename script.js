const stage = document.getElementById("stage");
const emptyTip = document.getElementById("emptyTip");
const clearBtn = document.getElementById("clearBtn");
const muteBtn = document.getElementById("muteBtn");

const audioFiles = Array.isArray(window.AUDIO_FILES)
  ? window.AUDIO_FILES.filter((name) => typeof name === "string" && name.trim().length > 0)
  : [];

const PHYSICS = {
  gravity: 1800,
  airDrag: 0.986,
  angularDrag: 0.986,
  sidePadding: 10,
  floorPadding: 10,
  ceilingPadding: 8,
  bounce: 0.08,
  wallBounce: 0.12,
  settleThreshold: 20,
  solverPasses: 7,
  collisionPadding: 0.02,
  friction: 0.54,
  sleepAngularThreshold: 0.035,
  positionCorrectionPercent: 0.58,
  positionCorrectionSlop: 0.12,
  gravityTorqueScale: 0.9
};

const LIMIT = {
  maxStack: 10,
  typeInBaseDelay: 95,
  dissolveDelay: 165,
  lineBreakThreshold: 20
};

const TEXT_COLLIDER = {
  lineHeightScale: 0.86,
  minLineWidth: 10,
  widthScale: 0.88,
  horizontalInset: 3
};

const UPRIGHT = {
  dragSpring: 36,
  dragDamping: 9.4,
  dragMaxAccel: 86,
  dragSwayScale: 0.00018,
  dragSwayLimit: 0.18,
  dragUpsideThreshold: Math.PI / 2,
  dragHeavyTiltThreshold: 1.05,
  dragSnapThreshold: 0.02,
  dragSnapVelocity: 0.12,
  settleTiltThreshold: 0.62,
  settleSpring: 12.5,
  settleDamping: 3.2,
  settleMaxAccel: 26,
  settleSnap: 0.05
};

const colliderCanvas = document.createElement("canvas");
const colliderCtx = colliderCanvas.getContext("2d");

const state = {
  lastIndex: -1,
  pool: [],
  liveEntries: new Set(),
  stackBodies: [],
  activeAudios: new Set(),
  viewport: {
    width: stage.clientWidth,
    height: stage.clientHeight
  },
  rafId: null,
  lastFrameTime: performance.now(),
  bodySerial: 0,
  dissolveRunning: false,
  dissolveGeneration: 0,
  isMuted: false,
  drag: null,
  suppressNextClick: false,
  suppressClickUntil: 0,
  currentPlayback: null,
  clearingInProgress: false
};

if (audioFiles.length === 0) {
  emptyTip.classList.remove("hidden");
}

function buildPool() {
  state.pool = audioFiles.map((_, index) => index);

  for (let i = state.pool.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [state.pool[i], state.pool[j]] = [state.pool[j], state.pool[i]];
  }

  if (state.pool.length > 1 && state.pool[state.pool.length - 1] === state.lastIndex) {
    [state.pool[0], state.pool[state.pool.length - 1]] = [
      state.pool[state.pool.length - 1],
      state.pool[0]
    ];
  }
}

function pickAudioFile() {
  if (audioFiles.length === 0) {
    return null;
  }

  if (state.pool.length === 0) {
    buildPool();
  }

  const index = state.pool.pop();
  state.lastIndex = index;
  return audioFiles[index];
}

function filenameToText(filename) {
  return filename.replace(/\.[^/.]+$/, "");
}

function toAudioSrc(filename) {
  return `audio/${encodeURIComponent(filename).replace(/%2F/g, "/")}`;
}

function formatLyricText(text) {
  const raw = text.trim();
  const rawChars = Array.from(raw);

  if (rawChars.length <= LIMIT.lineBreakThreshold) {
    return raw;
  }

  return raw
    .replace(/([，,。.])/g, "$1\n")
    .replace(/\n{2,}/g, "\n")
    .replace(/\n$/, "");
}

function updateMuteButton() {
  if (!muteBtn) {
    return;
  }

  muteBtn.textContent = state.isMuted ? "解除静音" : "静音";
  muteBtn.setAttribute("aria-label", state.isMuted ? "解除静音" : "静音");
}

function updateClearButtonVisibility() {
  const hasAnyText = state.liveEntries.size > 0 || state.stackBodies.length > 0;

  if (clearBtn) {
    clearBtn.classList.toggle("is-hidden", !hasAnyText);
  }

  stage.classList.toggle("has-content", hasAnyText);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function normalizeAngle(value) {
  let angle = value;
  while (angle > Math.PI) {
    angle -= Math.PI * 2;
  }
  while (angle <= -Math.PI) {
    angle += Math.PI * 2;
  }
  return angle;
}

function dot(a, b) {
  return a.x * b.x + a.y * b.y;
}

function cross(a, b) {
  return a.x * b.y - a.y * b.x;
}

function crossScalarVector(scalar, vec) {
  return {
    x: -scalar * vec.y,
    y: scalar * vec.x
  };
}

function normalize(vec) {
  const len = Math.hypot(vec.x, vec.y);
  if (len < 1e-6) {
    return { x: 0, y: 0 };
  }

  return { x: vec.x / len, y: vec.y / len };
}

function updateViewport() {
  state.viewport.width = stage.clientWidth;
  state.viewport.height = stage.clientHeight;
}

function readComputedLineHeight(style, fontSize) {
  const parsed = Number.parseFloat(style.lineHeight);
  if (Number.isFinite(parsed)) {
    return parsed;
  }

  return fontSize * 1.35;
}

function buildTextColliderGeometry(element, text) {
  const safeText = text && text.length > 0 ? text : " ";
  const style = window.getComputedStyle(element);
  const fontSize = Number.parseFloat(style.fontSize) || 16;
  const lineHeight = readComputedLineHeight(style, fontSize);
  const lines = safeText.split("\n");
  if (!colliderCtx) {
    return {
      width: Math.max(24, element.getBoundingClientRect().width),
      height: Math.max(24, element.getBoundingClientRect().height),
      lineRects: [{ x: 0, y: 0, w: 24, h: 16, weight: 1 }],
      centerOfMass: { x: 0, y: 0 }
    };
  }

  const font = `${style.fontStyle} ${style.fontVariant} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  colliderCtx.font = font;

  const lineWidths = lines.map((line) => {
    const rawWidth = colliderCtx.measureText(line && line.length > 0 ? line : " ").width;
    const scaledWidth = rawWidth * TEXT_COLLIDER.widthScale - TEXT_COLLIDER.horizontalInset * 2;
    return Math.max(TEXT_COLLIDER.minLineWidth, scaledWidth);
  });
  const maxWidth = Math.max(TEXT_COLLIDER.minLineWidth, ...lineWidths);
  const rowHeight = Math.max(8, lineHeight * TEXT_COLLIDER.lineHeightScale);
  const totalHeight = Math.max(rowHeight, lines.length * lineHeight);
  const startY = -totalHeight / 2 + lineHeight / 2;
  const lineRects = [];
  let weightedMass = 0;
  let weightedX = 0;
  let weightedY = 0;

  lines.forEach((line, lineIndex) => {
    const width = lineWidths[lineIndex];
    const charWeight = Math.max(
      1,
      Array.from(line).reduce((sum, char) => sum + (char.trim().length > 0 ? 1 : 0), 0)
    );
    const x = -maxWidth / 2 + width / 2;
    const y = startY + lineIndex * lineHeight;
    const weight = charWeight;

    lineRects.push({
      x,
      y,
      w: width,
      h: rowHeight,
      weight
    });

    weightedMass += weight;
    weightedX += x * weight;
    weightedY += y * weight;
  });

  const centerOfMass =
    weightedMass > 0
      ? {
          x: weightedX / weightedMass,
          y: weightedY / weightedMass
        }
      : { x: 0, y: 0 };

  return {
    width: Math.max(24, maxWidth),
    height: Math.max(24, totalHeight),
    lineRects,
    centerOfMass
  };
}

function updateBodyDimensions(body) {
  const geometry = buildTextColliderGeometry(body.element, body.displayText);
  body.width = geometry.width;
  body.height = geometry.height;
  body.lineRects = geometry.lineRects;
  body.centerOfMass = geometry.centerOfMass;

  const totalWeight = body.lineRects.reduce((sum, rect) => sum + rect.weight, 0);
  body.mass = Math.max(1.4, totalWeight * 0.36);
  body.inverseMass = body.dragging ? 0 : 1 / body.mass;

  let inertia = 0;
  for (const rect of body.lineRects) {
    const ratio = totalWeight > 0 ? rect.weight / totalWeight : 1 / body.lineRects.length;
    const partMass = body.mass * ratio;
    const dx = rect.x;
    const dy = rect.y;
    inertia += partMass * (rect.w * rect.w + rect.h * rect.h) / 12 + partMass * (dx * dx + dy * dy);
  }

  body.inertia = Math.max(1, inertia);
  body.inverseInertia = body.dragging ? 0 : 1 / body.inertia;
}

function clampPointBySize(x, y, width, height) {
  const minX = PHYSICS.sidePadding + width / 2;
  const maxX = state.viewport.width - PHYSICS.sidePadding - width / 2;
  const minY = PHYSICS.ceilingPadding + height / 2;
  const maxY = state.viewport.height - PHYSICS.floorPadding - height / 2;

  return {
    x: clamp(x, minX, maxX),
    y: clamp(y, minY, maxY)
  };
}

function setElementPosition(element, x, y) {
  element.style.left = `${x}px`;
  element.style.top = `${y}px`;
}

function setBodyTransform(body) {
  body.element.style.left = `${body.x}px`;
  body.element.style.top = `${body.y}px`;
  body.element.style.transform = `translate(-50%, -50%) rotate(${body.angle}rad)`;
}

function applyLiveText(entry, text) {
  entry.displayText = text;
  entry.element.textContent = text.length > 0 ? text : " ";
  const rect = entry.element.getBoundingClientRect();
  const fixed = clampPointBySize(entry.x, entry.y, rect.width, rect.height);
  entry.x = fixed.x;
  entry.y = fixed.y;
  setElementPosition(entry.element, entry.x, entry.y);
}

function getTypeDelay(char) {
  if (!char) {
    return LIMIT.typeInBaseDelay;
  }

  if (/[，。！？、,.!?;；：:]/.test(char)) {
    return LIMIT.typeInBaseDelay + 120;
  }

  return LIMIT.typeInBaseDelay;
}

function stopTypewriter(entry) {
  if (entry.typeTimer) {
    clearTimeout(entry.typeTimer);
    entry.typeTimer = null;
  }
}

function completeTypewriter(entry) {
  stopTypewriter(entry);
  entry.typedLength = entry.fullUnits.length;
  applyLiveText(entry, entry.fullText);
}

function runTypewriter(entry) {
  stopTypewriter(entry);

  const step = () => {
    if (entry.released) {
      return;
    }

    if (entry.typedLength >= entry.fullUnits.length) {
      entry.typeTimer = null;
      return;
    }

    entry.typedLength += 1;
    const partial = entry.fullUnits.slice(0, entry.typedLength).join("");
    applyLiveText(entry, partial);

    const nextChar = entry.fullUnits[entry.typedLength] || "";
    entry.typeTimer = setTimeout(step, getTypeDelay(nextChar));
  };

  step();
}

function createLivePhrase(x, y, text) {
  const formattedText = formatLyricText(text);
  const element = document.createElement("div");
  element.className = "phrase phrase-live";
  stage.appendChild(element);

  const entry = {
    id: ++state.bodySerial,
    element,
    x,
    y,
    rawText: text,
    fullText: formattedText,
    fullUnits: Array.from(formattedText),
    displayText: "",
    typedLength: 0,
    typeTimer: null,
    released: false,
    audio: null,
    audioFile: null
  };

  state.liveEntries.add(entry);
  updateClearButtonVisibility();
  applyLiveText(entry, "");
  runTypewriter(entry);

  return entry;
}

function removeLiveEntry(entry) {
  stopTypewriter(entry);
  if (entry.element.isConnected) {
    entry.element.remove();
  }
  state.liveEntries.delete(entry);
  updateClearButtonVisibility();
}

function countStableStack() {
  return state.stackBodies.filter((body) => !body.removing).length;
}

function removeBodyFromStack(body) {
  const index = state.stackBodies.indexOf(body);
  if (index >= 0) {
    state.stackBodies.splice(index, 1);
  }

  if (body.element.isConnected) {
    body.element.remove();
  }

  if (state.drag && state.drag.body === body) {
    state.drag = null;
  }

  updateClearButtonVisibility();
}

function dissolveBody(body, generation) {
  body.removing = true;
  body.element.classList.add("is-dissolving");

  return new Promise((resolve) => {
    if (generation !== state.dissolveGeneration) {
      resolve();
      return;
    }

    if (!body.element.isConnected) {
      resolve();
      return;
    }

    body.element.classList.add("is-expiring");
    body.element.style.setProperty("--expire-rotate", `${body.angle || 0}rad`);

    let finished = false;
    const finalize = () => {
      if (finished) {
        return;
      }
      finished = true;
      body.element.removeEventListener("animationend", finalize);
      removeBodyFromStack(body);
      resolve();
    };

    body.element.addEventListener("animationend", finalize, { once: true });
    setTimeout(finalize, 360);
  });
}

async function enforceStackLimit() {
  if (state.dissolveRunning) {
    return;
  }

  if (countStableStack() <= LIMIT.maxStack) {
    return;
  }

  state.dissolveRunning = true;
  const generation = state.dissolveGeneration;

  while (generation === state.dissolveGeneration && countStableStack() > LIMIT.maxStack) {
    const oldest = state.stackBodies
      .filter((body) => !body.removing)
      .sort((a, b) => a.createdAt - b.createdAt)[0];

    if (!oldest) {
      break;
    }

    // eslint-disable-next-line no-await-in-loop
    await dissolveBody(oldest, generation);
  }

  state.dissolveRunning = false;
}

function releaseToStack(entry) {
  if (entry.released) {
    return;
  }

  entry.released = true;
  completeTypewriter(entry);
  entry.element.classList.remove("phrase-live");
  entry.element.classList.add("stack-block");
  entry.element.dataset.bodyId = String(entry.id);

  const body = {
    id: entry.id,
    createdAt: performance.now(),
    element: entry.element,
    rawText: entry.rawText,
    displayText: entry.fullText,
    width: 0,
    height: 0,
    lineRects: [],
    centerOfMass: { x: 0, y: 0 },
    x: entry.x,
    y: entry.y,
    vx: (Math.random() - 0.5) * 120,
    vy: Math.max(60, Math.random() * 120),
    angle: (Math.random() - 0.5) * 0.08,
    angularVelocity: (Math.random() - 0.5) * 0.22,
    mass: 1,
    inverseMass: 1,
    inertia: 1,
    inverseInertia: 1,
    uprightAssist: false,
    removing: false,
    dragging: false,
    audioFile: entry.audioFile || null
  };

  state.stackBodies.push(body);
  state.liveEntries.delete(entry);
  updateBodyDimensions(body);
  setBodyTransform(body);
  updateClearButtonVisibility();

  enforceStackLimit();
}

function cleanupAudio(audio) {
  audio.onended = null;
  audio.onerror = null;
  state.activeAudios.delete(audio);
  if (state.currentPlayback && state.currentPlayback.audio === audio) {
    state.currentPlayback = null;
  }
}

function getPlaybackPriority(kind) {
  return kind === "click" ? 2 : 1;
}

function canReplacePlayback(nextKind) {
  if (!state.currentPlayback || !state.currentPlayback.audio) {
    return true;
  }

  const currentPriority = getPlaybackPriority(state.currentPlayback.kind);
  const nextPriority = getPlaybackPriority(nextKind);
  if (nextPriority > currentPriority) {
    return true;
  }
  if (nextPriority < currentPriority) {
    return false;
  }

  return true;
}

function stopPlaybackObject(playback, resetTime = false) {
  if (!playback || !playback.audio) {
    return;
  }

  const { audio } = playback;
  audio.onended = null;
  audio.onerror = null;
  audio.pause();
  if (resetTime) {
    audio.currentTime = 0;
  }
  cleanupAudio(audio);
}

function stopCurrentPlayback(resetTime = false) {
  if (!state.currentPlayback || !state.currentPlayback.audio) {
    return;
  }

  stopPlaybackObject(state.currentPlayback, resetTime);
  state.currentPlayback = null;
}

function startManagedPlayback(audio, kind, onFinish) {
  if (!audio) {
    return false;
  }

  if (!canReplacePlayback(kind)) {
    return false;
  }

  stopCurrentPlayback(false);

  const playback = {
    audio,
    kind
  };
  state.currentPlayback = playback;
  state.activeAudios.add(audio);
  audio.muted = state.isMuted;

  let finished = false;
  const finalize = () => {
    if (finished) {
      return;
    }
    finished = true;
    if (state.currentPlayback === playback) {
      state.currentPlayback = null;
    }
    cleanupAudio(audio);
    if (typeof onFinish === "function") {
      onFinish();
    }
  };

  audio.onended = finalize;
  audio.onerror = finalize;
  audio.play().catch(finalize);
  return true;
}

function dropLiveEntryNow(entry) {
  if (!entry || entry.released) {
    return;
  }

  if (entry.audio) {
    if (state.currentPlayback && state.currentPlayback.audio === entry.audio) {
      stopCurrentPlayback(false);
    } else {
      entry.audio.pause();
      cleanupAudio(entry.audio);
    }
    entry.audio = null;
  }

  releaseToStack(entry);
}

function stopPreviousLivePlayback() {
  const pendingEntries = [...state.liveEntries].filter((entry) => !entry.released);
  for (const entry of pendingEntries) {
    dropLiveEntryNow(entry);
  }

  stopCurrentPlayback(false);
}

function playWithPhrase(filename, x, y) {
  const text = filenameToText(filename);
  const liveEntry = createLivePhrase(x, y, text);
  liveEntry.audioFile = filename;

  const audio = new Audio(toAudioSrc(filename));
  audio.preload = "auto";
  liveEntry.audio = audio;

  const finish = () => {
    liveEntry.audio = null;
    releaseToStack(liveEntry);
  };
  const started = startManagedPlayback(audio, "click", finish);
  if (!started) {
    removeLiveEntry(liveEntry);
    audio.pause();
    cleanupAudio(audio);
  }
}

function resolveBoundaries(body) {
  const floorY = state.viewport.height - PHYSICS.floorPadding;
  const leftX = PHYSICS.sidePadding;
  const rightX = state.viewport.width - PHYSICS.sidePadding;
  const ceilingY = PHYSICS.ceilingPadding;

  const worldRects = body.lineRects.map((lineRect) => getWorldLineRect(body, lineRect));
  for (const worldRect of worldRects) {
    for (const corner of worldRect.corners) {
      if (corner.y > floorY) {
        resolvePlaneContact(body, corner, { x: 0, y: -1 }, corner.y - floorY, PHYSICS.bounce);
      }

      if (corner.x < leftX) {
        resolvePlaneContact(body, corner, { x: 1, y: 0 }, leftX - corner.x, PHYSICS.wallBounce);
      }

      if (corner.x > rightX) {
        resolvePlaneContact(body, corner, { x: -1, y: 0 }, corner.x - rightX, PHYSICS.wallBounce);
      }

      if (corner.y < ceilingY) {
        resolvePlaneContact(body, corner, { x: 0, y: 1 }, ceilingY - corner.y, PHYSICS.wallBounce);
      }
    }
  }
}

function getWorldLineRect(body, rect) {
  const cos = Math.cos(body.angle);
  const sin = Math.sin(body.angle);
  const cx = body.x + rect.x * cos - rect.y * sin;
  const cy = body.y + rect.x * sin + rect.y * cos;
  const axisX = { x: cos, y: sin };
  const axisY = { x: -sin, y: cos };
  const halfW = rect.w / 2;
  const halfH = rect.h / 2;

  return {
    cx,
    cy,
    axisX,
    axisY,
    halfW,
    halfH,
    corners: [
      {
        x: cx + axisX.x * halfW + axisY.x * halfH,
        y: cy + axisX.y * halfW + axisY.y * halfH
      },
      {
        x: cx - axisX.x * halfW + axisY.x * halfH,
        y: cy - axisX.y * halfW + axisY.y * halfH
      },
      {
        x: cx - axisX.x * halfW - axisY.x * halfH,
        y: cy - axisX.y * halfW - axisY.y * halfH
      },
      {
        x: cx + axisX.x * halfW - axisY.x * halfH,
        y: cy + axisX.y * halfW - axisY.y * halfH
      }
    ]
  };
}

function getBodyAABB(body) {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const rect of body.lineRects) {
    const worldRect = getWorldLineRect(body, rect);
    for (const point of worldRect.corners) {
      minX = Math.min(minX, point.x);
      minY = Math.min(minY, point.y);
      maxX = Math.max(maxX, point.x);
      maxY = Math.max(maxY, point.y);
    }
  }

  return { minX, minY, maxX, maxY };
}

function projectCorners(corners, axis) {
  let min = dot(corners[0], axis);
  let max = min;
  for (let i = 1; i < corners.length; i += 1) {
    const projection = dot(corners[i], axis);
    min = Math.min(min, projection);
    max = Math.max(max, projection);
  }
  return { min, max };
}

function satRectRect(aRect, bRect) {
  const axes = [aRect.axisX, aRect.axisY, bRect.axisX, bRect.axisY];
  let minDepth = Number.POSITIVE_INFINITY;
  let minAxis = null;

  for (const axisRaw of axes) {
    const axis = normalize(axisRaw);
    const projA = projectCorners(aRect.corners, axis);
    const projB = projectCorners(bRect.corners, axis);
    const overlap = Math.min(projA.max, projB.max) - Math.max(projA.min, projB.min);
    if (overlap <= 0) {
      return null;
    }
    if (overlap < minDepth) {
      minDepth = overlap;
      minAxis = axis;
    }
  }

  const direction = {
    x: bRect.cx - aRect.cx,
    y: bRect.cy - aRect.cy
  };
  if (dot(direction, minAxis) < 0) {
    minAxis = { x: -minAxis.x, y: -minAxis.y };
  }

  return {
    normal: minAxis,
    depth: minDepth,
    point: {
      x: (aRect.cx + bRect.cx) / 2,
      y: (aRect.cy + bRect.cy) / 2
    }
  };
}

function computeBestCollision(a, b) {
  const aAABB = getBodyAABB(a);
  const bAABB = getBodyAABB(b);
  if (
    aAABB.maxX < bAABB.minX ||
    bAABB.maxX < aAABB.minX ||
    aAABB.maxY < bAABB.minY ||
    bAABB.maxY < aAABB.minY
  ) {
    return null;
  }

  let bestCollision = null;
  for (const aRectRaw of a.lineRects) {
    const aRect = getWorldLineRect(a, aRectRaw);
    for (const bRectRaw of b.lineRects) {
      const bRect = getWorldLineRect(b, bRectRaw);
      const collision = satRectRect(aRect, bRect);
      if (!collision) {
        continue;
      }

      if (!bestCollision || collision.depth < bestCollision.depth) {
        bestCollision = collision;
      }
    }
  }

  return bestCollision;
}

function velocityAtPoint(body, offset) {
  const angularPart = crossScalarVector(body.angularVelocity, offset);
  return {
    x: body.vx + angularPart.x,
    y: body.vy + angularPart.y
  };
}

function resolvePlaneContact(body, point, normal, penetration, bounce) {
  if (body.dragging) {
    return;
  }

  const correction = penetration * PHYSICS.positionCorrectionPercent;
  body.x += normal.x * correction;
  body.y += normal.y * correction;

  const r = { x: point.x - body.x, y: point.y - body.y };
  const pointVelocity = velocityAtPoint(body, r);
  const vn = dot(pointVelocity, normal);
  if (vn >= 0) {
    return;
  }

  const rCrossN = cross(r, normal);
  const denom = body.inverseMass + rCrossN * rCrossN * body.inverseInertia;
  if (denom <= 0) {
    return;
  }

  const impulseScalar = (-(1 + bounce) * vn) / denom;
  const impulse = {
    x: normal.x * impulseScalar,
    y: normal.y * impulseScalar
  };

  body.vx += impulse.x * body.inverseMass;
  body.vy += impulse.y * body.inverseMass;
  body.angularVelocity += cross(r, impulse) * body.inverseInertia;

  const tangent = normalize({
    x: pointVelocity.x - normal.x * vn,
    y: pointVelocity.y - normal.y * vn
  });
  const tangentVel = dot(pointVelocity, tangent);
  if (Math.abs(tangentVel) > 0.0001) {
    const frictionImpulse = clamp(
      -tangentVel / denom,
      -Math.abs(impulseScalar) * PHYSICS.friction,
      Math.abs(impulseScalar) * PHYSICS.friction
    );
    const frictionVec = {
      x: tangent.x * frictionImpulse,
      y: tangent.y * frictionImpulse
    };
    body.vx += frictionVec.x * body.inverseMass;
    body.vy += frictionVec.y * body.inverseMass;
    body.angularVelocity += cross(r, frictionVec) * body.inverseInertia;
  }
}

function resolveCollisionBetweenBodies(a, b, collision, aKinematic, bKinematic) {
  const invMassA = aKinematic ? 0 : a.inverseMass;
  const invMassB = bKinematic ? 0 : b.inverseMass;
  const invInertiaA = aKinematic ? 0 : a.inverseInertia;
  const invInertiaB = bKinematic ? 0 : b.inverseInertia;
  const invMassSum = invMassA + invMassB;
  if (invMassSum <= 0) {
    return;
  }

  const normal = collision.normal;
  const depth = Math.max(0, collision.depth - PHYSICS.positionCorrectionSlop);
  if (depth > 0) {
    const correction = (depth / invMassSum) * PHYSICS.positionCorrectionPercent;
    a.x -= normal.x * correction * invMassA;
    a.y -= normal.y * correction * invMassA;
    b.x += normal.x * correction * invMassB;
    b.y += normal.y * correction * invMassB;
  }

  const contact = collision.point;
  const ra = { x: contact.x - a.x, y: contact.y - a.y };
  const rb = { x: contact.x - b.x, y: contact.y - b.y };
  const va = velocityAtPoint(a, ra);
  const vb = velocityAtPoint(b, rb);
  const relativeVelocity = {
    x: vb.x - va.x,
    y: vb.y - va.y
  };
  const velAlongNormal = dot(relativeVelocity, normal);
  if (velAlongNormal > 0) {
    return;
  }

  const raCrossN = cross(ra, normal);
  const rbCrossN = cross(rb, normal);
  const denom =
    invMassSum + raCrossN * raCrossN * invInertiaA + rbCrossN * rbCrossN * invInertiaB;
  if (denom <= 0) {
    return;
  }

  const restitution = PHYSICS.bounce;
  const impulseScalar = (-(1 + restitution) * velAlongNormal) / denom;
  const impulse = {
    x: normal.x * impulseScalar,
    y: normal.y * impulseScalar
  };

  if (!aKinematic) {
    a.vx -= impulse.x * invMassA;
    a.vy -= impulse.y * invMassA;
    a.angularVelocity -= cross(ra, impulse) * invInertiaA;
  }

  if (!bKinematic) {
    b.vx += impulse.x * invMassB;
    b.vy += impulse.y * invMassB;
    b.angularVelocity += cross(rb, impulse) * invInertiaB;
  }

  const tangent = normalize({
    x: relativeVelocity.x - normal.x * velAlongNormal,
    y: relativeVelocity.y - normal.y * velAlongNormal
  });
  const tangentSpeed = dot(relativeVelocity, tangent);
  if (Math.abs(tangentSpeed) < 0.0001) {
    return;
  }

  const raCrossT = cross(ra, tangent);
  const rbCrossT = cross(rb, tangent);
  const denomT =
    invMassSum + raCrossT * raCrossT * invInertiaA + rbCrossT * rbCrossT * invInertiaB;
  if (denomT <= 0) {
    return;
  }

  const frictionLimit = Math.abs(impulseScalar) * PHYSICS.friction;
  const jt = clamp(-tangentSpeed / denomT, -frictionLimit, frictionLimit);
  const frictionImpulse = {
    x: tangent.x * jt,
    y: tangent.y * jt
  };

  if (!aKinematic) {
    a.vx -= frictionImpulse.x * invMassA;
    a.vy -= frictionImpulse.y * invMassA;
    a.angularVelocity -= cross(ra, frictionImpulse) * invInertiaA;
  }

  if (!bKinematic) {
    b.vx += frictionImpulse.x * invMassB;
    b.vy += frictionImpulse.y * invMassB;
    b.angularVelocity += cross(rb, frictionImpulse) * invInertiaB;
  }
}

function createGhostFromLiveEntry(entry) {
  const geometry = buildTextColliderGeometry(entry.element, entry.displayText);
  return {
    x: entry.x,
    y: entry.y,
    angle: 0,
    width: geometry.width,
    height: geometry.height,
    lineRects: geometry.lineRects,
    vx: 0,
    vy: 0,
    angularVelocity: 0,
    mass: 1,
    inverseMass: 0,
    inertia: 1,
    inverseInertia: 0
  };
}

function resolveGhostPush(ghost, body) {
  const collision = computeBestCollision(ghost, body);
  if (!collision) {
    return;
  }

  resolveCollisionBetweenBodies(ghost, body, collision, true, body.dragging === true);
}

function resolvePair(a, b) {
  const bestCollision = computeBestCollision(a, b);
  if (!bestCollision) {
    return;
  }

  const aDragging = a.dragging === true;
  const bDragging = b.dragging === true;
  if (aDragging && bDragging) {
    return;
  }

  resolveCollisionBetweenBodies(a, b, bestCollision, aDragging, bDragging);
}

function simulateStack(dt) {
  if (state.stackBodies.length === 0) {
    return;
  }

  const liveGhosts = [];
  if (state.liveEntries.size > 0) {
    for (const entry of state.liveEntries) {
      if (!entry.released) {
        liveGhosts.push(createGhostFromLiveEntry(entry));
      }
    }
  }

  for (const body of state.stackBodies) {
    if (body.dragging) {
      body.vx = 0;
      body.vy = 0;
      body.angularVelocity = 0;
      body.inverseMass = 0;
      body.inverseInertia = 0;
      continue;
    }

    body.inverseMass = body.mass > 0 ? 1 / body.mass : 0;
    body.inverseInertia = body.inertia > 0 ? 1 / body.inertia : 0;

    body.vy += PHYSICS.gravity * dt;
    body.angularVelocity +=
      (PHYSICS.gravity * body.centerOfMass.x * PHYSICS.gravityTorqueScale * body.inverseInertia) * dt;

    body.vx *= PHYSICS.airDrag;
    body.vy *= PHYSICS.airDrag;
    body.angularVelocity *= PHYSICS.angularDrag;

    body.x += body.vx * dt;
    body.y += body.vy * dt;
    body.angle = normalizeAngle(body.angle + body.angularVelocity * dt);

    const angleError = normalizeAngle(body.angle);
    if (body.uprightAssist || Math.abs(angleError) > UPRIGHT.settleTiltThreshold) {
      body.uprightAssist = true;
      const correctionAccel = clamp(
        -angleError * UPRIGHT.settleSpring - body.angularVelocity * UPRIGHT.settleDamping,
        -UPRIGHT.settleMaxAccel,
        UPRIGHT.settleMaxAccel
      );
      body.angularVelocity += correctionAccel * dt;

      if (
        Math.abs(angleError) < UPRIGHT.settleSnap &&
        Math.abs(body.angularVelocity) < PHYSICS.sleepAngularThreshold
      ) {
        body.angle = 0;
        body.angularVelocity = 0;
        body.uprightAssist = false;
      }
    }

    if (
      Math.abs(body.angularVelocity) < PHYSICS.sleepAngularThreshold &&
      Math.abs(body.vy) < PHYSICS.settleThreshold * 0.5
    ) {
      body.angularVelocity *= 0.92;
    }
  }

  for (let pass = 0; pass < PHYSICS.solverPasses; pass += 1) {
    for (const body of state.stackBodies) {
      resolveBoundaries(body);
    }

    if (liveGhosts.length > 0) {
      for (const ghost of liveGhosts) {
        for (const body of state.stackBodies) {
          if (body.removing) {
            continue;
          }
          resolveGhostPush(ghost, body);
        }
      }
    }

    for (let i = 0; i < state.stackBodies.length; i += 1) {
      for (let j = i + 1; j < state.stackBodies.length; j += 1) {
        resolvePair(state.stackBodies[i], state.stackBodies[j]);
      }
    }
  }

  for (const body of state.stackBodies) {
    setBodyTransform(body);
  }
}

function onAnimationFrame(now) {
  const elapsed = Math.min((now - state.lastFrameTime) / 1000, 0.033);
  state.lastFrameTime = now;

  simulateStack(elapsed);
  state.rafId = requestAnimationFrame(onAnimationFrame);
}

function repositionOnResize() {
  const prevWidth = state.viewport.width;
  const prevHeight = state.viewport.height;

  updateViewport();

  const widthRatio = prevWidth > 0 ? state.viewport.width / prevWidth : 1;
  const oldFloor = prevHeight - PHYSICS.floorPadding;
  const newFloor = state.viewport.height - PHYSICS.floorPadding;

  for (const body of state.stackBodies) {
    body.x *= widthRatio;

    const distanceToFloor = oldFloor - body.y;
    body.y = newFloor - distanceToFloor;

    updateBodyDimensions(body);

    const fixed = clampPointBySize(body.x, body.y, body.width, body.height);
    body.x = fixed.x;
    body.y = fixed.y;
    body.vx *= 0.25;
    body.vy = 0;
    body.angularVelocity *= 0.25;
    setBodyTransform(body);
  }

  for (const entry of state.liveEntries) {
    entry.x *= widthRatio;
    entry.y *= prevHeight > 0 ? state.viewport.height / prevHeight : 1;
    applyLiveText(entry, entry.displayText);
  }
}

function stopAllAudio() {
  stopCurrentPlayback(true);
  for (const audio of [...state.activeAudios]) {
    audio.pause();
    audio.currentTime = 0;
    cleanupAudio(audio);
  }
  state.activeAudios.clear();
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function shuffleArray(items) {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

async function clearAllPhrases() {
  if (state.clearingInProgress) {
    return;
  }
  state.clearingInProgress = true;

  clearBtn?.classList.add("is-working");
  state.dissolveGeneration += 1;
  state.dissolveRunning = false;
  state.suppressNextClick = false;
  state.suppressClickUntil = 0;

  if (state.drag && state.drag.body) {
    state.drag.body.dragging = false;
    state.drag.body.element.classList.remove("is-dragging");
  }
  state.drag = null;

  stopAllAudio();

  const liveTargets = [...state.liveEntries];
  const bodyTargets = [...state.stackBodies];
  const clearTargets = shuffleArray([
    ...liveTargets.map((entry) => ({ kind: "live", entry, element: entry.element, angle: 0 })),
    ...bodyTargets.map((body) => ({ kind: "body", body, element: body.element, angle: body.angle || 0 }))
  ]);

  if (clearTargets.length === 0) {
    await sleep(140);
    clearBtn?.classList.remove("is-working");
    state.clearingInProgress = false;
    return;
  }

  const removePromises = clearTargets.map((target, index) => {
    const delay = index * 72 + Math.floor(Math.random() * 42);
    const duration = 280 + Math.floor(Math.random() * 180);

    return new Promise((resolve) => {
      setTimeout(() => {
        const el = target.element;
        if (!el || !el.isConnected) {
          resolve();
          return;
        }

        el.style.setProperty("--clear-duration", `${duration}ms`);
        el.style.setProperty("--clear-rotate", `${target.angle}rad`);
        el.classList.add("is-clearing");

        let finished = false;
        const finalize = () => {
          if (finished) {
            return;
          }
          finished = true;
          el.removeEventListener("animationend", finalize);
          if (target.kind === "live") {
            removeLiveEntry(target.entry);
          } else {
            removeBodyFromStack(target.body);
          }
          resolve();
        };

        el.addEventListener("animationend", finalize, { once: true });
        setTimeout(finalize, duration + 36);
      }, delay);
    });
  });

  await Promise.all(removePromises);

  state.stackBodies = [];
  updateClearButtonVisibility();
  clearBtn?.classList.remove("is-working");
  state.clearingInProgress = false;
}

function toggleMute() {
  state.isMuted = !state.isMuted;

  for (const audio of state.activeAudios) {
    audio.muted = state.isMuted;
  }

  updateMuteButton();
}

function resolveTargetElement(target) {
  if (target instanceof Element) {
    return target;
  }
  if (target && target.parentElement instanceof Element) {
    return target.parentElement;
  }
  return null;
}

function isControlTarget(target) {
  const element = resolveTargetElement(target);
  if (!element) {
    return false;
  }
  return Boolean(element.closest("#clearBtn, #muteBtn"));
}

function isStackBlockTarget(target) {
  const element = resolveTargetElement(target);
  if (!element) {
    return false;
  }
  return Boolean(element.closest(".stack-block"));
}

function findStackBodyByElement(target) {
  const element = resolveTargetElement(target);
  if (!element) {
    return null;
  }

  const block = element.closest(".stack-block");
  if (!block) {
    return null;
  }

  const id = Number(block.dataset.bodyId);
  if (!Number.isFinite(id)) {
    return null;
  }

  return state.stackBodies.find((body) => body.id === id && !body.removing) || null;
}

function playAudioForBody(body) {
  if (!body.audioFile) {
    return;
  }

  const audio = new Audio(toAudioSrc(body.audioFile));
  audio.preload = "auto";
  const started = startManagedPlayback(audio, "drag");
  if (!started) {
    audio.pause();
    audio.src = "";
  }
}

function startBodyDrag(body, point, pointerId = null, touchId = null) {
  body.dragging = true;
  body.vx = 0;
  body.vy = 0;
  body.angularVelocity = 0;
  body.inverseMass = 0;
  body.inverseInertia = 0;
  body.element.classList.add("is-dragging");

  state.drag = {
    body,
    pointerId,
    touchId,
    offsetX: point.x - body.x,
    offsetY: point.y - body.y,
    startX: point.x,
    startY: point.y,
    lastX: point.x,
    lastY: point.y,
    lastTime: performance.now(),
    vx: 0,
    vy: 0,
    angularVelocity: 0,
    moved: false
  };

  state.suppressNextClick = true;
  playAudioForBody(body);
}

function updateDragByPoint(clientX, clientY) {
  if (!state.drag) {
    return;
  }

  const drag = state.drag;
  const body = drag.body;

  const rawX = clientX - drag.offsetX;
  const rawY = clientY - drag.offsetY;
  const fixed = clampPointBySize(rawX, rawY, body.width, body.height);
  body.x = fixed.x;
  body.y = fixed.y;

  const now = performance.now();
  const dt = Math.max(0.001, (now - drag.lastTime) / 1000);
  const instantVX = (clientX - drag.lastX) / dt;
  const instantVY = (clientY - drag.lastY) / dt;
  drag.vx = drag.vx * 0.55 + instantVX * 0.45;
  drag.vy = drag.vy * 0.55 + instantVY * 0.45;

  const normalized = normalizeAngle(body.angle);
  const isUpsideDown = Math.abs(normalized) > UPRIGHT.dragUpsideThreshold;
  const isHeavyTilt = Math.abs(normalized) > UPRIGHT.dragHeavyTiltThreshold;
  const forceUpright = isUpsideDown || isHeavyTilt;
  const swayTarget = clamp(-drag.vx * UPRIGHT.dragSwayScale, -UPRIGHT.dragSwayLimit, UPRIGHT.dragSwayLimit);
  const targetAngle = forceUpright ? 0 : swayTarget;
  const angleError = normalizeAngle(targetAngle - body.angle);
  const angularAccel = clamp(
    angleError * UPRIGHT.dragSpring - drag.angularVelocity * UPRIGHT.dragDamping,
    -UPRIGHT.dragMaxAccel,
    UPRIGHT.dragMaxAccel
  );
  drag.angularVelocity += angularAccel * dt;
  drag.angularVelocity *= 0.88;
  body.angle = normalizeAngle(body.angle + drag.angularVelocity * dt);

  if (
    forceUpright &&
    Math.abs(body.angle) < UPRIGHT.dragSnapThreshold &&
    Math.abs(drag.angularVelocity) < UPRIGHT.dragSnapVelocity
  ) {
    body.angle = 0;
    drag.angularVelocity = 0;
  }

  setBodyTransform(body);

  if (!drag.moved && Math.hypot(clientX - drag.startX, clientY - drag.startY) > 2) {
    drag.moved = true;
  }

  drag.lastX = clientX;
  drag.lastY = clientY;
  drag.lastTime = now;
}

function onStagePointerDown(event) {
  if (state.clearingInProgress) {
    return;
  }

  if (state.drag) {
    return;
  }

  if (event.pointerType === "mouse" && event.button !== 0) {
    return;
  }

  if (isControlTarget(event.target)) {
    return;
  }

  const body = findStackBodyByElement(event.target);
  if (!body) {
    return;
  }

  event.preventDefault();
  if (typeof stage.setPointerCapture === "function" && event.pointerId !== undefined) {
    try {
      stage.setPointerCapture(event.pointerId);
    } catch (error) {
      // Ignore capture errors from unsupported browser states.
    }
  }

  startBodyDrag(
    body,
    {
      x: event.clientX,
      y: event.clientY
    },
    event.pointerId
  );
}

function onStagePointerMove(event) {
  if (!state.drag) {
    return;
  }

  const drag = state.drag;
  if (drag.pointerId !== null && drag.pointerId !== undefined && event.pointerId !== drag.pointerId) {
    return;
  }

  event.preventDefault();
  updateDragByPoint(event.clientX, event.clientY);
}

function finishBodyDrag(cancelled = false) {
  if (!state.drag) {
    return;
  }

  const drag = state.drag;
  const body = drag.body;
  if (drag.pointerId !== null && drag.pointerId !== undefined && typeof stage.releasePointerCapture === "function") {
    try {
      if (stage.hasPointerCapture?.(drag.pointerId)) {
        stage.releasePointerCapture(drag.pointerId);
      }
    } catch (error) {
      // Ignore release errors from unsupported browser states.
    }
  }

  body.dragging = false;
  body.element.classList.remove("is-dragging");

  const releaseScale = cancelled ? 0.12 : 0.42;
  body.vx = clamp(drag.vx * releaseScale, -880, 880);
  body.vy = clamp(drag.vy * releaseScale, -880, 880);
  body.inverseMass = body.mass > 0 ? 1 / body.mass : 0;
  body.inverseInertia = body.inertia > 0 ? 1 / body.inertia : 0;

  const releaseSpin =
    (drag.vx * drag.offsetY - drag.vy * drag.offsetX) /
    Math.max(1600, body.width * body.width + body.height * body.height);
  body.angularVelocity = cancelled
    ? 0
    : clamp(releaseSpin + drag.angularVelocity * 0.85, -4.2, 4.2);
  body.uprightAssist = Math.abs(normalizeAngle(body.angle)) > UPRIGHT.settleTiltThreshold;

  if (Math.abs(body.vx) < 16) {
    body.vx = 0;
  }
  if (Math.abs(body.vy) < 16) {
    body.vy = 0;
  }

  state.drag = null;
  state.suppressNextClick = true;
  state.suppressClickUntil = performance.now() + 520;
}

function onStagePointerUp(event) {
  if (!state.drag) {
    return;
  }

  const drag = state.drag;
  if (drag.pointerId !== null && drag.pointerId !== undefined && event.pointerId !== drag.pointerId) {
    return;
  }

  finishBodyDrag(false);
}

function onStagePointerCancel(event) {
  if (!state.drag) {
    return;
  }

  const drag = state.drag;
  if (drag.pointerId !== null && drag.pointerId !== undefined && event.pointerId !== drag.pointerId) {
    return;
  }

  finishBodyDrag(true);
}

function findTouchById(touchList, touchId) {
  if (!touchList || touchId === null || touchId === undefined) {
    return null;
  }
  for (let i = 0; i < touchList.length; i += 1) {
    if (touchList[i].identifier === touchId) {
      return touchList[i];
    }
  }
  return null;
}

function getPrimaryTouch(event) {
  if (event.touches && event.touches.length > 0) {
    return event.touches[0];
  }
  if (event.changedTouches && event.changedTouches.length > 0) {
    return event.changedTouches[0];
  }
  return null;
}

function onStageTouchStart(event) {
  if (state.clearingInProgress || state.drag) {
    return;
  }

  if (isControlTarget(event.target)) {
    return;
  }

  const body = findStackBodyByElement(event.target);
  if (!body) {
    return;
  }

  const touch = getPrimaryTouch(event);
  if (!touch) {
    return;
  }

  event.preventDefault();
  startBodyDrag(
    body,
    {
      x: touch.clientX,
      y: touch.clientY
    },
    null,
    touch.identifier
  );
}

function onStageTouchMove(event) {
  if (!state.drag || state.drag.touchId === null || state.drag.touchId === undefined) {
    return;
  }

  const touch =
    findTouchById(event.touches, state.drag.touchId) ||
    findTouchById(event.changedTouches, state.drag.touchId);
  if (!touch) {
    return;
  }

  event.preventDefault();
  updateDragByPoint(touch.clientX, touch.clientY);
}

function onStageTouchEnd(event) {
  if (!state.drag || state.drag.touchId === null || state.drag.touchId === undefined) {
    return;
  }

  const touch = findTouchById(event.changedTouches, state.drag.touchId);
  if (!touch) {
    return;
  }

  event.preventDefault();
  finishBodyDrag(false);
}

function onStageTouchCancel(event) {
  if (!state.drag || state.drag.touchId === null || state.drag.touchId === undefined) {
    return;
  }

  const touch = findTouchById(event.changedTouches, state.drag.touchId);
  if (!touch) {
    return;
  }

  event.preventDefault();
  finishBodyDrag(true);
}

stage.addEventListener("click", (event) => {
  if (state.clearingInProgress) {
    return;
  }

  if (state.suppressNextClick) {
    if (performance.now() <= state.suppressClickUntil || state.suppressClickUntil === 0) {
      state.suppressNextClick = false;
      state.suppressClickUntil = 0;
      return;
    }
    state.suppressNextClick = false;
    state.suppressClickUntil = 0;
  }

  if (isControlTarget(event.target)) {
    return;
  }

  if (isStackBlockTarget(event.target)) {
    return;
  }

  const file = pickAudioFile();
  if (!file) {
    return;
  }

  stopPreviousLivePlayback();
  playWithPhrase(file, event.clientX, event.clientY);
});

clearBtn.addEventListener("click", (event) => {
  event.stopPropagation();
  clearAllPhrases();
});

muteBtn.addEventListener("click", (event) => {
  event.stopPropagation();
  toggleMute();
});

stage.addEventListener("pointerdown", onStagePointerDown);
window.addEventListener("pointermove", onStagePointerMove, { passive: false });
window.addEventListener("pointerup", onStagePointerUp);
window.addEventListener("pointercancel", onStagePointerCancel);
stage.addEventListener("touchstart", onStageTouchStart, { passive: false });
window.addEventListener("touchmove", onStageTouchMove, { passive: false });
window.addEventListener("touchend", onStageTouchEnd, { passive: false });
window.addEventListener("touchcancel", onStageTouchCancel, { passive: false });
window.addEventListener("resize", repositionOnResize);

updateViewport();
state.rafId = requestAnimationFrame(onAnimationFrame);
updateMuteButton();
updateClearButtonVisibility();
