import { AvatarRuntime, type PhonemeKey } from "../runtime/AvatarRuntime.js";
import type {
  EffectName,
  Emotion,
  Gaze,
  Motion,
  PropName,
  SceneBackground,
  SceneMood,
} from "../types/index.js";

// declared early so the runtime onError callback can use it
const wsStatusEl = () => document.querySelector<HTMLSpanElement>("#ws-status");
function setStatus(text: string, kind: "" | "ok" | "err" = ""): void {
  const el = wsStatusEl();
  if (!el) return;
  el.textContent = text;
  el.classList.remove("ok", "err");
  if (kind) el.classList.add(kind);
}

const avatar = new AvatarRuntime({
  container: "#app",
  template: "cartoon-default",
  width: 640,
  height: 640,
  autoConnect: false,
  onError: (e, detail) => {
    console.warn("[demo] runtime error", e, detail);
    setStatus(e === "WEBSOCKET_DISCONNECTED" ? "disconnected" : `err:${e}`, "err");
  },
}).init().start();

// ---------- emotion ----------
let speaking = false;
const setEmotionPressed = (name: string) => {
  document.querySelectorAll<HTMLButtonElement>("[data-emotion]").forEach((b) => {
    b.setAttribute("aria-pressed", b.dataset.emotion === name ? "true" : "false");
  });
};
const setGazePressed = (name: string) => {
  document.querySelectorAll<HTMLButtonElement>("[data-gaze]").forEach((b) => {
    b.setAttribute("aria-pressed", b.dataset.gaze === name ? "true" : "false");
  });
};

document.querySelectorAll<HTMLButtonElement>("[data-emotion]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const e = btn.dataset.emotion as Emotion;
    avatar.update({ emotion: e });
    setEmotionPressed(e);
  });
});
setEmotionPressed("neutral");

document.querySelectorAll<HTMLButtonElement>("[data-gaze]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const g = btn.dataset.gaze as Gaze;
    avatar.update({ gaze: g });
    setGazePressed(g);
  });
});
setGazePressed("center");

// ---------- motion ----------
document.querySelector<HTMLButtonElement>("[data-speaking]")?.addEventListener("click", (ev) => {
  speaking = !speaking;
  avatar.update({ speaking });
  (ev.currentTarget as HTMLButtonElement).setAttribute(
    "aria-pressed",
    speaking ? "true" : "false",
  );
});
document.querySelectorAll<HTMLButtonElement>("[data-motion]").forEach((b) => {
  b.addEventListener("click", () => avatar.update({ motion: b.dataset.motion as Motion }));
});
document
  .querySelectorAll<HTMLButtonElement>("[data-say-phoneme]")
  .forEach((b) => {
    b.addEventListener("click", () =>
      avatar.sayPhoneme(b.dataset.sayPhoneme as PhonemeKey, 1500),
    );
  });

const audioFileInput = document.querySelector<HTMLInputElement>("#audio-file");
const audioPlayBtn = document.querySelector<HTMLButtonElement>("#audio-play");
const audioStopBtn = document.querySelector<HTMLButtonElement>("#audio-stop");
audioPlayBtn?.addEventListener("click", async () => {
  const file = audioFileInput?.files?.[0];
  if (!file) {
    console.warn("[demo] no audio file selected");
    return;
  }
  try {
    await avatar.playAudio(file);
  } catch (e) {
    console.error("[demo] audio play failed", e);
  }
});
audioStopBtn?.addEventListener("click", () => avatar.stopAudio());

const intensity = document.querySelector<HTMLInputElement>("#intensity");
intensity?.addEventListener("input", () => {
  avatar.update({ intensity: Number(intensity.value) });
});

// ---------- props / effects ----------
document.querySelectorAll<HTMLButtonElement>("[data-prop]").forEach((b) => {
  b.addEventListener("click", () => {
    avatar.showProp(b.dataset.prop as PropName, "above_head", 1600);
  });
});
document.querySelectorAll<HTMLButtonElement>("[data-effect]").forEach((b) => {
  b.addEventListener("click", () => avatar.fireEffect(b.dataset.effect as EffectName));
});

// ---------- scene ----------
document.querySelectorAll<HTMLButtonElement>("[data-bg]").forEach((b) => {
  b.addEventListener("click", () => avatar.setScene(b.dataset.bg as SceneBackground, undefined));
});
document.querySelectorAll<HTMLButtonElement>("[data-mood]").forEach((b) => {
  b.addEventListener("click", () => avatar.setScene(undefined, b.dataset.mood as SceneMood));
});

