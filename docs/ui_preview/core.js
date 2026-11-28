/* Tiny Tiny Zombies HUD preview v2 "Counters" — core components.
   Screens: TTZ.screen({id, num, badge, group, title, status, bg, notes, initState(), render(ctx) -> html, mount(root, ctx) -> keydown handler})
   ctx = { W, H (UI points), u, fit, res, tod: 'day'|'night', night, rerender(), state } */
(function () {
  const TTZ = (window.TTZ = { screens: [] });
  TTZ.screen = (s) => TTZ.screens.push(s);
  const esc = (TTZ.esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])));
  const money = (TTZ.money = (n) => "$" + String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ","));

  /* icons (game-icons.net, CC BY 3.0) */
  TTZ.ic = (name, size = 20, style = "") => {
    const b = window.GI && window.GI[name];
    if (!b) return `<svg class="gi" width="${size}" height="${size}"></svg>`;
    return `<svg class="gi" width="${size}" height="${size}" viewBox="0 0 512 512" style="${style}" aria-hidden="true">${b}</svg>`;
  };
  TTZ.k = (key) => `<span class="k">${esc(key)}</span>`;
  // token: o = {ic, size, isize, round, on, off, key, n (corner number), ring (0..1), ringCol, id, why, cls, title, attrs, color}
  TTZ.tok = (o) => {
    const s = o.size || 36, is = o.isize || Math.round(s * 0.6);
    const cls = ["tok", o.round && "round", o.on && "on", o.off && "off", o.cls].filter(Boolean).join(" ");
    return `<div class="${cls}" style="width:${s}px;height:${s}px${o.color ? ";color:" + o.color : ""}"${o.id ? ` data-id="${o.id}"` : ""}${o.why ? ` data-why="${esc(o.why)}"` : ""}${o.tip ? ` data-tip="${esc(o.tip)}"` : ""}${o.attrs || ""}>` +
      (o.ring != null ? `<span class="ring" style="--rw:${s < 36 ? 2 : 3}px;--v:${o.ring};--rc:${o.ringCol || TTZ.hpCol(o.ring)}"></span>` : "") +
      TTZ.ic(o.ic, is) + (o.key ? TTZ.k(o.key) : "") + (o.n != null ? `<span class="n">${esc(o.n)}</span>` : "") + `</div>`;
  };
  TTZ.hpCol = (f) => (f > 0.6 ? "var(--ok)" : f > 0.3 ? "var(--warn)" : "var(--bad)");

  /* ---------- data (from the HUD audit) ---------- */
  TTZ.TABS = [
    { id: "units", name: "Units", ic: "helmet" },
    { id: "structures", name: "Structures", ic: "wall" },
    { id: "supplies", name: "Supplies", ic: "ammo" },
    { id: "engineering", name: "Engineering", ic: "wrench" },
    { id: "vehicles", name: "Vehicles", ic: "vehicle", later: true },
  ];
  TTZ.CARDS = {
    units: [
      { id: "unit.rifle", nm: "Rifle squad", ic: "rifle", cost: 1000, d: "All-round squad. Holds streets, captures buildings.", st: [["troops", "5"], ["heart", "100"], ["target", "60 m"]] },
      { id: "unit.mg", nm: "MG squad", ic: "mg", cost: 1400, d: "Machine gun and two loaders. Shreds a horde in a street; slow to move.", st: [["troops", "3"], ["heart", "110"], ["target", "75 m"]] },
      { id: "unit.sniper", nm: "Sniper", ic: "sniper", cost: 700, d: "One marksman. Best on a roof or in a tower.", st: [["troops", "1"], ["heart", "90"], ["target", "140 m"]] },
      { id: "unit.flame", nm: "Flamethrowers", ic: "flame", cost: 900, d: "Burn corpses and gas. Short range.", st: [["troops", "2"], ["heart", "120"], ["target", "12 m"]] },
      { id: "unit.engineer", nm: "Engineers", ic: "engineer", cost: 1200, d: "Build walls, gates and towers; clear and siphon cars.", st: [["troops", "3"], ["heart", "90"]] },
    ],
    structures: [
      { id: "struct.wall", nm: "Wall 1.6 m", ic: "wall", cost: 40, suf: "/4m", d: "Low wall. Stops walkers; climbers get over in time." },
      { id: "struct.wall2", nm: "Wall 2.4 m", ic: "wallTall", cost: 110, suf: "/4m", d: "High wall. Holds a horde." },
      { id: "struct.gate", nm: "Gate", ic: "gate", cost: 120, suf: "/4m", d: "Opens for your squads, shuts for the dead." },
      { id: "struct.tower", nm: "Defense tower", ic: "tower", cost: 200, d: "Shooters occupy it: more range, protected." },
      { id: "struct.light", nm: "Floodlight", ic: "light", cost: 40, d: "Lights the street at night. Needs a generator within 30 m." },
      { id: "struct.generator", nm: "Generator", ic: "generator", cost: 150, d: "Powers floodlights within 30 m. Burns 1 l of fuel a minute." },
      { id: "struct.fuel", nm: "Fuel store", ic: "fuel", cost: 60, d: "Holds siphoned fuel (200 l). Generators draw from it." },
    ],
    supplies: [
      { id: "sup.container", nm: "Ammo container", ic: "container", cost: 1500, d: "Large ammo stock. Squads nearby refill on their own." },
      { id: "sup.airdrop", nm: "Ammo drop", ic: "airdrop", cost: 400, d: "Parachutes a crate onto a squad." },
    ],
    engineering: [
      { id: "eng.clearcar", nm: "Clear car", ic: "disassemble", cost: 50, d: "Engineers take a wreck apart. Its fuel goes to the fuel store." },
      { id: "eng.siphon", nm: "Siphon fuel", ic: "siphon", cost: 0, d: "Engineers drain a parked car and carry the fuel to the store." },
      { id: "eng.undo", nm: "Undo build", ic: "undo", cost: -1, key: "^Z", d: "Removes the last unfinished pieces and refunds them." },
    ],
    vehicles: [
      { id: "veh.jeep", nm: "Jeep", ic: "vehicle", later: true, d: "Coming later." },
      { id: "veh.truck", nm: "Supply truck", ic: "truck", later: true, d: "Coming later." },
      { id: "veh.heli", nm: "Helicopter", ic: "heli", later: true, d: "Coming later." },
    ],
  };

  /* ---------- top-left resources ---------- */
  TTZ.resources = (o = {}) => {
    const f = o.funds ?? 3800, inc = o.income ?? 530;
    const r = (ic, v, s, col, tip) => `<div class="r fl" title="${tip}">${TTZ.ic(ic, 18, col ? "color:" + col : "")}<span class="v">${v}</span>${s ? `<span class="s">${s}</span>` : ""}</div>`;
    return `<div class="edge-tl"></div><div class="res">` +
      r("funds", `<span style="color:var(--gold)">${money(f)}</span>`, `<span style="color:${inc < 0 ? "var(--bad)" : "var(--ok)"}">${inc < 0 ? "−" + Math.abs(inc) : "+" + inc}</span>`, "var(--gold)", "Funds and income per minute") +
      r("troops", o.troops ?? 14, o.lost ? `<span style="color:var(--bad)">−${o.lost}</span>` : "", "", "Troops alive") +
      r("territory", (o.terr ?? 3.4) + " ha", o.terrNote ? `<span style="color:var(--warn)">${o.terrNote}</span>` : "", o.terrNote ? "var(--warn)" : "var(--ok)", "Territory held") +
      r("kills", String(o.kills ?? 146).replace(/\B(?=(\d{3})+(?!\d))/g, ","), "", "", "Zombies killed") + `</div>`;
  };
  /* ---------- top-right clock ---------- */
  TTZ.clock = (o = {}) => {
    const night = o.night, t = o.time ?? (night ? "22:40" : "13:10"), f = o.dayFrac ?? (night ? 0.93 : 0.55);
    return `<div class="edge-tr"></div><div class="clock"><div class="dial"><span class="ring" style="inset:0;--v:${f};--rc:${night ? "var(--info)" : "var(--gold)"}"></span><span style="position:absolute;inset:4px;display:grid;place-items:center;color:${night ? "var(--info)" : "var(--gold)"}">${TTZ.ic(night ? "moon" : "sun", 14)}</span></div>` +
      `<span class="t fl">${t}</span><span class="fl" style="font-size:11px;color:var(--dim);font-weight:600">day ${o.day ?? 3}</span>` +
      `<div class="speed">${TTZ.tok({ ic: "pause", size: 22, isize: 12, tip: "Pause (Space)", on: o.paused })}${TTZ.tok({ ic: "play", size: 22, isize: 12, on: !o.paused && !o.fast, tip: "Normal speed" })}${TTZ.tok({ ic: "fast", size: 22, isize: 12, on: o.fast, tip: "Fast (+)" })}</div></div>`;
  };

  /* ---------- dock ---------- */
  // state: {tab, active, offset, funds, disable:{id:why}, cards}
  TTZ.dock = (s = {}) => {
    const tab = s.tab || "units", funds = s.funds ?? 3800, list = s.cards || TTZ.CARDS[tab];
    const cats = TTZ.TABS.map((t) => `<button data-tab="${t.id}" class="${t.id === tab ? "on" : ""}${t.later ? " later" : ""}" title="${t.name}${t.later ? " (coming later)" : ""}">${TTZ.ic(t.ic, 16)}<span class="cn">${t.name}</span></button>`).join("");
    const slots = list.map((c, i) => {
      const why = c.later ? "Coming later" : (s.disable && s.disable[c.id]) || (c.cost > funds ? "Not enough funds" : "");
      const cost = c.later ? "soon" : c.cost > 0 ? money(c.cost) : c.cost === 0 ? "free" : "";
      return `<div class="slot${why ? " off" : ""}${c.later ? " later" : ""}" data-card="${c.id}"${why ? ` data-why="${esc(why)}"` : ""}>${TTZ.tok({ ic: c.ic, size: 46, isize: 28, on: s.active === c.id, off: !!why && !c.later, key: c.later ? "" : c.key || String(i + 1), cls: c.later ? "off" : "" })}<span class="c">${cost}</span></div>`;
    });
    for (let i = list.length; i < 7; i++) slots.push(`<div class="slot empty"><div class="tok"></div></div>`);
    const off = s.offset || 0, over = list.length > 7;
    return `<div class="edge-b"></div><div class="dock" id="dock"><div class="cats">${cats}</div>` +
      (over ? `<div class="arw l${off === 0 ? " dis" : ""}" data-scroll="-1">‹</div><div class="arw r${off >= list.length - 7 ? " dis" : ""}" data-scroll="1">›</div>` : "") +
      `<div class="row"><div class="strip" style="transform:translateX(${-off * 54}px)">${slots.join("")}</div></div></div>`;
  };
  TTZ.cardTip = (c, why) => `<div class="tt">${esc(c.nm)}<span class="m">${c.cost > 0 ? money(c.cost) + (c.suf || "") : ""}</span></div><div class="d">${esc(c.d || "")}</div>` +
    (c.st ? `<div class="st">${c.st.map(([i, v]) => `<span>${TTZ.ic(i, 13, "color:var(--dim)")}${v}</span>`).join("")}</div>` : "") + (why ? `<div class="why">${esc(why)}</div>` : "");
  // generic tooltip placement for any [data-tip] / dock slot inside root
  TTZ.showTip = (root, ctx, anchorEl, html, below, topEl) => {
    TTZ.hideTip(root);
    const hr = root.getBoundingClientRect(), r = anchorEl.getBoundingClientRect(), s = ctx.u * ctx.fit;
    root.insertAdjacentHTML("beforeend", `<div class="tip" id="tip">${html}</div>`);
    const t = root.querySelector("#tip");
    const cx = (r.left + r.width / 2 - hr.left) / s;
    t.style.left = Math.max(6, Math.min(ctx.W - 216, cx - 105)) + "px";
    const tr = (topEl || anchorEl).getBoundingClientRect();
    const top = below ? (r.bottom - hr.top) / s + 8 : (tr.top - hr.top) / s - t.offsetHeight - 6;
    t.style.top = Math.max(6, top) + "px";
  };
  TTZ.hideTip = (root) => root.querySelector("#tip")?.remove();
  TTZ.wireTips = (root, ctx) => root.querySelectorAll("[data-tip]").forEach((el) => {
    el.addEventListener("mouseenter", () => TTZ.showTip(root, ctx, el, `<div class="tt">${esc(el.dataset.tip)}</div>${el.dataset.why ? `<div class="why">${esc(el.dataset.why)}</div>` : ""}`, el.getBoundingClientRect().top < root.getBoundingClientRect().top + 80 * ctx.u * ctx.fit));
    el.addEventListener("mouseleave", () => TTZ.hideTip(root));
  });
  TTZ.wireDock = (root, ctx, s, onPick) => {
    const d = root.querySelector("#dock"); if (!d) return;
    const list = () => s.cards || TTZ.CARDS[s.tab || "units"];
    d.querySelectorAll("[data-tab]").forEach((b) => b.addEventListener("click", () => { s.tab = b.dataset.tab; s.offset = 0; s.active = null; ctx.rerender(); }));
    d.querySelectorAll("[data-scroll]").forEach((b) => b.addEventListener("click", () => { s.offset = Math.max(0, Math.min(list().length - 7, (s.offset || 0) + +b.dataset.scroll)); ctx.rerender(); }));
    d.addEventListener("wheel", (e) => { if (list().length <= 7) return; e.preventDefault(); s.offset = Math.max(0, Math.min(list().length - 7, (s.offset || 0) + Math.sign(e.deltaY))); ctx.rerender(); }, { passive: false });
    d.querySelectorAll("[data-card]").forEach((el) => {
      const c = list().find((x) => x.id === el.dataset.card);
      el.addEventListener("mouseenter", () => TTZ.showTip(root, ctx, el, TTZ.cardTip(c, el.dataset.why), false, d));
      el.addEventListener("mouseleave", () => TTZ.hideTip(root));
      el.addEventListener("click", () => { if (!c.later && onPick) onPick(c.id, el.dataset.why); });
    });
    TTZ.wireTips(root, ctx);
  };
  TTZ.dockKeys = (e, ctx, s, onPick) => {
    const list = s.cards || TTZ.CARDS[s.tab || "units"];
    if (e.key === "Tab") { e.preventDefault(); const i = TTZ.TABS.findIndex((t) => t.id === (s.tab || "units")); s.tab = TTZ.TABS[(i + (e.shiftKey ? 4 : 1)) % 5].id; s.offset = 0; s.active = null; ctx.rerender(); return true; }
    if (/^[1-7]$/.test(e.key) && !e.ctrlKey) { const c = list[+e.key - 1]; if (c && !c.later && onPick) { const el = document.querySelector(`[data-card="${c.id}"]`); onPick(c.id, el && el.dataset.why); } return true; }
    return false;
  };

  /* ---------- selection (bottom-left) ---------- */
  TTZ.STATE = {
    engaging: ["target", "var(--warn)", "Engaging"], attacked: ["alert", "var(--bad)", "Under attack"], moving: ["run", "var(--ok)", "Moving"],
    holding: ["halt", "var(--dim)", "Holding"], resupplying: ["ammo", "var(--info)", "Resupplying"], building: ["build", "var(--info)", "Building"],
  };
  // o = {ic, num, name, state, members:[{ic, hp, ammo, kia, wounded, tip}], pace:'auto'|'run'|'walk', actions:[{ic,tip,key,off,why,on,id}], warn:[[ic,col,txt]]}
  TTZ.selection = (o) => {
    const st = TTZ.STATE[o.state] || TTZ.STATE.holding;
    const avg = o.members.filter((m) => !m.kia).reduce((a, m) => a + m.hp, 0) / o.members.length;
    let h = `<div class="sel" id="sel"><div class="head">${TTZ.tok({ ic: o.ic, size: 52, isize: 30, round: true, ring: avg, n: o.num, tip: o.name })}` +
      `<div style="position:absolute;left:62px;top:2px;display:flex;align-items:baseline;gap:10px;white-space:nowrap"><div class="nm fl">${esc(o.name)}</div><div class="stt fl" style="color:${st[1]}">${TTZ.ic(st[0], 13)}${st[2]}${(o.warn || []).map(([i, c, t]) => `<span style="color:${c};display:inline-flex;gap:3px;align-items:center;margin-left:8px">${TTZ.ic(i, 13)}${t}</span>`).join("")}</div></div></div>`;
    h += `<div class="mem">` + o.members.map((m, i) => `<div class="m${m.kia ? " kia" : ""}">${TTZ.tok({ ic: m.kia ? "kia" : m.ic, size: 26, isize: 15, round: true, ring: m.kia ? 0 : m.hp, ringCol: m.wounded ? "var(--bad)" : null, tip: m.tip || "" })}${m.kia ? "" : `<span class="am"><i style="width:${Math.round((m.ammo ?? 1) * 100)}%;${(m.ammo ?? 1) < 0.25 ? "background:var(--warn)" : ""}"></i></span>`}</div>`).join("") + `</div>`;
    const pace = o.pace || "auto";
    h += `<div class="acts">${TTZ.tok({ ic: "halt", size: 28, isize: 17, key: "H", tip: "Halt" })}<span class="sep"></span>` +
      ["auto", "run", "walk"].map((p) => TTZ.tok({ ic: p, size: 28, isize: 17, on: pace === p, tip: { auto: "Pace: auto", run: "Pace: run (tires faster)", walk: "Pace: walk (quiet)" }[p] + " — P cycles", attrs: ` data-pace="${p}"` })).join("") +
      ((o.actions || []).length ? `<span class="sep"></span>` + o.actions.map((a) => TTZ.tok({ ic: a.ic, size: 28, isize: 17, key: a.key, off: a.off, why: a.why, on: a.on, tip: a.tip, id: a.id })).join("") : "") + `</div></div>`;
    return h;
  };
  // world card (an object's info + actions, drawn at the object). o = {x, y (UI pts), ic, title, extra, body, actions:[{ic, tip, key, cost, off, why, on, id}]}
  TTZ.worldCard = (o) => `<div class="wc" style="left:${o.x}px;top:${o.y}px"${o.id ? ` id="${o.id}"` : ""}><div class="h">${TTZ.ic(o.ic, 16)}${esc(o.title)}${o.extra ? `<span class="x">${o.extra}</span>` : ""}</div>${o.body || ""}` +
    (o.actions ? `<div class="a">${o.actions.map((a) => `<div class="slot${a.off ? " off" : ""}">${TTZ.tok({ ic: a.ic, size: 32, isize: 19, key: a.key, off: a.off, why: a.why, on: a.on, tip: a.tip, id: a.id })}<span class="c">${a.cost != null ? (a.cost > 0 ? money(a.cost) : a.cost === 0 ? "free" : "") : ""}</span></div>`).join("")}</div>` : "") + `</div>`;

  /* standard in-play frame: resources + clock + dock */
  TTZ.frame = (ctx, s, o = {}) => TTZ.resources(o) + TTZ.clock({ night: ctx.night, ...o }) + TTZ.dock(s);
})();
