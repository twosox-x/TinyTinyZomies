/* Tiny Tiny Zombies HUD preview — core: stage, voxel icons, shared components, screen registry.
   Screens register with TTZ.screen({id, num, title, group, bg, notes, render(ctx) -> html, mount(root, ctx)}).
   ctx = { W, H (UI points), u (UI scale), res: '720'|'1080'|'1440', tod: 'day'|'night', rerender() } */
(function () {
  const TTZ = (window.TTZ = { screens: [] });
  TTZ.screen = (s) => TTZ.screens.push(s);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  TTZ.esc = esc;

  /* ---------- voxel icons: tiny iso models, 3 face shades (same scheme ImGui drawUiIcon uses) ---------- */
  const shade = (hex, f) => {
    const n = parseInt(hex.slice(1), 16);
    const r = Math.min(255, Math.round(((n >> 16) & 255) * f)), g = Math.min(255, Math.round(((n >> 8) & 255) * f)), b = Math.min(255, Math.round((n & 255) * f));
    return `rgb(${r},${g},${b})`;
  };
  // palette
  const P = { skin: "#d9b48a", olive: "#6f7a44", oliveD: "#4b5530", khaki: "#b9a774", steel: "#7d8589", dark: "#3a3d3f", wood: "#9a6b3f",
    woodL: "#c08c55", brass: "#e0a93b", red: "#c8402f", fire: "#f08a24", flame: "#ffd24a", conc: "#a9a596", white: "#e8e4d6", blue: "#5d8fb0",
    green: "#7ab04c", yellow: "#e4c23a", fuel: "#c8402f", zomb: "#8fa05a", sand: "#cdb98a", glass: "#9cc9d8" };
  // models: list of [x, y, z, w, d, h, colour]  (x right-back, y left-back, z up), unit = 1 voxel
  const M = {
    rifle:   [[1,1,0,1,1,2,P.oliveD],[1,1,2,1,1,2,P.olive],[1,1,4,1,1,1,P.skin],[1,1,5,1,1,0.5,P.oliveD],[2,1,3,2,0.5,0.5,P.dark]],
    mg:      [[1,1,0,1,1,2,P.oliveD],[1,1,2,1.2,1.2,2,P.olive],[1,1,4,1,1,1,P.skin],[1,1,5,1,1,0.5,P.oliveD],[2,0.8,2.6,3,0.7,0.7,P.dark],[2.4,0.8,2,0.5,0.6,0.6,P.brass]],
    sniper:  [[1,1,0,1,1,2,P.khaki],[1,1,2,1,1,2,P.khaki],[1,1,4,1,1,1,P.skin],[1,1,5,1,1,0.5,P.oliveD],[2,1.2,3.2,3.5,0.4,0.4,P.dark],[3,1.1,3.6,0.8,0.6,0.4,P.steel]],
    flame:   [[1,1,0,1,1,2,P.oliveD],[1,1,2,1,1,2,P.olive],[1,1,4,1,1,1,P.skin],[0,1,2,0.8,1,2,P.red],[2,1,2.8,1.6,0.5,0.5,P.steel],[3.6,1,2.6,1,0.6,1,P.fire],[4.4,1,2.8,0.6,0.5,0.6,P.flame]],
    engineer:[[1,1,0,1,1,2,P.oliveD],[1,1,2,1,1,2,P.yellow],[1,1,4,1,1,1,P.skin],[1,1,5,1.1,1.1,0.5,P.yellow],[2,1,2.5,0.4,0.4,2,P.wood],[2,0.7,4.2,0.4,1,0.6,P.steel]],
    container:[[0,0,0,4,2,2,P.olive],[0,0,2,4,2,0.2,P.oliveD],[1.8,-0.01,0.3,0.4,0.01,1.4,P.khaki]],
    airdrop: [[1,1,0,2,2,1.6,P.wood],[0.2,0.2,3.4,3.6,3.6,0.5,P.white],[1.5,1.5,1.6,1,1,1.8,P.khaki]],
    wall:    [[0,1,0,4,1,1.4,P.conc],[0,1,1.4,4,1,0.3,shadeHex(P.conc,0.85)]],
    wallTall:[[0,1,0,4,1,2.4,P.conc],[0,1,2.4,4,1,0.3,P.steel]],
    gate:    [[0,1,0,1,1,2.6,P.conc],[3,1,0,1,1,2.6,P.conc],[1,1.3,0,2,0.4,2,P.steel]],
    tower:   [[1,1,0,0.4,0.4,4,P.wood],[2.6,1,0,0.4,0.4,4,P.wood],[1,2.6,0,0.4,0.4,4,P.wood],[2.6,2.6,0,0.4,0.4,4,P.wood],[0.8,0.8,4,2.4,2.4,0.4,P.woodL],[0.8,0.8,4.4,2.4,0.2,1,P.sand],[0.8,0.8,4.4,0.2,2.4,1,P.sand]],
    light:   [[1.5,1.5,0,0.4,0.4,4,P.steel],[1,1,4,1.4,1.4,1,P.dark],[1,0.98,4.2,1.4,0.02,0.6,P.flame]],
    generator:[[0,0,0,3,2,1.6,P.olive],[0.3,0.3,1.6,1,1,0.6,P.dark],[2,0.5,1.6,0.6,0.6,0.4,P.steel],[2.98,0.4,0.4,0.02,1.2,0.8,P.brass]],
    fuel:    [[0,0,0,1.3,1.3,2,P.fuel],[1.6,0,0,1.3,1.3,2,P.fuel],[0.8,1.5,0,1.3,1.3,2,P.fuel],[0.4,0.4,2,0.4,0.4,0.3,P.dark]],
    crate:   [[0,0,0,2,2,2,P.wood],[0,0,2,2,2,0.1,P.woodL]],
    barricade:[[0,1,0,4,0.6,0.6,P.sand],[0.4,1,0.6,3.2,0.6,0.6,P.sand],[1,1,1.2,2,0.6,0.6,P.khaki]],
    garrison:[[0,0,0,3,3,3,P.conc],[0,-0.01,1,0.8,0.01,0.8,P.flame],[1.8,-0.01,1,0.8,0.01,0.8,P.dark],[0,0,3,3,3,0.3,P.olive]],
    hospital:[[0,0,0,3,3,2.6,P.white],[1.1,-0.01,0.8,0.8,0.01,1,P.red],[0.75,-0.01,1.1,1.5,0.01,0.4,P.red]],
    vehicle: [[0,0,0.4,4,2,1,P.oliveD],[1,0,1.4,2,2,0.8,P.olive],[0.4,-0.01,0,0.8,0.01,0.6,P.dark],[2.8,-0.01,0,0.8,0.01,0.6,P.dark]],
    car:     [[0,0,0.3,4,2,0.9,P.blue],[1,0.1,1.2,2,1.8,0.7,P.glass],[0.4,-0.01,0,0.8,0.01,0.5,P.dark],[2.8,-0.01,0,0.8,0.01,0.5,P.dark]],
    siphon:  [[0,0,0,1.6,1.6,2.4,P.fuel],[1.6,0.6,1.8,1.6,0.3,0.3,P.dark],[3,0.6,0,0.3,0.3,2.1,P.dark]],
    disassemble:[[0,0,0,2,1.2,0.8,P.blue],[2.6,0,0,1,1,0.8,P.blue],[1.2,1.6,0,1,1,0.5,P.dark],[1,0,1.4,0.4,0.4,1.6,P.steel]],
    zombie:  [[1,1,0,1,1,2,"#5a5a3f"],[1,1,2,1,1,2,"#6b4a3a"],[1,1,4,1,1,1,P.zomb],[2,1,3,1.6,0.5,0.5,P.zomb]],
    ammo:    [[0,0,0,2.4,1.4,1.4,P.olive],[0.2,0.2,1.4,0.4,0.4,0.8,P.brass],[0.9,0.2,1.4,0.4,0.4,0.8,P.brass],[1.6,0.2,1.4,0.4,0.4,0.8,P.brass]],
    burn:    [[0,0,0,3,3,0.2,P.dark],[0.6,0.6,0.2,1,1,1.4,P.fire],[1.6,1.2,0.2,1,1,2,P.fire],[1.8,1.4,2.2,0.6,0.6,0.8,P.flame],[0.8,0.8,1.6,0.6,0.6,0.6,P.flame]],
    build:   [[0,0,0,3,1,1,P.conc],[0,1,0,1,2,1,P.conc],[2,1.2,1,0.4,0.4,2.2,P.wood],[1.6,1,3,1.2,0.8,0.5,P.steel]],
  };
  function shadeHex(hex, f) { const c = shade(hex, f).match(/\d+/g).map(Number); return "#" + c.map((v) => v.toString(16).padStart(2, "0")).join(""); }
  M.wall[1][6] = shadeHex(P.conc, 0.85);
  const iso = (x, y, z) => [(x - y) * 0.866, (x + y) * 0.5 - z];
  function voxelSVG(name, size, opt = {}) {
    const m = M[name]; if (!m) return pixelSVG(name, size, opt);
    const boxes = m.slice().sort((a, b) => (a[0] + a[3] / 2 + a[1] + a[4] / 2 + a[2] * 0.5) - (b[0] + b[3] / 2 + b[1] + b[4] / 2 + b[2] * 0.5));
    let polys = "", minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
    const pt = (x, y, z) => { const [a, b] = iso(x, y, z); minX = Math.min(minX, a); maxX = Math.max(maxX, a); minY = Math.min(minY, b); maxY = Math.max(maxY, b); return a.toFixed(2) + "," + b.toFixed(2); };
    for (const [x, y, z, w, d, h, c] of boxes) {
      const col = opt.grey ? "#7a7868" : c;
      const top = [pt(x, y, z + h), pt(x + w, y, z + h), pt(x + w, y + d, z + h), pt(x, y + d, z + h)];
      const right = [pt(x, y, z), pt(x + w, y, z), pt(x + w, y, z + h), pt(x, y, z + h)];      // face toward viewer-right (y = min)
      const left = [pt(x, y, z), pt(x, y + d, z), pt(x, y + d, z + h), pt(x, y, z + h)];       // face toward viewer-left (x = min)
      polys += `<polygon points="${left.join(" ")}" fill="${shade(col, 0.62)}"/><polygon points="${right.join(" ")}" fill="${shade(col, 0.82)}"/><polygon points="${top.join(" ")}" fill="${shade(col, 1.08)}"/>`;
    }
    const pad = 0.3, w = maxX - minX + pad * 2, h = maxY - minY + pad * 2, s = Math.max(w, h);
    const vb = `${(minX + maxX) / 2 - s / 2} ${(minY + maxY) / 2 - s / 2} ${s} ${s}`;
    return `<svg class="vx" width="${size}" height="${size}" viewBox="${vb}" shape-rendering="crispEdges" aria-hidden="true">${polys}</svg>`;
  }
  /* pixel glyphs for verbs + stats (7x7, 1 = ink, 2 = accent) */
  const G = {
    halt:   ["0111110","1111111","1122211","1122211","1122211","1111111","0111110"],
    run:    ["0001100","0001100","0111000","1011110","0011000","0100100","1000010"],
    walk:   ["0011000","0011000","0011100","0111010","0011000","0010100","0010100"],
    auto:   ["0011100","0100010","1001001","1001101","1000001","0100010","0011100"],
    undo:   ["0010000","0110000","1111110","0110001","0010001","0000001","0011110"],
    funds:  ["0011100","0111110","1101011","0111110","1101011","0111110","0011100"],
    kills:  ["0111110","1111111","1001001","1111111","0110110","0101010","0000000"],
    troops: ["0010100","0111110","0010100","0111110","0110110","0110110","0100010"],
    terr:   ["1110111","1000001","1022201","0022200","1022201","1000001","1110111"],
    sun:    ["1001001","0101010","0011100","1111111","0011100","0101010","1001001"],
    moon:   ["0011100","0110000","1100000","1100000","1100000","0110000","0011100"],
    alert:  ["0001000","0011100","0012100","0112110","0110110","1112111","1111111"],
    gas:    ["0110110","1111111","0111110","0000000","0110110","1111111","0111110"],
    cross:  ["0011100","0011100","1111111","1111111","1111111","0011100","0011100"],
    occupy: ["0011100","0010100","0011100","0111110","0011100","0010100","0110110"],
    pause:  ["0000000","0110110","0110110","0110110","0110110","0110110","0000000"],
    gear:   ["0010100","0111110","1100011","0101010","1100011","0111110","0010100"],
    shield: ["1111111","1222221","1222221","1222221","0122210","0012100","0001000"],
    bolt:   ["0000110","0001100","0011000","0111110","0001100","0011000","0110000"],
    arrow:  ["0001000","0001100","1111110","1111111","1111110","0001100","0001000"],
    box:    ["0000000","1111111","1022201","1111111","1022201","1111111","0000000"],
    skull:  ["0111110","1111111","1001001","1111111","0110110","0101010","0000000"],
  };
  function pixelSVG(name, size, opt = {}) {
    const g = G[name]; if (!g) return `<svg width="${size}" height="${size}"></svg>`;
    const ink = opt.color || "currentColor", acc = opt.accent || "var(--brass)";
    let r = "";
    g.forEach((row, y) => [...row].forEach((c, x) => { if (c !== "0") r += `<rect x="${x}" y="${y}" width="1" height="1" fill="${c === "2" ? acc : ink}"/>`; }));
    return `<svg class="px" width="${size}" height="${size}" viewBox="-0.5 -0.5 8 8" shape-rendering="crispEdges" aria-hidden="true">${r}</svg>`;
  }
  TTZ.icon = (name, size = 28, opt) => voxelSVG(name, size, opt);
  TTZ.glyph = (name, size = 12, opt) => pixelSVG(name, size, opt);
  TTZ.iconNames = Object.keys(M); TTZ.glyphNames = Object.keys(G);

  /* ---------- small components ---------- */
  TTZ.key = (k, dim) => `<span class="key${dim ? " dim" : ""}">${esc(k)}</span>`;
  TTZ.pips = (v, of = 10, col) => { let s = `<span class="pips"${col ? ` style="--pc:${col}"` : ""}>`; for (let i = 0; i < of; i++) s += `<i${i < v ? ' class="f"' : ""}></i>`; return s + "</span>"; };
  TTZ.hpCol = (f) => (f > 0.6 ? "var(--hp-hi)" : f > 0.3 ? "var(--hp-mid)" : "var(--hp-lo)");
  TTZ.bar = (f, col, w) => `<span class="bar" style="display:block;${w ? "width:" + w + "px;" : ""}--pc:${col || "var(--stam)"}"><i style="width:${Math.round(f * 100)}%"></i></span>`;
  TTZ.btn = (label, o = {}) => `<button class="btn${o.on ? " on" : ""}${o.off ? " off" : ""}${o.cls ? " " + o.cls : ""}"${o.id ? ` data-id="${o.id}"` : ""}${o.why ? ` data-why="${esc(o.why)}"` : ""}>${o.glyph ? TTZ.glyph(o.glyph, 11) : ""}${o.icon ? TTZ.icon(o.icon, 16) : ""}${esc(label)}${o.k ? TTZ.key(o.k) : ""}</button>`;
  TTZ.plate = (o) => `<div class="plate${o.rivets ? " rivets" : ""}${o.cls ? " " + o.cls : ""}" style="${o.style || ""}"${o.id ? ` id="${o.id}"` : ""}>${o.html}</div>`;
  TTZ.money = (n) => "$" + n.toLocaleString("en-US");

  /* ---------- game data (from the HUD audit; keys = proposed 1–7 per tab) ---------- */
  TTZ.TABS = [
    { id: "units", name: "Units", glyph: "troops" },
    { id: "structures", name: "Structures", glyph: "shield" },
    { id: "supplies", name: "Supplies", glyph: "box" },
    { id: "engineering", name: "Engineering", glyph: "gear" },
    { id: "vehicles", name: "Vehicles", glyph: "arrow", later: true },
  ];
  TTZ.CARDS = {
    units: [
      { id: "unit.rifle", nm: "Rifle squad", ic: "rifle", cost: 1000, bdg: "x5", tip: "Five riflemen. All-round squad: holds streets, captures buildings.", stats: [["Soldiers", "5 × 100 hp"], ["Range", "60 m"], ["Fire", "600 rpm"], ["Ammo", "30 + 180"]] },
      { id: "unit.mg", nm: "MG squad", ic: "mg", cost: 1400, bdg: "x3", tip: "Machine gun + two loaders. Shreds hordes in a corridor; slow to move.", stats: [["Soldiers", "3 × 110 hp"], ["Range", "75 m"], ["Fire", "900 rpm"], ["Ammo", "200 + 600"]] },
      { id: "unit.sniper", nm: "Sniper", ic: "sniper", cost: 700, bdg: "x1", tip: "One marksman. Best on roofs and in towers.", stats: [["Soldiers", "1 × 90 hp"], ["Range", "140 m"], ["Fire", "40 rpm"], ["Ammo", "5 + 40"]] },
      { id: "unit.flame", nm: "Flamethrowers", ic: "flame", cost: 900, bdg: "x2", tip: "Two flamers. Burn corpses and gas, clear tight streets. Short range.", stats: [["Soldiers", "2 × 120 hp"], ["Range", "12 m"], ["Fuel", "100 %"]] },
      { id: "unit.engineer", nm: "Engineers", ic: "engineer", cost: 1200, bdg: "x3", tip: "Build walls, gates, towers; clear and siphon cars. One works, two cover.", stats: [["Soldiers", "3 × 90 hp"], ["Build radius", "35 m"]] },
    ],
    structures: [
      { id: "struct.wall", nm: "Wall 1.6 m", ic: "wall", cost: 40, suf: "/4m", tip: "Low wall. Stops walkers; climbers get over in time." },
      { id: "struct.wall2", nm: "Wall 2.4 m", ic: "wallTall", cost: 110, suf: "/4m", tip: "Reinforced wall. Holds a horde." },
      { id: "struct.gate", nm: "Gate", ic: "gate", cost: 120, suf: "/4m", tip: "Opens for your squads, shuts for the dead." },
      { id: "struct.tower", nm: "Def. tower", ic: "tower", cost: 200, tip: "Timber tower. Snipers or riflemen occupy it: +range, protected." },
      { id: "struct.light", nm: "Floodlight", ic: "light", cost: 40, tip: "Lights the street at night. Needs a powered generator in reach." },
      { id: "struct.generator", nm: "Generator", ic: "generator", cost: 150, tip: "Powers floodlights in 30 m. Burns fuel: 1 l / min." },
      { id: "struct.fuel", nm: "Fuel store", ic: "fuel", cost: 60, tip: "Holds siphoned fuel (200 l). Generators draw from it." },
    ],
    supplies: [
      { id: "sup.container", nm: "Ammo cont.", ic: "container", cost: 1500, tip: "Big ammo stock. Squads nearby refill automatically." },
      { id: "sup.airdrop", nm: "Ammo drop", ic: "airdrop", cost: 400, tip: "Parachute crate onto a squad's position." },
    ],
    engineering: [
      { id: "eng.clearcar", nm: "Clear car", ic: "disassemble", cost: 50, tip: "Engineers take a wreck apart. Gains fuel if a fuel store exists." },
      { id: "eng.siphon", nm: "Siphon fuel", ic: "siphon", cost: 0, tip: "Engineers drain a parked car and carry the fuel to the store." },
      { id: "eng.undo", nm: "Undo build", ic: "undo", cost: -1, keyOverride: "Ctrl+Z", tip: "Removes the last unfinished pieces and refunds them." },
    ],
    vehicles: [
      { id: "veh.jeep", nm: "Jeep", ic: "vehicle", later: true, tip: "Coming later." },
      { id: "veh.truck", nm: "Supply truck", ic: "container", later: true, tip: "Coming later." },
    ],
  };

  /* ---------- top bar ---------- */
  TTZ.topBar = (o = {}) => {
    const funds = o.funds ?? 3800, inc = o.income ?? 530, kills = o.kills ?? 146, troops = o.troops ?? 14, lost = o.lost ?? 2, terr = o.terr ?? 3.4, time = o.time ?? "21:40", tplus = o.tplus ?? "T+18:22";
    const night = o.night ?? true, frac = o.dayFrac ?? 0.9;
    return TTZ.plate({ cls: "topbar", html:
      `<div class="cell">${TTZ.glyph("funds", 12, { color: "var(--brass)", accent: "var(--plate-solid)" })}<span class="v money">${TTZ.money(funds)}</span><span class="s ${inc < 0 ? "c-bad" : "c-ok"}">${inc < 0 ? "" : "+"}${inc}/min</span></div>` +
      `<div class="cell">${TTZ.glyph("skull", 12)}<span class="v">${kills.toLocaleString("en-US")}</span><span class="s">kills</span></div>` +
      `<div class="cell">${TTZ.glyph("troops", 12)}<span class="v">${troops}</span><span class="s">troops${lost ? ` <span class="c-bad">−${lost}</span>` : ""}</span></div>` +
      `<div class="cell">${TTZ.glyph("terr", 12, { accent: "var(--ok)" })}<span class="v">${terr} ha</span><span class="s ${o.terrWarn ? "c-warn" : ""}">${o.terrNote ?? "secured"}</span></div>` +
      `<div class="cell clock">${TTZ.glyph(night ? "moon" : "sun", 12, { color: night ? "var(--intel)" : "var(--brass)" })}<span class="v">${time}</span><span class="daybar"><i style="left:${Math.round(frac * 52)}px"></i></span><span class="s">${tplus}</span></div>` });
  };

  /* ---------- command bar ---------- */
  // o: {tab, active (card id), hover (card id), funds, disable: {id: why}, cards (override list), offset (scroll index)}
  TTZ.commandBar = (o = {}) => {
    const tab = o.tab || "units", funds = o.funds ?? 3800;
    const list = o.cards || TTZ.CARDS[tab];
    let tabs = TTZ.TABS.map((t, i) => `<button data-tab="${t.id}" class="${t.id === tab ? "on" : ""}${t.later ? " later" : ""}">${TTZ.glyph(t.glyph, 10)}${t.name}</button>`).join("");
    tabs += `<span class="hint" title="Tab / Shift+Tab: next / previous category">${TTZ.key("Tab")}</span>`;
    let cards = list.map((c, i) => {
      const k = c.keyOverride || String(i + 1);
      let why = (o.disable && o.disable[c.id]) || (c.cost > 0 && c.cost > funds ? "Not enough funding" : "");
      const cls = ["card", c.later ? "later off" : "", why ? "off" : "", o.active === c.id ? "on" : ""].join(" ");
      const co = c.later ? "LATER" : c.cost > 0 ? `${TTZ.money(c.cost)}${c.suf ? `<small>${c.suf}</small>` : ""}` : c.cost === 0 ? "free" : "—";
      return `<div class="${cls}" data-card="${c.id}" data-i="${i}"${why ? ` data-why="${esc(why)}"` : ""}>${c.later ? "" : TTZ.key(k.length > 1 ? k : k, !!why)}${c.bdg ? `<span class="bdg">${c.bdg}</span>` : ""}<span class="ic">${TTZ.icon(c.ic, 34, { grey: !!c.later })}</span><span class="nm">${esc(c.nm)}</span><span class="co">${co}</span></div>`;
    });
    for (let i = list.length; i < 7; i++) cards.push(`<div class="card empty"></div>`);
    const off = o.offset || 0, over = list.length > 7;
    return TTZ.plate({ cls: "cmd rivets", id: "cmdbar", html:
      `<div class="tabs">${tabs}</div>` +
      `<div class="arrow l${!over || off === 0 ? " dis" : ""}" data-scroll="-1">‹</div>` +
      `<div class="row"><div class="strip" style="transform:translateX(${-off * 74}px)">${cards.join("")}</div></div>` +
      `<div class="arrow r${!over || off >= list.length - 7 ? " dis" : ""}" data-scroll="1">›</div>` });
  };
  TTZ.cardTip = (c, why, x, y) => `<div class="tip" style="left:${x}px;top:${y}px"><div class="tt">${TTZ.icon(c.ic, 20)}${esc(c.nm)}<span style="margin-left:auto" class="money">${c.cost > 0 ? TTZ.money(c.cost) + (c.suf || "") : ""}</span></div><div style="margin-top:4px">${esc(c.tip || "")}</div>${c.stats ? `<div class="stats">${c.stats.map(([a, b]) => `<span>${a}</span><b>${b}</b>`).join("")}</div>` : ""}${why ? `<div class="why">${esc(why)}</div>` : ""}</div>`;

  /* wires the command bar inside a root: tab switching, hover tooltips, scrolling, 1–7 keys. state = {tab, active, offset} */
  TTZ.wireCommandBar = (root, ctx, state, onPick) => {
    const bar = root.querySelector("#cmdbar"); if (!bar) return;
    bar.querySelectorAll("[data-tab]").forEach((b) => b.addEventListener("click", () => { state.tab = b.dataset.tab; state.offset = 0; state.active = null; ctx.rerender(); }));
    bar.querySelectorAll("[data-scroll]").forEach((b) => b.addEventListener("click", () => { const n = (state.cards || TTZ.CARDS[state.tab]).length; state.offset = Math.max(0, Math.min(n - 7, (state.offset || 0) + +b.dataset.scroll)); ctx.rerender(); }));
    bar.addEventListener("wheel", (e) => { const n = (state.cards || TTZ.CARDS[state.tab]).length; if (n <= 7) return; e.preventDefault(); state.offset = Math.max(0, Math.min(n - 7, (state.offset || 0) + Math.sign(e.deltaY))); ctx.rerender(); }, { passive: false });
    const hud = root;
    bar.querySelectorAll("[data-card]").forEach((el) => {
      el.addEventListener("mouseenter", () => {
        const c = (state.cards || TTZ.CARDS[state.tab]).find((x) => x.id === el.dataset.card);
        const r = el.getBoundingClientRect(), hr = hud.getBoundingClientRect(), s = ctx.u * ctx.fit;
        const x = Math.min(ctx.W - 230, Math.max(8, (r.left - hr.left) / s - 75)), y = (r.top - hr.top) / s - 8;
        hud.insertAdjacentHTML("beforeend", TTZ.cardTip(c, el.dataset.why, x, 0).replace("class=\"tip\"", "class=\"tip\" id=\"cardtip\""));
        const t = hud.querySelector("#cardtip"); t.style.top = y - t.offsetHeight + "px";
      });
      el.addEventListener("mouseleave", () => hud.querySelector("#cardtip")?.remove());
      el.addEventListener("click", () => { if (el.classList.contains("later")) return; if (onPick) onPick(el.dataset.card, el.dataset.why); });
    });
  };
  TTZ.cmdKeys = (e, ctx, state, onPick) => {
    const list = state.cards || TTZ.CARDS[state.tab];
    if (e.key === "Tab") { e.preventDefault(); const i = TTZ.TABS.findIndex((t) => t.id === state.tab); state.tab = TTZ.TABS[(i + (e.shiftKey ? 4 : 1)) % 5].id; state.offset = 0; state.active = null; ctx.rerender(); return true; }
    if (/^[1-7]$/.test(e.key) && !e.ctrlKey) { const c = list[+e.key - 1]; if (c && !c.later && onPick) onPick(c.id); return true; }
    return false;
  };
})();