// ---------- bubble ----------
const sayInput = document.querySelector<HTMLInputElement>("#say-text")!;
const sayBtn = document.querySelector<HTMLButtonElement>("#say-btn")!;
sayBtn.addEventListener("click", () => {
  const text = sayInput.value.trim();
  if (!text) return;
  avatar.say(text, 2600);
  // Mouth flap while speaking the bubble
  avatar.update({ speaking: true });
  speaking = true;
  document
    .querySelector<HTMLButtonElement>("[data-speaking]")
    ?.setAttribute("aria-pressed", "true");
  window.setTimeout(() => {
    avatar.update({ speaking: false });
    speaking = false;
    document
      .querySelector<HTMLButtonElement>("[data-speaking]")
      ?.setAttribute("aria-pressed", "false");
  }, 2600);
});

// ---------- websocket ----------
const wsInput = document.querySelector<HTMLInputElement>("#ws-url")!;
const wsBtn = document.querySelector<HTMLButtonElement>("#ws-toggle")!;

let connected = false;
wsBtn.addEventListener("click", () => {
  if (!connected) {
    avatar.connect(wsInput.value.trim());
    connected = true;
    wsBtn.textContent = "disconnect";
    setStatus("connecting…");
    // Optimistic — runtime will report errors via onError
    window.setTimeout(() => {
      if (connected) setStatus("connected", "ok");
    }, 600);
  } else {
    avatar.disconnect();
    connected = false;
    wsBtn.textContent = "connect";
    setStatus("disconnected");
  }
});

// ---------- sprite set / identity ----------
const SPRITE_KEYS = [
  "neutral",
  "happy",
  "sad",
  "angry",
  "surprised",
  "eyes_closed",
] as const;
type SpriteKey = (typeof SPRITE_KEYS)[number];
const TALK_KEY = "exp_open" as const;
type TalkKey = typeof TALK_KEY;
type AnySpriteKey = SpriteKey | TalkKey;

const photoStatus = document.querySelector<HTMLSpanElement>("#photo-status")!;

function setPhotoStatus(text: string, kind: "" | "ok" | "err" = ""): void {
  photoStatus.textContent = text;
  photoStatus.classList.remove("ok", "err");
  if (kind) photoStatus.classList.add(kind);
}

const spriteFiles: Partial<Record<AnySpriteKey, File>> = {};

function refreshSlot(key: AnySpriteKey): void {
  const slot = document.querySelector<HTMLElement>(`.sprite-slot[data-key="${key}"]`);
  if (!slot) return;
  const status = slot.querySelector<HTMLElement>(".slot-status");
  const file = spriteFiles[key];
  if (file) {
    slot.classList.add("filled");
    if (status) status.textContent = file.name;
  } else {
    slot.classList.remove("filled");
    if (status) status.textContent = "未上传";
  }
}

document.querySelectorAll<HTMLInputElement>("[data-sprite]").forEach((input) => {
  input.addEventListener("change", () => {
    const key = input.dataset.sprite as AnySpriteKey;
    const file = input.files?.[0];
    if (file) spriteFiles[key] = file;
    else delete spriteFiles[key];
    refreshSlot(key);
    const filled = SPRITE_KEYS.filter((k) => spriteFiles[k]).length;
    const talkLoaded = !!spriteFiles[TALK_KEY];
    setPhotoStatus(
      filled === SPRITE_KEYS.length
        ? `ready${talkLoaded ? " (+talk)" : ""} — 点击\"加载贴图\"`
        : `${filled} / ${SPRITE_KEYS.length} 已选`,
    );
  });
});

const spriteLoadBtn = document.querySelector<HTMLButtonElement>("#sprite-load")!;
spriteLoadBtn.addEventListener("click", async () => {
  const missing = SPRITE_KEYS.filter((k) => !spriteFiles[k]);
  if (missing.length > 0) {
    setPhotoStatus(`缺少: ${missing.join(", ")}`, "err");
    return;
  }
  spriteLoadBtn.disabled = true;
  setPhotoStatus("detecting landmarks (6 images)…");
  try {
    await avatar.loadSpriteSet(spriteFiles);
    setPhotoStatus("sprite mode (6 expressions)", "ok");
  } catch (e) {
    console.error(e);
    setPhotoStatus(`failed: ${(e as Error).message}`, "err");
  } finally {
    spriteLoadBtn.disabled = false;
  }
});

