/* screens_c — Menus: design language sheet (0), pause/settings (9), main menu (10), key bindings (11/K) */
(function () {
  const T = window.TTZ, esc = T.esc, K = (k, dim) => T.key(k, dim);
  const NEW = '<span class="tag brass kb-new">NEW</span>';

  /* =========================== 0 · DESIGN LANGUAGE =========================== */
  const SW = [
    ["--plate", "rgba(27,31,21,.86)", "Plate fill (day). Night: .90 opaque"],
    ["--plate-solid", "#1e2217", "Tooltips, tag ink, key ink"],
    ["--plate-2", "rgba(44,50,33,.92)", "Cards, inner wells"],
    ["--plate-hi", "#3a4229", "Buttons, dim tags"],
    ["--keyline", "#8e8660", "Hairline + rivets (night #9aa07a)"],
    ["--khaki", "#c2b27c", "Sprue tag, active tab"],
    ["--olive", "#6b7446", "Secondary fills"],
    ["--bone", "#ece5cf", "Primary text, key badge"],
    ["--bone-dim", "#aaa38a", "Labels, secondary text"],
    ["--bone-mute", "#6f6b5a", "Disabled, hints"],
    ["--brass", "#e0a93b", "Funds, cost, selected/active"],
    ["--ok", "#94c75c", "State: good, income, HP high"],
    ["--warn", "#f0a32a", "State: warning, HP mid"],
    ["--bad", "#e5493a", "State: danger, loss, HP low"],
    ["--toxic", "#bfe03a", "State: gas / infection"],
    ["--intel", "#74b9cf", "Info, night, stamina, water"],
  ];
  T.screen({
    id: "design-language", num: 0, badge: "0", group: "Overview", title: "Design language", status: "draft", bg: null,
    notes: `<ul>
<li><b>One sheet = the contract.</b> Every token here maps 1:1 to an ImGui style colour / constant; screens must not invent new colours. State colours (ok / warn / bad / toxic / intel) are <b>only</b> used to signal state, never decoration.</li>
<li><b>Fonts:</b> Allerta Stencil (tags, titles) and Barlow Condensed 400/500/600/700 (all UI text, tabular numbers). Both are <b>SIL OFL</b> — ship the TTFs in <code>assets/fonts/</code> with their OFL.txt and load them with <code>io.Fonts-&gt;AddFontFromFileTTF</code> at 13/15/18 pt × UI scale (rebuild atlas on scale change). No runtime web fonts.</li>
<li>Voxel icons are drawn from box lists with 3 face shades (top 1.08 / right 0.82 / left 0.62) — same routine as <code>drawUiIcon</code>, so the sheet and the game stay in sync.</li>
<li>Pixel glyphs are 7×7 bitmaps, ink + one accent; render at integer multiples only (7, 14, 21 px) to stay crisp.</li>
<li>Owner question: do we want a third, mono-numeric face for big counters, or keep Barlow tabular figures everywhere (current proposal)?</li></ul>`,
    render(ctx) {
      const sw = SW.map(([n, v, r]) => `<div class="dl-sw"><i style="background:${v}"></i><div><b>${n}</b><span>${v}</span><em>${r}</em></div></div>`).join("");
      const ic = T.iconNames.map((n) => `<div class="dl-ic">${T.icon(n, 36)}<span>${n}</span></div>`).join("");
      const gl = T.glyphNames.map((n) => `<div class="dl-gl">${T.glyph(n, 21)}<span>${n}</span></div>`).join("");
      return `<div class="dl scroll">
<div class="dl-head"><span class="tag">Field kit</span><h1>Design language</h1><span class="c-dim">HUD sheet v1 · sizes in UI points (×1.0 720p · ×1.25 1080p · ×1.5 1440p)</span></div>
<div class="dl-grid">
  <section class="plate rivets dl-pal"><div class="ph"><span class="tag">01</span><span class="t">Palette</span><span class="r">token · value · role</span></div><div class="pb dl-sws">${sw}</div></section>
  <section class="plate rivets dl-type"><div class="ph"><span class="tag">02</span><span class="t">Type</span><span class="r">Allerta Stencil · Barlow Condensed (OFL, ship TTF)</span></div><div class="pb">
    <div class="dl-spec"><span class="lbl">Stencil · tag 10pt / title 28pt</span><div><span class="tag">Squads</span> <span class="tag brass">Selected</span> <span class="tag bad">Breach</span> <span class="tag dim">Later</span></div><div class="dl-stencil">NIGHT OF THE MINI DEAD</div></div>
    <div class="dl-spec"><span class="lbl">UI text · Barlow Condensed 500/600</span><div class="dl-ui14">Rifle squad holding Elm Street</div><div class="dl-ui12 c-dim">Secondary 12pt — five riflemen, 60 m range, 30 + 180 rounds.</div></div>
    <div class="dl-spec"><span class="lbl">Numbers · tabular 600</span><div class="dl-num"><span class="money">$3,800</span> <span class="c-ok">+530/min</span> <span>146</span> <span class="c-bad">−2</span> <span>21:40</span></div></div>
  </div></section>
  <section class="plate rivets dl-comp"><div class="ph"><span class="tag">03</span><span class="t">Components</span></div><div class="pb dl-comps">
    <div><span class="lbl">Key badge</span><div>${K("1")} ${K("Tab")} ${K("Ctrl")} ${K("Esc")} ${K("Q", true)} <span class="c-dim">dim = unavailable</span></div></div>
    <div><span class="lbl">Buttons · normal / on / off / danger</span><div class="dl-row">${T.btn("Halt", { glyph: "halt", k: "H" })}${T.btn("Run", { glyph: "run", on: true })}${T.btn("Occupy", { glyph: "occupy", off: true })}${T.btn("Quit", { cls: "danger" })}</div></div>
    <div><span class="lbl">Pips · hp hi / mid / lo · ammo</span><div class="dl-row">${T.pips(9, 10, "var(--hp-hi)")}${T.pips(5, 10, "var(--hp-mid)")}${T.pips(2, 10, "var(--hp-lo)")}${T.pips(6, 10, "var(--ammo)")}</div></div>
    <div><span class="lbl">Bars · stamina / progress</span><div class="dl-row" style="width:200px;flex-direction:column;align-items:stretch;gap:5px">${T.bar(0.7, "var(--stam)")}${T.bar(0.35, "var(--brass)")}</div></div>
    <div><span class="lbl">Plate · chamfer 6pt, keyline inset 2pt, rivets 2×2</span><div class="dl-mini plate rivets"><div class="ph"><span class="tag">Squad 2</span><span class="t">MG squad</span><span class="r">3/3</span></div><div class="pb">${T.pips(8, 10)} <span class="c-dim">holding</span></div></div></div>
  </div></section>
  <section class="plate rivets dl-icons"><div class="ph"><span class="tag">04</span><span class="t">Voxel icons</span><span class="r">TTZ.icon(name, size) · ${T.iconNames.length}</span></div><div class="pb dl-ics">${ic}</div></section>
  <section class="plate rivets dl-glyphs"><div class="ph"><span class="tag">05</span><span class="t">Pixel glyphs</span><span class="r">7×7 · ink + accent · ${T.glyphNames.length}</span></div><div class="pb dl-gls">${gl}</div></section>
</div></div>`;
    },
  });

  /* =========================== 9 · PAUSE / SETTINGS =========================== */
  const BUSES = [["master", "Master"], ["music", "Music"], ["fx", "Effects"], ["voice", "Voices / radio"], ["amb", "Ambience"], ["ui", "UI"]];
  const BINDS = [
    ["Command bar", [["Card 1–7 in active tab", "1 … 7"], ["Next / previous category", "Tab / Shift+Tab"]]],
    ["Squads", [["Select squad n", "Ctrl+1 … 9"], ["Next squad", "."], ["Halt", "H"], ["Garrison", "G"], ["Occupy tower", "O"], ["Cycle pace", "P"]]],
    ["Placement", [["Rotate 15°", "Q / E"], ["Rotate 90°", "T"], ["Finish wall", "Enter"], ["Remove last point", "Backspace"]]],
    ["Camera", [["Pan", "W A S D"], ["Fast pan", "Shift"]]],
    ["System", [["Pause", "Space"], ["Sim speed", "+ / -"], ["Screenshot", "F12"]]],
  ];
  const slider = (id, v, min, max, unit, dis) => {
    const f = (v - min) / (max - min);
    return `<div class="ps-sl${dis ? " dis" : ""}" data-sl="${id}" data-min="${min}" data-max="${max}" data-unit="${unit}"><div class="ps-tr"><i style="width:${f * 100}%"></i><b style="left:${f * 100}%"></b></div><span class="ps-v">${v}${unit}</span></div>`;
  };
  const toggle = (id, on, a = "On", b = "Off") => `<span class="ps-tg" data-tg="${id}">${T.btn(a, { on })}${T.btn(b, { on: !on })}</span>`;
  const choice = (id, opts, cur) => `<span class="ps-tg" data-ch="${id}">${opts.map((o) => `<button class="btn${o === cur ? " on" : ""}" data-v="${esc(o)}">${esc(o)}</button>`).join("")}</span>`;
  const row = (label, ctrl, hint) => `<div class="ps-row"><span class="ps-l">${label}</span><span class="ps-c">${ctrl}</span>${hint ? `<span class="ps-h">${hint}</span>` : ""}</div>`;

  T.screen({
    id: "pause-settings", num: 9, group: "Menus", title: "Pause / settings", status: "draft",
    notes: `<ul>
<li><b>Fixed 640×440 pt panel</b>, scaled only by UI scale; content scrolls inside. The world keeps rendering behind, dimmed + desaturated (in-game: post pass with saturation 0.25, exposure −1.2 EV, and DoF forced to max so the panel reads).</li>
<li><b>Esc never quits.</b> Order: cancel tool → clear selection → open this menu; Esc in here = Resume (try it: Esc toggles). Quit / Restart confirm <b>inside</b> the panel, no modal on top of a modal.</li>
<li>Settings apply live (no Apply button) except Resolution / Window mode, which keep a 10 s "Keep these settings?" revert strip in the panel footer.</li>
<li>UI scale "Auto" = display height / 720 rounded to 0.05, clamped 0.8–1.5; manual range 80–150 %.</li>
<li>Owner questions: is Gore a slider (Off / Reduced / Full) or a toggle? Should Restart keep the same seed? Do we expose sim-speed in here as well as on +/-?</li></ul>`,
    initState: () => ({ open: true, tab: "audio", confirm: null, vol: { master: 80, music: 55, fx: 90, voice: 75, amb: 60, ui: 50 }, mute: { music: false },
      uiScale: "auto", uiPct: 100, win: "Borderless", res: "1920×1080", dof: true, dofStr: 60, dofCentre: true, clouds: true, cshadow: true, shq: "High", rscale: 100, gore: "Full", rebind: 2 }),
    render(ctx) {
      const s = ctx.state;
      const game = T.topBar({ night: ctx.night, time: ctx.night ? "23:10" : "13:25", dayFrac: ctx.night ? 0.95 : 0.55 }) + T.commandBar({ tab: "units" });
      if (!s.open) return `<div class="ps-game">${game}</div><div class="plate sm ps-hint">${K("Esc")} pause menu</div>`;
      const autoScale = (Math.round((ctx.u) * 20) / 20).toFixed(2);
      const TABS = [["resume", "Resume", "Esc"], null, ["audio", "Audio"], ["display", "Display"], ["graphics", "Graphics"], ["controls", "Controls"], null, ["restart", "Restart"], ["quit", "Quit to menu"]];
      const nav = TABS.map((t) => (t ? `<button class="ps-tab${s.tab === t[0] ? " on" : ""}${t[0] === "quit" ? " q" : ""}" data-tab="${t[0]}">${esc(t[1])}${t[2] ? K(t[2]) : ""}</button>` : '<span class="ps-sep"></span>')).join("");
      let body = "", head = "";
      if (s.tab === "audio") {
        head = "Audio";
        body = BUSES.map(([id, n]) => {
          const muted = !!s.mute[id];
          return row(n, slider(id, s.vol[id], 0, 100, "%", muted) + `<button class="btn ps-mute${muted ? " on" : ""}" data-mute="${id}">${muted ? "Muted" : "Mute"}</button>`);
        }).join("") + `<div class="ps-note">Voices / radio = squad call-outs and HQ radio. UI = clicks and alerts; alerts stay audible at 0 % Effects.</div>`;
      } else if (s.tab === "display") {
        head = "Display";
        body = row("UI scale", choice("uiScale", ["auto", "manual"], s.uiScale).replace(">auto<", ">Auto<").replace(">manual<", ">Manual<"), s.uiScale === "auto" ? `<span class="c-intel">Auto: ${autoScale} on this display (${ctx.W * ctx.u}×${ctx.H * ctx.u})</span>` : "") +
          row("Manual scale", slider("uiPct", s.uiPct, 80, 150, "%", s.uiScale === "auto")) +
          row("Window mode", choice("win", ["Windowed", "Borderless", "Fullscreen"], s.win)) +
          row("Resolution", choice("res", ["1280×720", "1920×1080", "2560×1440"], s.res), s.win === "Borderless" ? "Borderless uses the desktop resolution" : "");
      } else if (s.tab === "graphics") {
        head = "Graphics";
        body = `<div class="ps-grp"><span class="tag dim">Tilt-shift</span></div>` +
          row("Depth of field", toggle("dof", s.dof)) +
          row("Blur strength", slider("dofStr", s.dofStr, 0, 100, "%", !s.dof)) +
          row("Keep screen centre sharp", toggle("dofCentre", s.dofCentre && s.dof), "Off = focus follows the cursor") +
          `<div class="ps-grp"><span class="tag dim">World</span></div>` +
          row("Clouds", toggle("clouds", s.clouds)) +
          row("Cloud shadows", toggle("cshadow", s.cshadow && s.clouds)) +
          row("Shadow quality", choice("shq", ["Off", "Low", "Medium", "High"], s.shq)) +
          row("Render scale", slider("rscale", s.rscale, 50, 100, "%"), "UI always renders at native") +
          row("Gore", choice("gore", ["Off", "Reduced", "Full"], s.gore));
      } else if (s.tab === "controls") {
        head = "Controls";
        let i = 0;
        body = BINDS.map(([g, list]) => `<div class="ps-grp"><span class="tag dim">${g}</span></div>` + list.map(([a, k]) => {
          const idx = i++, wait = s.rebind === idx;
          return `<div class="ps-row ps-bind${wait ? " wait" : ""}"><span class="ps-l">${a}</span><span class="ps-c">${wait ? '<span class="ps-press">press a key…</span><span class="c-dim">Esc cancels · Del clears</span>' : kbKeys(k)}</span><button class="btn" data-rebind="${idx}">${wait ? "Cancel" : "Rebind"}</button></div>`;
        }).join("")).join("") + `<div class="ps-note">Conflicts flash both rows in --warn; full reference on page K.</div>`;
      } else if (s.tab === "restart" || s.tab === "quit") {
        const q = s.tab === "quit";
        head = q ? "Quit to menu" : "Restart";
        body = `<div class="ps-confirm"><div class="ps-ct">${T.glyph("alert", 21, { color: "var(--warn)", accent: "var(--plate-solid)" })}<div><b>${q ? "Leave this city?" : "Restart from day 1?"}</b><div class="c-dim">${q ? "Progress since the last autosave (04:12 ago) will be lost." : "Same map, new seed. Funds, squads and walls reset."}</div></div></div>
          <div class="ps-cb">${T.btn(q ? "Quit to menu" : "Restart", { cls: "danger", id: "yes" })}${T.btn("Back to game", { id: "resume", k: "Esc" })}</div>
          ${q ? '<div class="ps-note">Main menu has Continue, so this is reversible from the last save. Quit to desktop lives on the main menu only.</div>' : ""}</div>`;
      }
      return `<div class="ps-game">${game}</div><div class="ps-dim"></div>
<div class="plate rivets ps-panel" style="left:${(ctx.W - 640) / 2}px;top:${(ctx.H - 440) / 2}px">
  <div class="ps-side"><div class="ps-title"><span class="tag">Paused</span><div class="ps-sub">Day 3 · ${ctx.night ? "23:10" : "13:25"} · <span class="money">$3,800</span></div></div>${nav}</div>
  <div class="ps-main"><div class="ph"><span class="t">${head}</span><span class="r">${s.tab === "quit" || s.tab === "restart" ? "" : "changes apply live"}</span></div><div class="ps-body scroll">${body}</div></div>
</div>`;
    },
    mount(root, ctx) {
      const s = ctx.state;
      root.querySelectorAll("[data-tab]").forEach((b) => b.addEventListener("click", () => { const t = b.dataset.tab; if (t === "resume") s.open = false; else s.tab = t; ctx.rerender(); }));
      root.querySelector('[data-id="resume"]')?.addEventListener("click", () => { s.open = false; s.tab = "audio"; ctx.rerender(); });
      root.querySelectorAll("[data-mute]").forEach((b) => b.addEventListener("click", () => { s.mute[b.dataset.mute] = !s.mute[b.dataset.mute]; ctx.rerender(); }));
      root.querySelectorAll("[data-tg]").forEach((g) => g.querySelectorAll("button").forEach((b, i) => b.addEventListener("click", () => { s[g.dataset.tg] = i === 0; ctx.rerender(); })));
      root.querySelectorAll("[data-ch]").forEach((g) => g.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => { s[g.dataset.ch] = b.dataset.v; ctx.rerender(); })));
      root.querySelectorAll("[data-rebind]").forEach((b) => b.addEventListener("click", () => { const i = +b.dataset.rebind; s.rebind = s.rebind === i ? -1 : i; ctx.rerender(); }));
      root.querySelectorAll("[data-sl]").forEach((el) => {
        if (el.classList.contains("dis")) return;
        const id = el.dataset.sl, min = +el.dataset.min, max = +el.dataset.max, tr = el.querySelector(".ps-tr");
        const set = (e) => {
          const r = tr.getBoundingClientRect(); const f = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)); const v = Math.round(min + f * (max - min));
          if (s.vol && id in s.vol) s.vol[id] = v; else s[id] = v;
          const ff = (v - min) / (max - min); tr.querySelector("i").style.width = ff * 100 + "%"; tr.querySelector("b").style.left = ff * 100 + "%"; el.querySelector(".ps-v").textContent = v + el.dataset.unit;
        };
        el.addEventListener("pointerdown", (e) => { el.setPointerCapture(e.pointerId); set(e); el.onpointermove = set; });
        el.addEventListener("pointerup", () => { el.onpointermove = null; });
      });
      return (e) => {
        if (e.key === "Escape") { e.preventDefault(); if (s.open && s.tab === "controls" && s.rebind >= 0) s.rebind = -1; else { s.open = !s.open; s.tab = s.open ? s.tab : "audio"; } ctx.rerender(); }
        else if (s.open && s.tab === "controls" && s.rebind >= 0) { e.preventDefault(); s.rebind = -1; ctx.rerender(); }
      };
    },
  });

  /* =========================== 10 · MAIN MENU =========================== */
  T.screen({
    id: "main-menu", num: 10, group: "Menus", title: "Main menu", status: "draft",
    bg: { day: "img/dusk.jpg", night: "img/night.jpg" },
    notes: `<ul>
<li><b>Box-label, not logo splash:</b> the title sits on a plate styled like the end-flap of a model-kit box — kit number, scale "1:300", contents line. Keeps the "living diorama" idea without imitating any existing title screen.</li>
<li>Background is the live city at dusk / night with a heavy vignette and slow camera drift (in-game: a slow orbit of the menu camera, DoF pulled close so the city reads as a miniature).</li>
<li>Only four entries. Continue is the default (Enter); it is hidden, not greyed, when no save exists. Up/Down + Enter work; mouse hover moves the same marker.</li>
<li>Owner questions: is "1:300" the scale we want to claim (voxel people ≈ 6 mm)? Do we need a "Sandbox / Endless" choice under New game, or a single mode for v1? Credits / OFL notice: footer link or inside Settings?</li></ul>`,
    initState: () => ({ sel: 0 }),
    render(ctx) {
      const s = ctx.state, items = [["continue", "Continue", "Day 3 · Elm Street · 04:12 ago"], ["new", "New game", ""], ["settings", "Settings", ""], ["quit", "Quit", ""]];
      const list = items.map(([id, n, sub], i) => `<button class="mm-it${s.sel === i ? " on" : ""}" data-i="${i}"><span class="mm-m">${s.sel === i ? T.glyph("arrow", 10, { color: "var(--brass)" }) : ""}</span><span class="mm-n">${n}</span>${sub ? `<span class="mm-s">${sub}</span>` : ""}${s.sel === i ? `<span class="mm-k">${K("Enter")}</span>` : ""}</button>`).join("");
      const top = Math.round(ctx.H * 0.2);
      return `<div class="mm-vig"></div>
<div class="mm-box plate rivets" style="top:${top}px">
  <div class="mm-strip"><span class="tag">Kit No. 0721</span><span class="mm-scale">1:300</span><span class="mm-strip-r">Urban defence set</span></div>
  <div class="mm-title">TINY TINY<br>ZOMBIES</div>
  <div class="mm-sub"><span class="tag bad">Night of the</span><span class="mm-subt">MINI DEAD</span></div>
  <div class="mm-contents"><span>${T.icon("rifle", 22)}${T.icon("engineer", 22)}${T.icon("wall", 22)}${T.icon("tower", 22)}${T.icon("zombie", 22)}</span><span class="c-dim">Contents: 1 city · ∞ dead · paint not included</span></div>
</div>
<div class="mm-menu" style="top:${top + 242}px">${list}</div>
<div class="mm-foot"><span class="tag dim">v0.4.2-alpha</span><span class="c-dim">build 2026-11-28</span></div>
<div class="mm-hint">${K("↑")}${K("↓")} select · ${K("Enter")} confirm</div>`;
    },
    mount(root, ctx) {
      const s = ctx.state;
      root.querySelectorAll(".mm-it").forEach((b) => b.addEventListener("mouseenter", () => { if (s.sel !== +b.dataset.i) { s.sel = +b.dataset.i; ctx.rerender(); } }));
      return (e) => { if (e.key === "ArrowDown") { s.sel = (s.sel + 1) % 4; ctx.rerender(); e.preventDefault(); } if (e.key === "ArrowUp") { s.sel = (s.sel + 3) % 4; ctx.rerender(); e.preventDefault(); } };
    },
  });

  /* =========================== 11 · KEY BINDINGS =========================== */
  // [action, keys, isNew, note]
  const KB = [
    ["Command bar", "bolt", [
      ["Card in active category", "1 … 7", true, "was Z X C Y U V B N M J K"],
      ["Next category", "Tab", true],
      ["Previous category", "Shift+Tab", true],
      ["Card tooltip", "hover", false],
    ]],
    ["Squads", "troops", [
      ["Select squad n", "Ctrl+1 … 9", true, "was 1–9"],
      ["Add squad to selection", "Shift+Ctrl+1 … 9", true],
      ["Next squad", ".", true],
      ["Select / box select", "LMB", false],
      ["Move / attack", "RMB", false],
      ["Halt", "H", false],
      ["Garrison building", "G", false],
      ["Occupy tower", "O", false],
      ["Cycle pace Auto › Run › Walk", "P", true],
    ]],
    ["Placement", "terr", [
      ["Place", "LMB", false],
      ["Keep placing", "Shift+LMB", false],
      ["Rotate 15°", "Q / E", false],
      ["Rotate 90°", "T", true],
      ["Finish wall", "Enter", false],
      ["Remove last point", "Backspace", true],
      ["Cancel tool", "RMB / Esc", false],
    ]],
    ["Engineering", "gear", [
      ["Clear car (engineers)", "K", false],
      ["Undo build", "Ctrl+Z", false],
    ]],
    ["Camera", "arrow", [
      ["Pan", "W A S D / ← ↑ → ↓", false],
      ["Fast pan", "Shift", false],
      ["Pan (drag)", "RMB drag", false],
      ["Rotate (drag)", "Alt+LMB drag", false],
      ["Turn camera", "Q / E", false, "only when no placement tool is active"],
      ["Zoom", "Wheel", false],
    ]],
    ["System", "pause", [
      ["Back: tool › selection › pause menu", "Esc", true, "never quits (was: quit with nothing selected)"],
      ["Pause", "Space", false],
      ["Sim speed", "+ / -", false],
      ["Screenshot", "F12", false],
      ["Debug overlays", "F1 F2 F3", false],
    ]],
  ];
  const kbKeys = (k) => k.split(" ").map((p) => {
    if (p === "/" || p === "…") return `<span class="kb-or">${p}</span>`;
    if (p === "hover") return '<span class="kb-or">hover</span>';
    if (p === "drag") return '<span class="kb-or">drag</span>';
    if (p === "+" || p === "-") return K(p);
    return p.split("+").map((q) => K(q)).join('<span class="kb-plus">+</span>');
  }).join("");
  T.screen({
    id: "key-bindings", num: 11, badge: "K", group: "Menus", title: "Key bindings", status: "draft",
    bg: { day: "img/street.jpg", night: "img/night.jpg" },
    notes: `<ul>
<li><b>NEW</b> marks a change from the current build. Biggest one: cards move from the scattered Z X C Y U V B N M J K row to <b>1–7 within the active category</b>, so squads move to <b>Ctrl+1–9</b>.</li>
<li><b>Esc is a back button</b>, never a quit: cancel tool → clear selection → pause menu.</li>
<li>Q / E is shared: rotate the ghost while a placement tool is active, otherwise turn the camera. No other key is context-dependent.</li>
<li>Pace on <b>P</b> (cycle Auto › Run › Walk) instead of R / W, which would collide with WASD panning.</li>
<li>Owner questions: keep K for Clear car or move it to a card number like every other Engineering verb? Do we want Ctrl+Shift+1–9 to <i>assign</i> a squad group (classic control groups) or are squads fixed?</li></ul>`,
    render(ctx) {
      const col = (g) => `<section class="plate rivets kb-g"><div class="ph">${T.glyph(g[1], 14)}<span class="tag">${g[0]}</span><span class="r">${g[2].filter((r) => r[2]).length ? g[2].filter((r) => r[2]).length + " new" : ""}</span></div><div class="pb">${g[2].map(([a, k, n, note]) =>
        `<div class="kb-r${n ? " n" : ""}"><span class="kb-a">${esc(a)}${n ? NEW : ""}${note ? `<em>${esc(note)}</em>` : ""}</span><span class="kb-k">${kbKeys(k)}</span></div>`).join("")}</div></section>`;
      return `<div class="kb-dim"></div><div class="kb scroll">
<div class="kb-head"><span class="tag">Reference</span><h1>Key bindings</h1><span class="c-dim">default layout · all rebindable in Pause › Controls</span><span class="kb-legend">${NEW} changed from current build</span></div>
<div class="kb-cols"><div>${col(KB[0])}${col(KB[3])}</div><div>${col(KB[1])}${col(KB[5])}</div><div>${col(KB[2])}${col(KB[4])}</div></div></div>`;
    },
  });
})();
