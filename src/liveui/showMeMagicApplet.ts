export function showMeMagicAppletHtml(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Show Me Magic</title>
  <style>
    :root {
      color-scheme: dark;
      --accent: #22d3ee;
      --hot: #f97316;
      --pink: #e879f9;
      --lime: #a3e635;
    }
    * { box-sizing: border-box; }
    html, body {
      width: 100%;
      height: 100%;
      margin: 0;
      overflow: hidden;
      background: #020617;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
      color: white;
      user-select: none;
    }
    body {
      display: grid;
      place-items: center;
    }
    .stage {
      position: relative;
      width: min(100vw, 1280px);
      height: min(100vh, 768px);
      overflow: hidden;
      background:
        radial-gradient(circle at 16% 18%, rgba(34, 211, 238, 0.25), transparent 24%),
        radial-gradient(circle at 82% 16%, rgba(232, 121, 249, 0.23), transparent 26%),
        radial-gradient(circle at 70% 88%, rgba(163, 230, 53, 0.16), transparent 28%),
        linear-gradient(135deg, #020617 0%, #111827 48%, #270a3d 100%);
    }
    .grid {
      position: absolute;
      inset: 0;
      background-image:
        linear-gradient(rgba(148, 163, 184, 0.12) 1px, transparent 1px),
        linear-gradient(90deg, rgba(148, 163, 184, 0.12) 1px, transparent 1px);
      background-size: 54px 54px;
      mask-image: radial-gradient(circle at center, black, transparent 76%);
      animation: drift 9s linear infinite;
    }
    @keyframes drift {
      to { transform: translate3d(54px, 54px, 0); }
    }
    .copy {
      position: absolute;
      left: 46px;
      top: 42px;
      z-index: 4;
      max-width: 420px;
    }
    h1 {
      margin: 0;
      font-size: 54px;
      line-height: 0.96;
      letter-spacing: 0;
    }
    .copy p {
      margin: 16px 0 0;
      color: rgba(226, 232, 240, 0.78);
      font-size: 17px;
      line-height: 1.55;
    }
    .panel {
      position: absolute;
      left: 46px;
      bottom: 42px;
      z-index: 5;
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 12px;
      border: 1px solid rgba(148, 163, 184, 0.22);
      border-radius: 8px;
      background: rgba(15, 23, 42, 0.72);
      box-shadow: 0 18px 60px rgba(0, 0, 0, 0.38);
      backdrop-filter: blur(14px);
    }
    button {
      height: 44px;
      min-width: 112px;
      border: 0;
      border-radius: 8px;
      padding: 0 16px;
      color: #031018;
      background: linear-gradient(135deg, var(--accent), var(--lime));
      font: 800 14px/1 system-ui, sans-serif;
      cursor: pointer;
      box-shadow: 0 10px 28px rgba(34, 211, 238, 0.24);
    }
    button:active { transform: translateY(1px); }
    .metric {
      min-width: 108px;
      color: rgba(226, 232, 240, 0.88);
      font-size: 13px;
      line-height: 1.2;
    }
    .metric strong {
      display: block;
      color: white;
      font-size: 20px;
      line-height: 1.1;
    }
    svg {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
    }
    .ring { transform-origin: 640px 384px; }
    .ring.one { animation: spin 18s linear infinite; }
    .ring.two { animation: spinReverse 24s linear infinite; }
    .ring.three { animation: pulseSpin 12s ease-in-out infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    @keyframes spinReverse { to { transform: rotate(-360deg); } }
    @keyframes pulseSpin {
      0%, 100% { transform: rotate(0deg) scale(0.96); opacity: 0.82; }
      50% { transform: rotate(180deg) scale(1.04); opacity: 1; }
    }
    .beam {
      transform-origin: 640px 384px;
      animation: sweep 5s ease-in-out infinite alternate;
      mix-blend-mode: screen;
    }
    @keyframes sweep {
      from { transform: rotate(-22deg); opacity: 0.18; }
      to { transform: rotate(34deg); opacity: 0.44; }
    }
    .orb {
      filter: drop-shadow(0 0 24px rgba(34, 211, 238, 0.65));
      transform-origin: center;
      animation: float 3.4s ease-in-out infinite;
    }
    @keyframes float {
      0%, 100% { transform: translateY(-10px); }
      50% { transform: translateY(12px); }
    }
    .spark { animation: spark 1.8s ease-in-out infinite; }
    .spark:nth-of-type(2n) { animation-delay: -0.55s; }
    .spark:nth-of-type(3n) { animation-delay: -1.1s; }
    @keyframes spark {
      0%, 100% { opacity: 0.2; transform: scale(0.72); }
      50% { opacity: 1; transform: scale(1.12); }
    }
    .cursor {
      position: absolute;
      z-index: 6;
      left: 50%;
      top: 50%;
      width: 120px;
      height: 120px;
      margin: -60px 0 0 -60px;
      border-radius: 999px;
      border: 1px solid rgba(255, 255, 255, 0.22);
      background: radial-gradient(circle, rgba(255, 255, 255, 0.28), rgba(34, 211, 238, 0.12) 42%, transparent 68%);
      pointer-events: none;
      transition: transform 0.12s ease;
      mix-blend-mode: screen;
    }
    .toast {
      position: absolute;
      right: 38px;
      top: 36px;
      z-index: 7;
      width: 310px;
      padding: 14px 16px;
      border: 1px solid rgba(34, 211, 238, 0.28);
      border-radius: 8px;
      background: rgba(2, 6, 23, 0.76);
      color: rgba(226, 232, 240, 0.9);
      font-size: 14px;
      line-height: 1.45;
      opacity: 0;
      transform: translateY(-10px);
      transition: opacity 0.24s ease, transform 0.24s ease;
    }
    .toast.show {
      opacity: 1;
      transform: translateY(0);
    }
  </style>
</head>
<body>
  <main class="stage" id="stage">
    <div class="grid"></div>
    <section class="copy">
      <h1>Show Me<br>Magic</h1>
      <p>官方 H5 验机页面：SVG 矢量动画、CSS 动效、点击事件、指针追踪和 applet → agent 事件桥。</p>
    </section>
    <svg viewBox="0 0 1280 768" role="img" aria-label="animated magic test scene">
      <defs>
        <linearGradient id="cyanPink" x1="0" x2="1" y1="0" y2="1">
          <stop offset="0" stop-color="#22d3ee"/>
          <stop offset="0.52" stop-color="#818cf8"/>
          <stop offset="1" stop-color="#e879f9"/>
        </linearGradient>
        <linearGradient id="limeFire" x1="0" x2="1">
          <stop offset="0" stop-color="#a3e635"/>
          <stop offset="1" stop-color="#f97316"/>
        </linearGradient>
        <filter id="glow" x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur stdDeviation="8" result="blur"/>
          <feMerge>
            <feMergeNode in="blur"/>
            <feMergeNode in="SourceGraphic"/>
          </feMerge>
        </filter>
      </defs>
      <g class="beam">
        <path d="M640 384 L1120 90 A590 590 0 0 1 1160 680 Z" fill="url(#cyanPink)" opacity="0.28"/>
      </g>
      <g class="ring one" fill="none" stroke="url(#cyanPink)" stroke-width="3" filter="url(#glow)">
        <circle cx="640" cy="384" r="210" stroke-dasharray="80 22"/>
        <circle cx="640" cy="384" r="288" stroke-dasharray="18 26"/>
      </g>
      <g class="ring two" fill="none" stroke="url(#limeFire)" stroke-width="5" opacity="0.78">
        <circle cx="640" cy="384" r="246" stroke-dasharray="34 18"/>
        <path d="M394 384 A246 246 0 0 1 886 384" stroke-linecap="round"/>
      </g>
      <g class="ring three" fill="none" stroke="#fff" stroke-width="1.5" opacity="0.72">
        <polygon points="640,150 843,267 843,501 640,618 437,501 437,267"/>
        <polygon points="640,210 791,297 791,471 640,558 489,471 489,297"/>
      </g>
      <g class="orb">
        <circle cx="640" cy="384" r="82" fill="rgba(34,211,238,0.14)" stroke="rgba(255,255,255,0.36)" stroke-width="2"/>
        <circle cx="640" cy="384" r="46" fill="url(#cyanPink)" filter="url(#glow)"/>
        <circle cx="622" cy="366" r="12" fill="#fff" opacity="0.82"/>
      </g>
      <g fill="#fff" filter="url(#glow)">
        <circle class="spark" cx="268" cy="196" r="4"/>
        <circle class="spark" cx="982" cy="188" r="5"/>
        <circle class="spark" cx="1070" cy="518" r="3"/>
        <circle class="spark" cx="372" cy="604" r="5"/>
        <circle class="spark" cx="790" cy="120" r="3"/>
        <circle class="spark" cx="514" cy="156" r="4"/>
        <circle class="spark" cx="1016" cy="636" r="4"/>
        <circle class="spark" cx="244" cy="460" r="3"/>
      </g>
    </svg>
    <div class="cursor" id="cursor"></div>
    <aside class="toast" id="toast">事件桥已就绪。</aside>
    <section class="panel">
      <button id="burst" type="button">触发魔法</button>
      <button id="ping" type="button">发送事件</button>
      <div class="metric">点击次数<strong id="clicks">0</strong></div>
      <div class="metric">指针坐标<strong id="coords">640,384</strong></div>
    </section>
  </main>
  <script>
    (() => {
      const stage = document.getElementById('stage');
      const cursor = document.getElementById('cursor');
      const clicks = document.getElementById('clicks');
      const coords = document.getElementById('coords');
      const toast = document.getElementById('toast');
      let count = 0;
      let toastTimer = 0;
      const emit = (event, payload) => {
        if (window.__LINKYUN_APPLET__ && window.__LINKYUN_APPLET__.emit) {
          window.__LINKYUN_APPLET__.emit(event, payload);
        } else {
          window.parent.postMessage({ type: 'APP_EVENT', event, payload }, '*');
        }
      };
      const show = (text) => {
        toast.textContent = text;
        toast.classList.add('show');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => toast.classList.remove('show'), 1600);
      };
      stage.addEventListener('pointermove', (ev) => {
        const rect = stage.getBoundingClientRect();
        const x = Math.round((ev.clientX - rect.left) / rect.width * 1280);
        const y = Math.round((ev.clientY - rect.top) / rect.height * 768);
        coords.textContent = x + ',' + y;
        cursor.style.left = (ev.clientX - rect.left) + 'px';
        cursor.style.top = (ev.clientY - rect.top) + 'px';
      });
      document.getElementById('burst').addEventListener('click', () => {
        count += 1;
        clicks.textContent = String(count);
        stage.style.setProperty('--accent', count % 2 ? '#f97316' : '#22d3ee');
        stage.animate([
          { filter: 'saturate(1) brightness(1)' },
          { filter: 'saturate(1.8) brightness(1.25)' },
          { filter: 'saturate(1) brightness(1)' }
        ], { duration: 520, easing: 'ease-out' });
        emit('magic_burst', { count });
        show('magic_burst 已发送');
      });
      document.getElementById('ping').addEventListener('click', () => {
        emit('manual_ping', { at: new Date().toISOString(), count });
        show('manual_ping 已发送');
      });
      window.addEventListener('linkyun:state-patch', (ev) => {
        show('收到 state patch: ' + String(ev.detail).slice(0, 48));
      });
      emit('magic_loaded', { size: '1280x768' });
    })();
  </script>
</body>
</html>`
}