const spriteResetBtn = document.querySelector<HTMLButtonElement>("#sprite-reset")!;
spriteResetBtn.addEventListener("click", () => {
  avatar.resetToCartoon();
  const allKeys: AnySpriteKey[] = [...SPRITE_KEYS, TALK_KEY];
  for (const key of allKeys) {
    delete spriteFiles[key];
    const input = document.querySelector<HTMLInputElement>(
      `input[data-sprite="${key}"]`,
    );
    if (input) input.value = "";
    refreshSlot(key);
  }
  setPhotoStatus("cartoon mode");
});

// expose for debugging
(window as unknown as { avatar: AvatarRuntime }).avatar = avatar;

// ---------- auto-load default sprites ----------
// On startup, probe /assets/exp01..exp06.png. If all six exist, load
// them automatically so the demo opens ready. Optional adjuncts:
//   exp_a / exp_ee / exp_o — phoneme inspection visemes (say-* tests).
//   exp_open                — talk sprite (production lip-sync).
async function tryAutoLoadSprites(): Promise<void> {
  const map: Record<SpriteKey, string> = {
    neutral: "/assets/exp01.png",
    happy: "/assets/exp02.png",
    sad: "/assets/exp03.png",
    angry: "/assets/exp04.png",
    surprised: "/assets/exp05.png",
    eyes_closed: "/assets/exp06.png",
  };
  const phonemeMap: Record<string, string> = {
    exp_a: "/assets/exp_a.png",
    exp_ee: "/assets/exp_ee.png",
    exp_o: "/assets/exp_o.png",
  };
  const talkUrl = "/assets/exp_open.png";
  // Probe — skip silently if any required file is missing.
  const heads = await Promise.all(
    Object.values(map).map((u) =>
      fetch(u, { method: "HEAD" })
        .then((r) => r.ok)
        .catch(() => false),
    ),
  );
  if (!heads.every(Boolean)) return;
  // Probe phoneme test sprites (partial sets are OK).
  const phonemeHeads = await Promise.all(
    Object.entries(phonemeMap).map(async ([k, u]) => {
      const ok = await fetch(u, { method: "HEAD" })
        .then((r) => r.ok)
        .catch(() => false);
      return [k, ok ? u : null] as const;
    }),
  );
  const phonemeFiles: Record<string, string> = {};
  for (const [k, u] of phonemeHeads) if (u) phonemeFiles[k] = u;
  // Probe talk sprite (independent of phoneme test sprites).
  const talkOk = await fetch(talkUrl, { method: "HEAD" })
    .then((r) => r.ok)
    .catch(() => false);
  const talkFiles: Record<string, string> = talkOk ? { [TALK_KEY]: talkUrl } : {};

  const phonemeCount = Object.keys(phonemeFiles).length;
  const adjuncts: string[] = [];
  if (phonemeCount > 0) adjuncts.push(`${phonemeCount} phoneme`);
  if (talkOk) adjuncts.push("talk");
  setPhotoStatus(
    adjuncts.length > 0
      ? `auto-loading exp01–06 + ${adjuncts.join(", ")}…`
      : "auto-loading exp01–06…",
  );
  spriteLoadBtn.disabled = true;
  try {
    await avatar.loadSpriteSet({ ...map, ...phonemeFiles, ...talkFiles });
    // Visual confirmation in the slots so the user knows what got loaded.
    for (let i = 0; i < SPRITE_KEYS.length; i++) {
      const key = SPRITE_KEYS[i];
      const slot = document.querySelector<HTMLElement>(
        `.sprite-slot[data-key="${key}"]`,
      );
      if (!slot) continue;
      slot.classList.add("filled");
      const status = slot.querySelector<HTMLElement>(".slot-status");
      const idx = String(i + 1).padStart(2, "0");
      if (status) status.textContent = `exp${idx}.png (auto)`;
    }
    if (talkOk) {
      const slot = document.querySelector<HTMLElement>(
        `.sprite-slot[data-key="${TALK_KEY}"]`,
      );
      if (slot) {
        slot.classList.add("filled");
        const status = slot.querySelector<HTMLElement>(".slot-status");
        if (status) status.textContent = `exp_open.png (auto)`;
      }
    }
    const okMsg =
      adjuncts.length > 0
        ? `sprite mode (6 emotion + ${adjuncts.join(" + ")})`
        : "sprite mode (auto-loaded exp01–06)";
    setPhotoStatus(okMsg, "ok");
  } catch (e) {
    console.error("[auto-load]", e);
    setPhotoStatus(`auto-load failed: ${(e as Error).message}`, "err");
  } finally {
    spriteLoadBtn.disabled = false;
  }
}

tryAutoLoadSprites();
