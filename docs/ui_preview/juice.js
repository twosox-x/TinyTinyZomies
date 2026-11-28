/* Juice: feedback layer for the preview. The preview re-renders the HUD on every change, so feedback is applied by
   diffing before/after (tokens keep their index on a screen) and drawn on an fx layer that survives re-renders.
   SOUNDS: the sound design session's approved UI sounds (no placeholders left). In game the HUD calls
   ttz::audio::ui(name) / uiAction(); this file only mirrors the same mapping for the preview. */
(function () {
  const J = (TTZ.juice = { sound: true });
  // Approved UI sounds from the sound design session (session D, assets/audio/sfx/ui/*.ogg, converted to mp3 for
  // browsers). Same names as the game uses: ttz::audio::ui("<name>"). Credits: assets/audio/CREDITS.md on that branch.
  const VAR = { ui_hover: 3, ui_select: 3, ui_purchase: 3, ui_refused: 2, ui_tab: 3, ui_pause_open: 1, ui_pause_close: 1 };
  const cache = {};
  function play(name, vol = 0.6) {
    if (!J.sound) return;
    try {
      const n = Math.floor(Math.random() * (VAR[name] || 1));
      const src = `snd/${name}_${n}.mp3`;
      const a = (cache[src] = cache[src] || new Audio(src)).cloneNode();
      a.volume = vol; a.play().catch(() => {});
    } catch (e) {}
  }
  J.sfx = {
    hover: () => play("ui_hover", 0.35),
    press: () => play("ui_select"),
    on: () => play("ui_purchase"),
    deny: () => play("ui_refused"),
    tab: () => play("ui_tab"),
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
