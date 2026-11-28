/* screens_b (v2): world markers, placing, alerts. Helpers: TTZ.marker, TTZ.banner, TTZ.alerts, TTZ.reserved, TTZ.safe. */
(function () {
  const ic = TTZ.ic, tok = TTZ.tok, esc = TTZ.esc, money = TTZ.money;

  /* ---------- reserved HUD areas (UI points) ---------- */
  TTZ.reserved = (W, H) => [
    [0, 0, 520, 40],                       // resources
    [W - 300, 0, W, 36],                   // clock + speed
    [W - 52, 36, W, 222],                  // alert stack
    [W / 2 - 214, H - 108, W / 2 + 214, H], // dock
    [0, H - 112, 352, H],                  // selection
  ];
  // push a marker anchor (its bottom-centre) out of reserved areas; the marker body sits ~h pts above the anchor
  TTZ.safe = (W, H, x, y, h = 34, w = 30) => {
    for (const [x0, y0, x1, y1] of TTZ.reserved(W, H)) {
      if (x + w / 2 > x0 && x - w / 2 < x1 && y > y0 && y - h < y1) {
        if (y0 > 0) y = y0 - 2; else y = y1 + h + 2; // bottom areas push up, top areas push down
      }
    }
    return { x: Math.max(w / 2 + 4, Math.min(W - w / 2 - 4, x)), y };
  };

  /* ---------- world markers ----------
     o = {kind, x, y, ic, n, selected, attacked, text, full, v (0..1), col, tip, tier, scale, label}
     kinds: squad | count | breach | capture | status | stock. Anchor (x,y) = the point on the world. */
  TTZ.marker = (o) => {
    const k = o.kind || "squad", s = o.scale || 1, tip = o.tip ? ` data-tip="${esc(o.tip)}"` : "";
    const wrap = (inner, cls = "") => `<div class="b2-mk ${k} ${cls}" style="left:${o.x}px;top:${o.y}px;--s:${s}">${inner}</div>`;
    const lab = o.label ? `<span class="b2-lab fl">${esc(o.label)}</span>` : "";
    if (k === "squad")
      return wrap(lab + tok({ ic: o.ic, size: 26, isize: 15, round: true, n: o.n, cls: [o.selected && "b2-sel", o.attacked && "b2-hit"].filter(Boolean).join(" "),
        tip: o.tip || `Squad ${o.n}${o.attacked ? " · under attack" : ""}` }) + `<i class="stem"></i>`);
    if (k === "count")
      return wrap(`<div class="b2-cnt fl${o.full ? " full" : ""}"${tip || ` data-tip="Garrison ${esc(o.text)}"`}>${ic(o.ic || "garrison", 14)}<span>${esc(o.text)}</span></div>`);
    if (k === "breach")
      return `<div class="b2-ground" style="left:${o.x}px;top:${o.y}px"></div>` +
        wrap(`<div class="b2-bad"${tip || ` data-tip="Wall breached"`}>${ic("breach", 16)}</div><i class="stem bad"></i>`);
    if (k === "capture")
      return wrap(tok({ ic: "flag", size: 26, isize: 14, round: true, ring: o.v ?? 0.5, ringCol: "var(--info)", tip: o.tip || `Capturing ${Math.round((o.v ?? 0.5) * 100)} %` }) + `<i class="stem"></i>`);
    if (k === "status")
      return wrap(`<div class="b2-st fl" style="color:${o.col || "var(--bone)"}"${tip}>${ic(o.ic, 14)}</div>`);
    if (k === "stock")
      return wrap(`<div class="b2-cnt fl"${tip || ` data-tip="Ammo in container"`}>${ic("crate", 14)}<span>${esc(o.text)}</span></div>`);
    return "";
  };
  // dashed ground ellipse, no label; tooltip only
  TTZ.radius = (cx, cy, rx, ry, tip = "Build radius 35 m") =>
    `<svg class="b2-rad" style="left:${cx - rx - 4}px;top:${cy - ry - 4}px" width="${rx * 2 + 8}" height="${ry * 2 + 8}"><ellipse cx="${rx + 4}" cy="${ry + 4}" rx="${rx}" ry="${ry}" class="v"/><ellipse cx="${rx + 4}" cy="${ry + 4}" rx="${rx}" ry="${ry}" class="hit" data-tip="${esc(tip)}"/></svg>`;

  /* ---------- 5 · world markers ---------- */
  // tier 1 = always (selected / attacked squads, breach), tier 2 = squads, garrisons, capture, tier 3 = status, stock, build radius
  const WORLD = [
    { kind: "squad", ic: "rifle", n: 2, px: 0.505, py: 0.47, selected: 1, tier: 1, label: "Rifle squad 2" },
    { kind: "squad", ic: "mg", n: 1, px: 0.475, py: 0.62, attacked: 1, tier: 1, label: "MG squad 1" },
    { kind: "breach", px: 0.735, py: 0.8, tier: 1 },
    { kind: "squad", ic: "rifle", n: 3, px: 0.22, py: 0.58, tier: 2, label: "Rifle squad 3" },
    { kind: "squad", ic: "engineer", n: 1, px: 0.395, py: 0.43, tier: 2, label: "Engineers 1" },
    { kind: "squad", ic: "sniper", n: 1, px: 0.5, py: 0.96, tier: 2, label: "Sniper 1", tip: "Sniper 1 · pinned above the dock" },
    { kind: "count", ic: "garrison", text: "5/12", px: 0.4, py: 0.26, tier: 2 },
    { kind: "count", ic: "hospital", text: "2/6", px: 0.66, py: 0.58, tier: 2, tip: "Hospital 2/6" },
    { kind: "count", ic: "tower", text: "2/2", full: 1, px: 0.14, py: 0.42, tier: 2, tip: "Defense tower full 2/2" },
    { kind: "capture", px: 0.3, py: 0.66, v: 0.64, tier: 2 },
    { kind: "status", ic: "wrench", col: "var(--info)", px: 0.395, py: 0.37, tier: 3, tip: "Working: wall 2 of 3" },
    { kind: "status", ic: "hourglass", col: "var(--dim)", px: 0.43, py: 0.72, tier: 3, tip: "Queued: gate" },
    { kind: "stock", text: "640", px: 0.62, py: 0.74, tier: 3 },
  ];
  TTZ.screen({
    id: "labels", num: 5, group: "In play", title: "World markers",
    initState: () => ({ tab: "units", v: "close" }),
    notes: `<b>World markers</b>: the smallest thing that says what is there, drawn on the object.
<ul><li>Priority rule. Tier 1 always: selected and attacked squads, breaches. Tier 2: other squads, garrisons, capture. Tier 3: work status, stock, build radius. Zoomed far out, tiers 2 and 3 hide and the rest shrink to 75 %.</li>
<li>Squads are small round counters with their number; gold ring = selected, red pulse = under attack. Garrisons and stock are icon + number, nothing else. Full garrisons dim.</li>
<li>Markers never sit on a reserved HUD area: they get pushed to its edge (Sniper 1 is standing behind the dock).</li>
<li>Build radius is a dashed ground line with no label; hover it for "35 m". It shows only while engineers are selected or something is being placed.</li>
<li>Owner: is "far" a camera height threshold or a player toggle (e.g. hold Alt to show everything)?</li></ul>`,
    render(ctx) {
      const s = ctx.state, W = ctx.W, H = ctx.H, far = s.v === "far", all = s.v === "all";
      let h = TTZ.frame(ctx, s) + TTZ.mock([["close", "close"], ["far", "far"], ["all", "everything (no rule)"]], s.v);
      if (!far) h += TTZ.radius(0.43 * W, 0.5 * H, 0.17 * W, 0.12 * H);
      for (const m of WORLD) {
        if (far && m.tier > 1) continue;
        const p = TTZ.safe(W, H, m.px * W, m.py * H, m.kind === "status" ? 18 : 34);
        h += TTZ.marker({ ...m, x: p.x, y: p.y, scale: far ? 0.75 : 1, label: all ? m.label : null });
        if (all && m.kind === "squad") h += TTZ.marker({ kind: "status", ic: m.attacked ? "target" : "run", x: p.x + 22, y: p.y - 8, col: "var(--dim)" }) + TTZ.marker({ kind: "count", ic: "heart", text: "86", x: p.x - 30, y: p.y - 6 });
      }
      if (all) h += TTZ.marker({ kind: "count", ic: "fuel", text: "140 l", x: 0.58 * W, y: 0.36 * H }) + TTZ.marker({ kind: "count", ic: "zombie", text: "23", x: 0.7 * W, y: 0.86 * H }) + TTZ.marker({ kind: "count", ic: "light", text: "on", x: 0.33 * W, y: 0.5 * H });
      return h;
    },
    mount(root, ctx) {
      TTZ.wireDock(root, ctx, ctx.state, () => {}); TTZ.wireMock(root, ctx, "v");
      return (e) => TTZ.dockKeys(e, ctx, ctx.state, () => {});
    },
  });

  /* ---------- 6 · placing ---------- */
  const hints = `<span class="h">${TTZ.k("LMB")}place</span><span class="h">${TTZ.k("Shift")}keep</span><span class="h">${TTZ.k("Q")}${TTZ.k("E")}rotate</span><span class="h">${TTZ.k("Esc")}cancel</span>`;
  TTZ.banner = (c, o = {}) => `<div class="b2-banner">${ic(c.ic, 16)}<span class="nm">${esc(c.nm)}</span><span class="pr${o.poor ? " poor" : ""}">${c.cost > 0 ? money(c.cost) + (c.suf || "") : c.cost === 0 ? "free" : ""}</span><span class="sp"></span>${hints}</div>`;

  const REASON = { radius: "Outside build radius", car: "Blocked by a car", funds: "Not enough funds" };
  const START = { valid: [0.46, 0.55], radius: [0.75, 0.44], car: [0.36, 0.48], funds: [0.47, 0.57], wall: [0.5, 0.5] };
  const inRadius = (ctx, x, y) => ((x - 0.43 * ctx.W) / (0.17 * ctx.W)) ** 2 + ((y - 0.5 * ctx.H) / (0.12 * ctx.H)) ** 2 <= 1;

  function ghost(ctx, s) {
    const x = s.mx, y = s.my;
    if (s.v === "wall") {
      const ppm = ctx.W * 0.0075, x0 = 0.4 * ctx.W, y0 = 0.6 * ctx.H;
      let dx = x - x0, dy = y - y0; const d = Math.hypot(dx, dy) || 1; dx /= d; dy /= d;
      const pieces = Math.max(1, Math.round(d / ppm / 4)), m = pieces * 4, L = m * ppm, x1 = x0 + dx * L, y1 = y0 + dy * L;
      let t = "";
      for (let i = 0; i <= pieces; i++) { const tx = x0 + dx * i * 4 * ppm, ty = y0 + dy * i * 4 * ppm; t += `<line x1="${tx - dy * 5}" y1="${ty + dx * 5}" x2="${tx + dy * 5}" y2="${ty - dx * 5}"/>`; }
      return `<svg class="b2-gh" width="${ctx.W}" height="${ctx.H}"><g class="ok"><line class="w" x1="${x0}" y1="${y0}" x2="${x1}" y2="${y1}"/>${t}</g></svg>` +
        `<div class="b2-cur fl" style="left:${(x0 + x1) / 2}px;top:${(y0 + y1) / 2 - 26}px;transform:translateX(-50%)">${m} m · ${pieces} piece${pieces > 1 ? "s" : ""} · <span style="color:var(--gold)">${money(pieces * 40)}</span></div>`;
    }
    const why = s.v === "car" || s.v === "funds" ? REASON[s.v] : inRadius(ctx, x, y) ? "" : REASON.radius;
    const r = 26, pts = [0, 1, 2, 3].map((k) => { const a = ((s.rot + 45 + k * 90) * Math.PI) / 180; return `${(x + r * Math.cos(a)).toFixed(1)},${(y + r * Math.sin(a) * 0.55).toFixed(1)}`; }).join(" ");
    return `<svg class="b2-gh" width="${ctx.W}" height="${ctx.H}"><defs><pattern id="b2hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="6" stroke="#ff5b47" stroke-width="2" opacity=".55"/></pattern></defs>` +
      `<polygon class="${why ? "bad" : "ok"}" points="${pts}"/></svg>` +
      `<div class="b2-ghic" style="left:${x}px;top:${y}px;color:${why ? "var(--bad)" : "var(--bone)"}">${ic("tower", 22)}</div>` +
      (why ? `<div class="b2-cur fl bad" style="left:${x + 30}px;top:${y + 6}px">${ic("alert", 13)}${why}</div>` : "");
  }
  TTZ.screen({
    id: "placement", num: 6, group: "In play", title: "Placing",
    initState: () => ({ tab: "structures", active: "struct.tower", v: "valid", rot: 0, mx: null, my: null }),
    notes: `<b>Placing</b>: one slim strip at top centre (420 pt) says what you are placing, what it costs and which keys do what. Everything else happens at the cursor.
<ul><li>Valid ghost: green outline, faint fill. Invalid: red outline with hatching and the reason next to the cursor, in a few words.</li>
<li>The build radius dashes show while placing, so "outside" is never a surprise. Move the mouse out of it to see the ghost turn red.</li>
<li>Walls are dragged: 4 m ticks along the line and one label with length, pieces and total price.</li>
<li><b>Q</b>/<b>E</b> rotate 15°; <b>Shift</b>+click keeps placing; <b>Esc</b> or right-click cancels.</li>
<li>Owner: should an unaffordable item still be placeable as a queued order that waits for funds?</li></ul>`,
    render(ctx) {
      const s = ctx.state;
      if (s.mx == null) { s.mx = START[s.v][0] * ctx.W; s.my = START[s.v][1] * ctx.H; }
      s.active = s.v === "wall" ? "struct.wall" : s.cancel ? null : "struct.tower";
      const card = TTZ.CARDS.structures.find((c) => c.id === s.active);
      let h = TTZ.frame(ctx, s, { funds: s.v === "funds" ? 150 : 3800 }) +
        TTZ.mock([["valid", "valid"], ["radius", "outside radius"], ["car", "blocked"], ["funds", "no funds"], ["wall", "wall drag"]], s.v);
      if (!card) return h + `<div class="b2-cur fl" style="left:50%;top:50%;transform:translate(-50%,-50%);color:var(--dim)">Cancelled. Pick a mock state to place again.</div>`;
      h += TTZ.banner(card, { poor: s.v === "funds" }) + TTZ.radius(0.43 * ctx.W, 0.5 * ctx.H, 0.17 * ctx.W, 0.12 * ctx.H);
      return h + `<div id="b2ghost">${ghost(ctx, s)}</div>`;
    },
    mount(root, ctx) {
      const s = ctx.state;
      TTZ.wireDock(root, ctx, s, () => {});
      root.querySelectorAll(".mock [data-v]").forEach((b) => b.addEventListener("click", () => { s.v = b.dataset.v; s.mx = null; s.cancel = false; ctx.rerender(); }));
      const g = root.querySelector("#b2ghost");
      root.addEventListener("mousemove", (e) => {
        if (!g || e.target.closest(".mock,.dock")) return;
        const hr = root.getBoundingClientRect(), k = ctx.u * ctx.fit;
        s.mx = (e.clientX - hr.left) / k; s.my = (e.clientY - hr.top) / k; g.innerHTML = ghost(ctx, s);
      });
      return (e) => {
        if (e.key === "q" || e.key === "Q") { s.rot -= 15; if (g) g.innerHTML = ghost(ctx, s); }
        else if (e.key === "e" || e.key === "E") { s.rot += 15; if (g) g.innerHTML = ghost(ctx, s); }
        else if (e.key === "Escape") { s.cancel = true; ctx.rerender(); }
        else TTZ.dockKeys(e, ctx, s, () => {});
      };
    },
  });

  /* ---------- 7 · alerts ---------- */
  const SEV = { crit: "var(--bad)", warn: "var(--warn)", gas: "var(--toxic)", loss: "var(--dim)", info: "var(--info)" };
  // list newest first: [{sev, ic, text, fresh, count, age (s, optional), isNew, id}]
  TTZ.alerts = (list) => `<div class="b2-alerts">` + list.slice(0, 5).map((a, i) =>
    `<div class="b2-al${a.isNew ? " new" : ""}${a.sev === "crit" ? " crit" : ""}" data-al="${a.id ?? i}">` +
    (a.fresh ? `<span class="b2-tail fl" style="animation-delay:${-(a.age || 0)}s">${esc(a.text)}${a.count > 1 ? ` <b>×${a.count}</b>` : ""}</span>` : "") +
    tok({ ic: a.ic, size: 30, isize: 17, round: true, ring: 1, ringCol: SEV[a.sev] || SEV.info, n: a.count > 1 ? "×" + a.count : null, tip: a.text + (a.count > 1 ? ` (×${a.count})` : "") }) + `</div>`).join("") + `</div>`;

  const POOL = [
    ["crit", "breach", "Wall breached"], ["crit", "kills", "Squad wiped out"],
    ["warn", "blood", "Rifle squad 2 under attack"], ["warn", "bullets", "MG squad 1 out of ammo"],
    ["gas", "gas", "Squad 3 standing in corpse gas"], ["loss", "grave", "Rifleman killed"],
    ["info", "airdrop", "Ammo drop inbound"], ["info", "tower", "Defense tower built"], ["info", "territory", "Territory secured 2,400 m²"],
  ];
  let uid = 0;
  const mk = (p, age = 99) => ({ id: ++uid, sev: p[0], ic: p[1], text: p[2], count: 1, t: performance.now() - age * 1000, wx: 0.2 + Math.random() * 0.55, wy: 0.3 + Math.random() * 0.4 });
  const RANK = { crit: 4, warn: 3, gas: 3, loss: 1, info: 0 };
  function push(list, p) {
    const ex = list.find((a) => a.text === p[2]);
    if (ex) { ex.count++; ex.t = performance.now(); list.splice(list.indexOf(ex), 1); list.unshift(ex); return; }
    list.unshift(mk(p, 0));
    while (list.length > 5) { // drop the oldest of the lowest severity
      let k = list.length - 1; for (let i = list.length - 1; i > 0; i--) if (RANK[list[i].sev] < RANK[list[k].sev]) k = i;
      list.splice(k, 1);
    }
  }
  TTZ.screen({
    id: "alerts", num: 7, group: "In play", title: "Alerts",
    initState: () => { const l = []; [POOL[5], POOL[4], POOL[2], POOL[2], POOL[2]].forEach((p) => push(l, p)); push(l, POOL[0]); l[0].t = performance.now() - 1000; l.forEach((a) => (a.isNew = 0)); return { tab: "units", list: l }; },
    notes: `<b>Alerts</b>: a column of round counters on the right edge, under the clock. Never more than 5, so the area is fixed.
<ul><li>The newest one says what happened in one line for 5 s, then folds into its counter. Hover any counter to read it again.</li>
<li>Ring colour is severity: red critical, amber warning, toxic green gas, grey loss, blue info. Repeats merge and count up (×3).</li>
<li>When a 6th arrives, the oldest of the lowest severity drops off. Critical alerts are dropped last.</li>
<li>Click jumps the camera to the place (ping); right-click dismisses.</li>
<li>Owner: a key to jump to the newest alert? Proposed <b>Backspace</b>, since Space is pause.</li></ul>`,
    render(ctx) {
      const s = ctx.state, now = performance.now();
      let h = TTZ.frame(ctx, s) + `<div class="mock"><button data-push>push random alert</button><button data-reset>reset</button></div>`;
      h += TTZ.alerts(s.list.map((a, i) => { const age = (now - a.t) / 1000; return { ...a, age, fresh: i === 0 && age < 5, isNew: age < 0.4 }; }));
      if (s.ping) { const p = TTZ.safe(ctx.W, ctx.H, s.ping.wx * ctx.W, s.ping.wy * ctx.H);
        h += `<div class="b2-ping" style="left:${p.x}px;top:${p.y}px;--c:${SEV[s.ping.sev]}" data-k="${s.ping.k}"><i></i><i></i></div>` +
          TTZ.marker({ kind: "status", ic: s.ping.ic, col: SEV[s.ping.sev], x: p.x, y: p.y - 10 }); }
      return h;
    },
    mount(root, ctx) {
      const s = ctx.state;
      TTZ.wireDock(root, ctx, s, () => {});
      root.querySelector("[data-push]").addEventListener("click", () => { push(s.list, POOL[Math.floor(Math.random() * POOL.length)]); ctx.rerender(); });
      root.querySelector("[data-reset]").addEventListener("click", () => { ctx.state.list = []; delete TTZ.screens.find((x) => x.id === "alerts")._state; ctx.rerender(); });
      const jump = (a) => { s.ping = { ...a, k: Math.random() }; ctx.rerender(); };
      root.querySelectorAll("[data-al]").forEach((el) => {
        const a = s.list.find((x) => String(x.id) === el.dataset.al);
        el.addEventListener("click", () => a && jump(a));
        el.addEventListener("contextmenu", (e) => { e.preventDefault(); s.list = s.list.filter((x) => x !== a); ctx.rerender(); });
      });
      return (e) => { if (e.key === "Backspace") { e.preventDefault(); if (s.list[0]) jump(s.list[0]); } else TTZ.dockKeys(e, ctx, s, () => {}); };
    },
  });
})();
