/* Juice: feedback layer for the preview. The preview re-renders the HUD on every change, so feedback is applied by
   diffing before/after (tokens keep their index on a screen) and drawn on an fx layer that survives re-renders.
   SOUNDS: TEMPORARY PLACEHOLDERS. These WebAudio blips were made by the UI design session for this preview only.
   They are NOT the sound design session's sounds and must ALL be replaced by its approved UI sounds
   (session D). In game, the HUD fires events through D's uiAction hook in HudBar.cpp and plays none of these. */
(function () {
  const J = (TTZ.juice = { sound: true });
  let ac = null;
  function tone(f0, f1, dur, type = "square", vol = 0.05, delay = 0) {
    if (!J.sound) return;
    try {
      ac = ac || new (window.AudioContext || window.webkitAudioContext)();
      const t = ac.currentTime + delay, o = ac.createOscillator(), g = ac.createGain();
      o.type = type; o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(f1, t + dur);
      g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(ac.destination); o.start(t); o.stop(t + dur + 0.02);
    } catch (e) {}
  }
  J.sfx = {
    hover: () => tone(2200, 1800, 0.025, "sine", 0.012),
    press: () => tone(420, 180, 0.06, "square", 0.035),
    on: () => { tone(660, 660, 0.05, "square", 0.03); tone(990, 990, 0.08, "square", 0.03, 0.05); },
    deny: () => { tone(140, 90, 0.16, "sawtooth", 0.05); },
    tab: () => tone(900, 1500, 0.05, "triangle", 0.03),
  };

  let fx = null, hud = null, ctx = null, before = null, target = -1, lastHover = 0;
  const toks = () => [...hud.querySelectorAll(".tok")];

  J.burst = (x, y, col, n = 7) => {
    if (!fx) return;
    const b = document.createElement("div");
    b.className = "burst"; b.style.left = x + "px"; b.style.top = y + "px"; b.style.setProperty("--bc", col);
    let h = `<i class="rg"></i>`;
    for (let i = 0; i < n; i++) { const a = (i / n) * 6.283 + Math.random() * 0.6, d = 16 + Math.random() * 14; h += `<i class="sp" style="--dx:${Math.cos(a) * d}px;--dy:${Math.sin(a) * d}px"></i>`; }
    b.innerHTML = h; fx.appendChild(b); setTimeout(() => b.remove(), 520);
  };
  const toLocal = (cx, cy) => { const r = hud.getBoundingClientRect(), s = ctx.u * ctx.fit; return [(cx - r.left) / s, (cy - r.top) / s]; };
  const centerOf = (el) => { const r = el.getBoundingClientRect(); return toLocal(r.left + r.width / 2, r.top + r.height / 2); };

  // called by the shell
  J.attach = (h, stage) => {
    hud = h; fx = document.createElement("div"); fx.className = "fx"; stage.appendChild(fx);
    hud.addEventListener("pointerdown", (e) => {
      const t = e.target.closest(".tok, .cats button, .mock button");
      TTZ.hideTip(hud);
      if (!t || e.button !== 0) return;
      if (t.classList.contains("tok")) { target = toks().indexOf(t); t.classList.add("press"); }
      const off = t.classList.contains("off") || !!t.closest(".slot.off");
      const [x, y] = centerOf(t);
      if (off) { J.sfx.deny(); J.burst(x, y, "var(--bad)", 0); } else { J.sfx.press(); J.burst(x, y, "var(--gold)"); }
    });
    window.addEventListener("pointerup", () => hud.querySelectorAll(".press").forEach((x) => x.classList.remove("press")));
    hud.addEventListener("pointerover", (e) => {
      const t = e.target.closest(".tok:not(.off)"); if (!t || e.relatedTarget && t.contains(e.relatedTarget)) return;
      const now = performance.now(); if (now - lastHover > 45) { J.sfx.hover(); lastHover = now; }
    });
  };
  // snapshot before a re-render
  J.before = () => {
    if (!hud) return;
    before = {
      on: toks().map((t) => t.classList.contains("on")),
      off: toks().map((t) => t.classList.contains("off")),
      nums: [...hud.querySelectorAll(".res .v, .clock .t, .wc .h, .wc .x")].map((x) => x.textContent),
      tab: hud.querySelector(".dock .cats button.on")?.dataset.tab,
    };
  };
  // after a re-render: newScreen = the screen (or resolution) changed
  J.after = (c, newScreen) => {
    ctx = c;
    if (fx) { fx.style.width = ctx.W + "px"; fx.style.height = ctx.H + "px"; fx.style.transform = `scale(${ctx.u})`; }
    hud.querySelectorAll(".res .r, .clock > *, .dock .slot, .sel .tok").forEach((el) => {
      const sib = [...el.parentElement.children].filter((x) => x.matches(".r, .slot, .tok, .clock > *") || x.querySelector(".tok"));
      el.style.setProperty("--i", Math.max(0, sib.indexOf(el.closest(".slot, .r, .m, .msq") || el)));
    });
    if (newScreen || !before) {
      hud.classList.remove("enter"); void hud.offsetWidth; hud.classList.add("enter");
      clearTimeout(J._t); J._t = setTimeout(() => hud.classList.remove("enter"), 900);
      before = null; target = -1; return;
    }
    const now = toks();
    now.forEach((t, i) => {
      if (t.classList.contains("on") && !before.on[i]) { t.classList.add("pop"); if (i === target) J.sfx.on(); }
    });
    if (target >= 0 && now[target]) {
      const t = now[target];
      if (t.classList.contains("off") || t.closest(".slot.off")) t.classList.add("deny");
      else if (!t.classList.contains("pop")) t.classList.add("hit");
    }
    [...hud.querySelectorAll(".res .v, .clock .t, .wc .h, .wc .x")].forEach((x, i) => { if (before.nums[i] != null && before.nums[i] !== x.textContent) x.classList.add("bump"); });
    const tab = hud.querySelector(".dock .cats button.on")?.dataset.tab;
    if (tab && before.tab && tab !== before.tab) { hud.querySelector(".dock .strip")?.classList.add("swap"); J.sfx.tab(); }
    target = -1; before = null;
  };
  // hotkeys: flash the counter the key belongs to
  J.key = (e) => {
    if (!hud) return;
    let el = null;
    if (/^[1-7]$/.test(e.key) && !e.ctrlKey) el = hud.querySelectorAll(".dock .slot")[+e.key - 1]?.querySelector(".tok");
    else if (e.key === "h" || e.key === "H") el = [...hud.querySelectorAll(".sel .acts .tok")][0];
    if (!el) return;
    const off = el.classList.contains("off") || el.closest(".slot.off");
    el.classList.add(off ? "deny" : "hit");
    const [x, y] = centerOf(el); J.burst(x, y, off ? "var(--bad)" : "var(--gold)", off ? 0 : 7);
    off ? J.sfx.deny() : J.sfx.press();
  };
})();
