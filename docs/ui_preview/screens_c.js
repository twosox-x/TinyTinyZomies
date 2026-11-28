/* screens_c (v2): pause + settings, main menu, key bindings, design language. CSS prefix .c2- */
(function () {
  const ic = TTZ.ic, esc = TTZ.esc;
  const K = (...ks) => ks.map((k) => `<span class="k">${esc(k)}</span>`).join(`<i class="c2-plus">+</i>`);
  const OR = (...xs) => xs.join(`<i class="c2-or">/</i>`);
  const getP = (o, p) => p.split(".").reduce((a, k) => a[k], o);
  const setP = (o, p, v) => { const ks = p.split("."), l = ks.pop(); ks.reduce((a, k) => a[k], o)[l] = v; };
  const go = (id, patch) => { const s = TTZ.screens.find((x) => x.id === id); if (s && patch) s._state = Object.assign(s._state || (s.initState ? s.initState() : {}), patch); location.hash = id; };

  /* ================= 8 · Pause and settings ================= */
  const AUDIO = [["master", "Master"], ["music", "Music"], ["fx", "Effects"], ["voice", "Voices / radio"], ["amb", "Ambience"], ["ui", "UI"]];
  const BIND = [
    ["halt", "Halt", "H"], ["pace", "Pace", "P"], ["garrison", "Garrison", "G"], ["occupy", "Occupy tower", "O"], ["burn", "Burn area", "B"],
    ["next", "Next squad", "."], ["rotl", "Rotate left", "Q"], ["rotr", "Rotate right", "E"], ["rot90", "Rotate 90°", "T"],
    ["pause", "Pause", "Space"], ["shot", "Screenshot", "F12"], ["alert", "Latest alert", "Backspace"],
  ];
  const pauseInit = () => ({
    open: true, settings: false, conf: null, focus: 0, rebind: null, scroll: 0, flash: null,
    vol: { master: 80, music: 55, fx: 90, voice: 70, amb: 60, ui: 50 }, mute: {},
    uiAuto: true, ui: 125, win: "borderless",
    dof: true, dofStr: 60, centre: true, clouds: true, cshadow: true, shq: "high", rs: 100, gore: "full",
    keys: Object.fromEntries(BIND.map(([id, , k]) => [id, k])),
  });
  const MENU = [["resume", "Resume"], ["settings", "Settings"], ["restart", "Restart"], ["quit", "Quit to menu"]];
  const CONF = { restart: ["Restart this map? Unsaved progress is lost.", "Restart"], quit: ["Quit to menu? Unsaved progress is lost.", "Quit"] };

  const slider = (s, path, min, max, unit, dis) => {
    const v = getP(s, path), f = (v - min) / (max - min);
    return `<div class="c2-sl${dis ? " dis" : ""}" data-sl="${path}" data-min="${min}" data-max="${max}" data-unit="${unit}"><i style="width:${f * 100}%"></i><b style="left:${f * 100}%"></b></div><span class="c2-v">${v}${unit}</span>`;
  };
  const choice = (s, path, opts) => `<span class="c2-ch">${opts.map(([v, l]) => `<button data-set="${path}" data-val="${esc(JSON.stringify(v))}" class="${getP(s, path) === v ? "on" : ""}">${l}</button>`).join("")}</span>`;
  const onoff = (s, path) => choice(s, path, [[true, "On"], [false, "Off"]]);
  const row = (label, ctl, cls = "") => `<div class="c2-row ${cls}"><span class="c2-lb">${label}</span>${ctl}</div>`;

  const settingsHtml = (s) => {
    let h = `<div class="c2-set"><div class="c2-secnav">${[["audio", "Audio"], ["display", "Display"], ["graphics", "Graphics"], ["controls", "Controls"]].map(([k, l]) => `<button data-sec="${k}">${l}</button>`).join("")}</div><div class="c2-scroll" id="c2scroll">`;
    h += `<h3 id="c2-audio">Audio</h3>` + AUDIO.map(([k, l]) => `<div class="c2-row c2-au${s.mute[k] ? " muted" : ""}"><span class="c2-lb">${l}</span><button class="c2-mu" data-mute="${k}" title="${s.mute[k] ? "Unmute" : "Mute"}">${ic(s.mute[k] ? "speakerOff" : "speaker", 16)}</button>${slider(s, "vol." + k, 0, 100, "", s.mute[k])}</div>`).join("");
    h += `<h3 id="c2-display">Display</h3>` +
      row("UI scale", choice(s, "uiAuto", [[true, "Auto <span class='c2-d'>125%</span>"], [false, "Custom"]])) +
      (s.uiAuto ? "" : `<div class="c2-row c2-sub"><span class="c2-lb"></span>${slider(s, "ui", 80, 150, "%")}</div>`) +
      row("Window", choice(s, "win", [["windowed", "Windowed"], ["borderless", "Borderless"], ["full", "Fullscreen"]]));
    h += `<h3 id="c2-graphics">Graphics</h3>` +
      row("Depth of field", onoff(s, "dof")) +
      (s.dof ? `<div class="c2-row c2-sub"><span class="c2-lb">Strength</span>${slider(s, "dofStr", 0, 100, "")}</div>` + row("Keep centre sharp", onoff(s, "centre"), "c2-sub") : "") +
      row("Clouds", onoff(s, "clouds")) + (s.clouds ? row("Cloud shadows", onoff(s, "cshadow"), "c2-sub") : "") +
      row("Shadows", choice(s, "shq", [["low", "Low"], ["med", "Medium"], ["high", "High"], ["ultra", "Ultra"]])) +
      `<div class="c2-row"><span class="c2-lb">Render scale</span>${slider(s, "rs", 50, 200, "%")}</div>` +
      row("Gore", choice(s, "gore", [["off", "Off"], ["low", "Low"], ["full", "Full"]]));
    h += `<h3 id="c2-controls">Controls</h3>` + BIND.map(([id, l]) => {
      const k = s.keys[id], clash = BIND.find(([o]) => o !== id && s.keys[o] === k);
      const val = s.rebind === id ? `<span class="c2-wait">press a key<span class="c2-d"> · Esc cancels</span></span>` : `<button class="c2-kb" data-bind="${id}" title="Click to rebind">${K(k)}</button>${clash ? `<span class="c2-clash">${ic("alert", 12)}also ${clash[1]}</span>` : ""}`;
      return row(l, `<span class="c2-kv">${val}</span>`, "c2-krow");
    }).join("") + `<div class="c2-row c2-links"><button data-go="keys">All key bindings</button><button data-reset>Reset to defaults</button></div>`;
    return h + `</div></div>`;
  };

  TTZ.screen({
    id: "pause", num: 8, group: "Menus", title: "Pause and settings",
    initState: pauseInit,
    notes: `<b>Pause</b>: Esc pauses. The world goes grey and dark, the HUD stays but faint. No panel: four plain words on a shade that comes in from the left.
<ul><li>Settings open as a second column on the same shade. It is a fixed size; the section names at its top jump inside it and it scrolls on its own.</li>
<li>Click a speaker to mute that channel. Click a key to rebind it; a clash with another action shows in amber.</li>
<li>Restart and Quit ask once, in place, with no pop-up. Esc steps back: rebind, then confirm, then settings, then resume.</li>
<li>Arrow keys and Enter work on the menu words.</li>
<li>Decide: should Restart go back to the start of the map or to the start of the current day?</li></ul>`,
    render(ctx) {
      const s = ctx.state;
      const mock = TTZ.mock([["open", "paused"], ["play", "playing"]], s.open ? "open" : "play", "pz");
      if (!s.open) return TTZ.frame(ctx, s) + mock + (s.flash ? `<div class="fl c2-flash">${s.flash}</div>` : "");
      const top = Math.round((ctx.H - 500) / 2 - 16), left = Math.round(ctx.W * 0.06);
      let h = `<div class="c2-veil"></div><div class="c2-faint">${TTZ.frame(ctx, s, { paused: true })}</div><div class="c2-fade${s.settings ? " wide" : ""}"></div>`;
      h += `<div class="c2-pm" style="left:${left}px;top:${top + 34}px"><div class="c2-paused">${ic("pause", 13)}Paused</div>` +
        MENU.map(([k, l], i) => {
          let item = `<button class="c2-w${(s.settings && k === "settings") || s.conf === k ? " on" : ""}${i === s.focus ? " f" : ""}${(s.settings || s.conf) && !(k === "settings" && s.settings) && s.conf !== k ? " dim" : ""}" data-m="${k}" data-i="${i}">${l}</button>`;
          if (s.conf === k) item += `<div class="c2-conf"><div>${CONF[k][0]}</div><button class="c2-yes" data-yes="${k}">${CONF[k][1]}</button><span class="c2-dot">·</span><button data-no>Cancel</button></div>`;
          return item;
        }).join("") + `</div>`;
      if (s.settings) h += `<div style="position:absolute;left:${left + 250}px;top:${top}px">${settingsHtml(s)}</div>`;
      return h + mock;
    },
    mount(root, ctx) {
      const s = ctx.state;
      root.querySelectorAll("[data-pz]").forEach((b) => b.addEventListener("click", () => { s.open = b.dataset.pz === "open"; s.flash = null; ctx.rerender(); }));
      if (!s.open) { TTZ.wireDock(root, ctx, s, () => {}); return (e) => { if (e.key === "Escape") { s.open = true; s.flash = null; ctx.rerender(); } else TTZ.dockKeys(e, ctx, s, () => {}); }; }
      const act = (k) => {
        if (k === "resume") { s.open = false; s.settings = false; s.conf = null; }
        else if (k === "settings") { s.settings = !s.settings; s.conf = null; }
        else { s.conf = s.conf === k ? null : k; s.settings = false; }
        s.focus = MENU.findIndex((m) => m[0] === k); ctx.rerender();
      };
      root.querySelectorAll("[data-m]").forEach((b) => {
        b.addEventListener("click", () => act(b.dataset.m));
        b.addEventListener("mouseenter", () => { root.querySelectorAll(".c2-w.f").forEach((x) => x.classList.remove("f")); b.classList.add("f"); s.focus = +b.dataset.i; });
      });
      root.querySelector("[data-no]")?.addEventListener("click", () => { s.conf = null; ctx.rerender(); });
      root.querySelector("[data-yes]")?.addEventListener("click", (e) => {
        const k = e.currentTarget.dataset.yes; s.conf = null;
        if (k === "quit") { s.open = true; go("menu"); return; }
        s.open = false; s.flash = "Map restarted (preview)"; ctx.rerender();
      });
      // settings
      const sc = root.querySelector("#c2scroll");
      if (sc) {
        sc.scrollTop = s.scroll || 0;
        const navs = root.querySelectorAll("[data-sec]");
        const mark = () => { let cur = "audio"; navs.forEach((b) => { const hd = sc.querySelector("#c2-" + b.dataset.sec); if (hd.offsetTop - sc.offsetTop <= sc.scrollTop + 8) cur = b.dataset.sec; }); navs.forEach((b) => b.classList.toggle("on", b.dataset.sec === cur)); };
        sc.addEventListener("scroll", () => { s.scroll = sc.scrollTop; mark(); }); mark();
        navs.forEach((b) => b.addEventListener("click", () => { sc.scrollTop = sc.querySelector("#c2-" + b.dataset.sec).offsetTop - sc.offsetTop; s.scroll = sc.scrollTop; }));
        root.querySelectorAll("[data-mute]").forEach((b) => b.addEventListener("click", () => { s.mute[b.dataset.mute] = !s.mute[b.dataset.mute]; ctx.rerender(); }));
        root.querySelectorAll("[data-set]").forEach((b) => b.addEventListener("click", () => { setP(s, b.dataset.set, JSON.parse(b.dataset.val)); ctx.rerender(); }));
        root.querySelectorAll("[data-bind]").forEach((b) => b.addEventListener("click", () => { s.rebind = b.dataset.bind; ctx.rerender(); }));
        root.querySelector("[data-go]")?.addEventListener("click", () => go("keys"));
        root.querySelector("[data-reset]")?.addEventListener("click", () => { s.keys = pauseInit().keys; ctx.rerender(); });
        root.querySelectorAll(".c2-sl:not(.dis)").forEach((el) => {
          const min = +el.dataset.min, max = +el.dataset.max, unit = el.dataset.unit, val = el.nextElementSibling;
          const upd = (e) => {
            const r = el.getBoundingClientRect(), f = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
            const v = Math.round((min + f * (max - min)) / (max - min > 100 ? 5 : 1)) * (max - min > 100 ? 5 : 1);
            setP(s, el.dataset.sl, v); const p = ((v - min) / (max - min)) * 100;
            el.querySelector("i").style.width = p + "%"; el.querySelector("b").style.left = p + "%"; val.textContent = v + unit;
          };
          el.addEventListener("pointerdown", (e) => { el.setPointerCapture(e.pointerId); el.classList.add("drag"); upd(e); });
          el.addEventListener("pointermove", (e) => { if (el.hasPointerCapture(e.pointerId)) upd(e); });
          el.addEventListener("pointerup", () => el.classList.remove("drag"));
        });
      }
      return (e) => {
        if (s.rebind) {
          e.preventDefault();
          if (e.key !== "Escape") s.keys[s.rebind] = e.key === " " ? "Space" : e.key.length === 1 ? e.key.toUpperCase() : e.key;
          s.rebind = null; ctx.rerender(); return;
        }
        if (e.key === "Escape") { if (s.conf) s.conf = null; else if (s.settings) s.settings = false; else s.open = false; ctx.rerender(); return; }
        if (s.settings) return;
        if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); s.focus = (s.focus + (e.key === "ArrowDown" ? 1 : 3)) % 4; s.conf = null; ctx.rerender(); }
        else if (e.key === "Enter") { if (s.conf) root.querySelector("[data-yes]").click(); else act(MENU[s.focus][0]); }
      };
    },
  });

  /* ================= 9 · Main menu ================= */
  const MM = [["continue", "Continue", "Day 3 · 22:40"], ["new", "New game"], ["settings", "Settings"], ["quit", "Quit"]];
  TTZ.screen({
    id: "menu", num: 9, group: "Menus", title: "Main menu",
    bg: (tod) => (tod === "night" ? "img/night.jpg" : "img/dusk.jpg"),
    initState: () => ({ i: 0, conf: null }),
    notes: `<b>Main menu</b>: the city at dusk (night when the last save is at night), darkened at the edges. Title, four words, nothing else.
<ul><li>The title is set big and condensed; "Tiny tiny" shrinks as it goes, and a single zombie figure stands on the baseline at the scale of the game's people.</li>
<li>Continue shows where the save is (day and time) in small type under it.</li>
<li>Hover or arrow keys move the gold; Enter or click picks. Quit asks once, in place. Settings opens the same settings column as the pause screen.</li>
<li>Decide: should the background be a slow live camera drift over a saved city instead of a still?</li></ul>`,
    render(ctx) {
      const s = ctx.state, left = Math.round(ctx.W * 0.075);
      let h = `<div class="c2-vig"></div><div class="c2-title" style="left:${left}px;top:${Math.round(ctx.H * 0.17)}px">` +
        `<div class="c2-tt1">Tiny <span>tiny</span></div><div class="c2-tt2">Zombies<span class="c2-fig">${ic("zombie", 22)}</span></div><div class="c2-tag">Night of the Mini Dead</div></div>`;
      h += `<div class="c2-mm" style="left:${left}px;top:${Math.round(ctx.H * 0.5)}px">` + MM.map(([k, l, sub], i) => {
        let it = `<button class="c2-mw${i === s.i ? " f" : ""}${s.conf && s.conf !== k ? " dim" : ""}" data-mm="${i}">${l}${sub ? `<small>${sub}</small>` : ""}</button>`;
        if (s.conf === k) it += k === "quit" ? `<div class="c2-conf"><div>Quit to desktop?</div><button class="c2-yes" data-yes>Quit</button><span class="c2-dot">·</span><button data-no>Cancel</button></div>`
          : `<div class="c2-conf"><div>A new city at dawn. Your day 3 save is kept.</div><button class="c2-yes c2-go" data-yes>Start</button><span class="c2-dot">·</span><button data-no>Back</button></div>`;
        return it;
      }).join("") + `</div><div class="c2-ver">v0.14 · build 2611</div>`;
      return h;
    },
    mount(root, ctx) {
      const s = ctx.state;
      const act = (i) => {
        const k = MM[i][0]; s.i = i;
        if (k === "continue") return go("dock");
        if (k === "settings") return go("pause", { open: true, settings: true, conf: null, focus: 1 });
        s.conf = s.conf === k ? null : k; ctx.rerender();
      };
      root.querySelectorAll("[data-mm]").forEach((b) => {
        b.addEventListener("click", () => act(+b.dataset.mm));
        b.addEventListener("mouseenter", () => { root.querySelectorAll(".c2-mw.f").forEach((x) => x.classList.remove("f")); b.classList.add("f"); s.i = +b.dataset.mm; });
      });
      root.querySelector("[data-no]")?.addEventListener("click", () => { s.conf = null; ctx.rerender(); });
      root.querySelector("[data-yes]")?.addEventListener("click", () => { const k = s.conf; s.conf = null; if (k === "new") go("dock"); else ctx.rerender(); });
      return (e) => {
        if (e.key === "Escape") { s.conf = null; ctx.rerender(); }
        else if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); s.i = (s.i + (e.key === "ArrowDown" ? 1 : 3)) % 4; s.conf = null; ctx.rerender(); }
        else if (e.key === "Enter") { if (s.conf) root.querySelector("[data-yes]").click(); else act(s.i); }
      };
    },
  });

  /* ================= 10 · Key bindings ================= */
  const MOUSE = (t) => `<span class="k c2-ms">${ic("mouse", 12)}${t}</span>`;
  const R = (keys, d, o = {}) => ({ keys, d, ...o });
  const GROUPS = [
    [["Dock", "crate", [
      R(K("1") + "–" + K("7"), "Pick a counter in the open category", { was: "Was Z X C Y U V B N M J K" }),
      R(OR(K("Tab"), K("Shift", "Tab")), "Next / previous category"),
    ]], ["Squads", "troops", [
      R(K("Ctrl", "1") + "–" + K("9"), "Select squad n; Shift adds", { was: "Was 1–9 without Ctrl" }),
      R(K("."), "Next squad"), R(K("H"), "Halt"), R(K("P"), "Pace: auto, run, walk"),
      R(K("G"), "Garrison a building"), R(K("O"), "Occupy tower"), R(K("B"), "Burn area (flamers)"),
    ]]],
    [["Placing", "build", [
      R(MOUSE("Left"), "Place"), R(K("Shift"), "Hold to keep placing"), R(OR(K("Q"), K("E")), "Rotate 15°"), R(K("T"), "Rotate 90°"),
      R(K("Enter"), "Finish wall"), R(K("Backspace"), "Remove last point"), R(OR(MOUSE("Right"), K("Esc")), "Cancel"),
    ]], ["Engineers", "engineer", [R(K("N"), "Wall"), R(K("J"), "Gate"), R(K("K"), "Clear car"), R(K("Ctrl", "Z"), "Undo build")]]],
    [["Camera", "eye", [
      R(OR(K("W"), K("A"), K("S"), K("D")), "Pan (or arrow keys)"), R(K("Shift"), "Pan faster"), R(MOUSE("Wheel"), "Zoom"),
      R(MOUSE("Right drag"), "Pan"), R(K("Alt") + `<i class="c2-plus">+</i>` + MOUSE("Left drag"), "Rotate"), R(OR(K("Q"), K("E")), "Turn, when not placing"),
    ]], ["System", "cog", [
      R(K("Esc"), "Cancel, then deselect, then pause", { was: "Esc with nothing selected used to quit the game" }),
      R(K("Space"), "Pause"), R(OR(K("+"), K("−")), "Game speed"), R(K("F12"), "Screenshot"),
      R(K("Backspace"), "Jump to latest alert", { prop: 1 }),
    ]]],
  ];
  TTZ.screen({
    id: "keys", num: 10, group: "Menus", title: "Key bindings",
    notes: `<b>Key bindings</b>: a reference page over the dimmed, paused world. Six groups in three columns, the keys drawn as keycaps and lined up so the eye reads down the keys first.
<ul><li>A gold dot marks a binding that differs from the current game; hover it for the old key.</li>
<li>Main moves: cards go from Z X C… to <b>1–7</b>, squads move to <b>Ctrl+1–9</b>, and Esc never quits any more.</li>
<li>Backspace means "remove last point" while placing a wall and "jump to latest alert" otherwise; the second is a proposal.</li>
<li>Esc goes back to the pause menu. Rebinding happens in Settings, Controls.</li>
<li>Decide: keep Backspace for alerts, or give it its own key (Home, say)?</li></ul>`,
    render(ctx) {
      const pad = Math.max(64, Math.round(ctx.W * 0.06)), colW = Math.floor((ctx.W - pad * 2 - 48) / 3), top = Math.round(ctx.H * 0.08);
      let h = `<div class="c2-veil k"></div><div class="c2-kp" style="left:${pad}px;right:${pad}px;top:${top}px">` +
        `<div class="c2-khead"><h2 class="fl">Key bindings</h2><span class="c2-leg fl"><i class="c2-gd"></i>changed from the current game</span><button class="c2-back fl" data-back>${TTZ.k("Esc")} back</button></div><div class="c2-cols">`;
      h += GROUPS.map((col) => `<div class="c2-col" style="width:${colW}px">` + col.map(([nm, gi, rows]) => `<section><h3 class="fl">${ic(gi, 16)}${nm}</h3>` +
        rows.map((r) => `<div class="c2-kr fl"${r.was ? ` data-tip="${esc(r.was)}"` : ""}><span class="c2-keys">${r.keys}</span><span class="c2-desc">${r.was ? `<i class="c2-gd"></i>` : ""}${r.d}${r.prop ? ` <em>proposed</em>` : ""}</span></div>`).join("") + `</section>`).join("") + `</div>`).join("");
      return h + `</div></div>`;
    },
    mount(root, ctx) {
      TTZ.wireTips(root, ctx);
      const back = () => go("pause", { open: true, settings: true, conf: null });
      root.querySelector("[data-back]").addEventListener("click", back);
      return (e) => { if (e.key === "Escape") back(); };
    },
  });

  /* ================= 0 · Design language ================= */
  const COLS = [
    ["--bone", "Bone", "Text and icons"], ["--dim", "Dim", "Secondary text"], ["--mute", "Mute", "Unavailable"],
    ["--gold", "Gold", "Money, the active thing"], ["--ok", "Green", "Healthy, gaining"], ["--warn", "Amber", "Low, at risk"],
    ["--bad", "Red", "Danger, can't do"], ["--toxic", "Toxic", "Gas, infection"], ["--info", "Blue", "Night, building, supply"],
    ["--tok", "Token", "Counter face"], ["--tok-glass", "Glass", "Tooltip, world card"],
  ];
  const TYPE = [["34 / 700 condensed", "Resume", "font:700 34px/1 var(--f);font-stretch:82%"], ["16 / 700", "$3,800 · 22:40", "font:700 16px/1 var(--f)"], ["14 / 700", "Rifle squad 2", "font:700 14px/1 var(--f)"],
    ["13 / 500", "Holds streets, captures buildings.", "font:500 13px/1.2 var(--f)"], ["11 / 600", "day 3 · +530", "font:600 11px/1 var(--f);color:var(--dim)"], ["10 / 800", "key", null]];
  TTZ.screen({
    id: "language", num: 0, group: "Overview", title: "Design language", bg: null,
    notes: `<b>Design language</b>: everything the HUD is made of, on one sheet.
<ul><li>One building block, the token: a solid bevelled counter with a game-icons silhouette. Round for units, square for everything else.</li>
<li>Bone for text and icons. Gold means money or "this is the active thing". The five state colours mean only state.</li>
<li>Text sits on the world with a hard shadow. The only filled surfaces are tokens, the tooltip and the world card.</li>
<li>One typeface, Archivo, in sentence case. Shipped as TTF into ImGui at the sizes shown.</li>
<li>Decide: is the icon set wide enough, or should vehicles and supplies get their own drawn silhouettes?</li></ul>`,
    render(ctx) {
      const names = Object.keys(window.GI || {}).sort((a, b) => a.localeCompare(b));
      const left = Math.max(0, Math.round((ctx.W - 1280) / 2)), top = Math.max(0, Math.round((ctx.H - 720) / 2));
      let h = `<div class="c2-ls" style="left:${left}px;top:${top}px">`;
      h += `<div class="c2-lhd"><h2>Counters</h2><span>HUD design language v2 · sizes in UI points (1280×720 at 720p)</span></div><div class="c2-lgrid"><div class="c2-lcol">`;
      h += `<h3>Colour</h3>` + COLS.map(([v, n, r]) => `<div class="c2-sw"><i style="background:var(${v})"></i><b>${n}</b><span>${r}</span></div>`).join("");
      h += `<h3>Type · Archivo</h3>` + TYPE.map(([l, t, st]) => `<div class="c2-ty"><span class="c2-tl">${l}</span>${st ? `<span style="${st}">${t}</span>` : `<span>${TTZ.k("H")} ${TTZ.k("Ctrl")}</span>`}</div>`).join("");
      h += `</div><div class="c2-rcol"><h3>Icons <span>${names.length} · game-icons.net</span></h3><div class="c2-icons">` +
        names.map((n) => `<div class="c2-ic">${ic(n, 22)}<span>${n}</span></div>`).join("") + `</div>`;
      const st = (o, l) => `<div class="c2-st">${TTZ.tok(o)}<span>${l}</span></div>`;
      h += `<div class="c2-low"><div><h3>Token states</h3><div class="c2-sts">` +
        st({ ic: "rifle", size: 40 }, "normal") + st({ ic: "rifle", size: 40, on: 1 }, "on") + st({ ic: "tower", size: 40, off: 1 }, "off") + st({ ic: "halt", size: 40, key: "H" }, "key") +
        st({ ic: "rifle", size: 40, round: 1, ring: 1 }, "100 %") + st({ ic: "rifle", size: 40, round: 1, ring: 0.5 }, "50 %") + st({ ic: "rifle", size: 40, round: 1, ring: 0.15 }, "15 %") + st({ ic: "mg", size: 40, round: 1, ring: 0.8, n: 2 }, "squad n") +
        `</div></div><div><h3>Tooltip</h3><div class="tip c2-tipx">${TTZ.cardTip(TTZ.CARDS.structures[3], "Needs engineers: buy engineers first")}</div></div></div>`;
      h += `</div></div><div class="c2-cred">Icons: game-icons.net (Lorc, Delapouite and contributors), CC BY 3.0 · Font: Archivo (OFL), shipped as TTF into ImGui</div></div>`;
      return h;
    },
  });
})();
