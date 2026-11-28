/* v2 screens owned by the main design thread: dock, selection. */
(function () {
  // mock-only controls (not part of the game HUD)
  TTZ.mock = (items, cur, attr = "v") => `<div class="mock">${items.map(([k, l]) => `<button data-${attr}="${k}" class="${k === cur ? "on" : ""}">${l}</button>`).join("")}</div>`;
  TTZ.wireMock = (root, ctx, key, attr = "v") => root.querySelectorAll(`.mock [data-${attr}]`).forEach((b) => b.addEventListener("click", () => { ctx.state[key] = b.dataset[attr]; ctx.rerender(); }));

  const picker = (ctx, s) => (id, why) => { if (why) { s.flash = why; } else { s.active = s.active === id ? null : id; s.flash = null; } ctx.rerender(); };

  TTZ.screen({
    id: "dock", num: 2, group: "In play", title: "Build dock",
    initState: () => ({ tab: "units", offset: 0, funds: 1200, v: "normal" }),
    notes: `<b>Build dock</b>, bottom centre: one row of 7 counters, 412×92 pt, always the same size. No frame; a soft shadow along the bottom edge of the screen keeps it readable.
<ul><li>Keys <b>1–7</b> pick the counter with that number; <b>Tab</b> / <b>Shift+Tab</b> switch category. Category names appear only for the open tab; the others are icons.</li>
<li>Names, descriptions and stats live in the tooltip, so the dock itself shows only icon, key and price.</li>
<li>Can't afford it or can't build it: the counter goes grey with a red slash, the price turns red and the tooltip says why. Funds are $1,200 here, so the MG squad is greyed.</li>
<li>More than 7 counters: arrows and the mouse wheel scroll the row (see "overfull" in the mock bar).</li></ul>`,
    render(ctx) {
      const s = ctx.state;
      s.cards = s.v === "overfull" ? TTZ.CARDS.structures.concat([{ id: "x.barricade", nm: "Barricade", ic: "barricade", cost: 25, d: "Sandbag line." }, { id: "x.crate", nm: "Supply crate", ic: "crate", cost: 80, d: "Small ammo cache." }, { id: "x.nest", nm: "MG nest", ic: "nest", cost: 300, d: "Fixed machine gun." }]) : null;
      if (s.v === "overfull") s.tab = "structures";
      s.disable = { "struct.tower": "Needs engineers: buy engineers first", "struct.light": "Needs a generator within 30 m" };
      let h = TTZ.frame(ctx, s, { funds: s.funds, income: 380 }) + TTZ.mock([["normal", "normal"], ["overfull", "overfull"]], s.v);
      if (s.flash) h += `<div class="fl" style="position:absolute;left:50%;bottom:110px;transform:translateX(-50%);color:var(--bad);font-weight:700;display:flex;gap:5px;align-items:center">${TTZ.ic("alert", 14)}${TTZ.esc(s.flash)}</div>`;
      if (s.active) { const c = (s.cards || TTZ.CARDS[s.tab]).find((x) => x.id === s.active); if (c) h += TTZ.banner ? TTZ.banner(c) : ""; }
      return h;
    },
    mount(root, ctx) {
      const s = ctx.state, p = picker(ctx, s);
      TTZ.wireDock(root, ctx, s, p); TTZ.wireMock(root, ctx, "v");
      return (e) => { if (e.key === "Escape") { s.active = null; s.flash = null; ctx.rerender(); return; } TTZ.dockKeys(e, ctx, s, p); };
    },
  });

  const M = (ic, hp, ammo, x = {}) => ({ ic, hp, ammo, ...x });
  const SEL = {
    rifle: { ic: "rifle", num: 2, name: "Rifle squad 2", state: "engaging", warn: [["bullets", "var(--warn)", "Low ammo"]],
      members: [M("rifle", 1, 0.6, { tip: "Sgt · engaging · 18 / 150" }), M("rifle", 0.8, 0.1, { tip: "Rifleman · reloading · 0 / 120" }), M("rifle", 0.2, 0.5, { wounded: 1, tip: "Rifleman · wounded · 22 / 60" }), M("rifle", 0.9, 0.2, { tip: "Rifleman · engaging · 6 / 30" }), M("rifle", 0, 0, { kia: 1, tip: "Rifleman · killed" })],
      actions: [{ ic: "garrison", key: "G", tip: "Garrison a building" }, { ic: "occupy", key: "O", off: 1, why: "No defense tower built", tip: "Occupy tower" }] },
    eng: { ic: "engineer", num: 1, name: "Engineers 1", state: "building",
      members: [M("build", 1, 1, { tip: "Engineer · building wall" }), M("engineer", 0.9, 1, { tip: "Engineer · covering" }), M("engineer", 0.7, 1, { tip: "Engineer · covering" })],
      actions: [{ ic: "wall", key: "N", tip: "Build wall" }, { ic: "gate", key: "J", tip: "Build gate" }, { ic: "disassemble", key: "K", tip: "Clear car" }, { ic: "undo", key: "^Z", tip: "Undo build" }] },
    flame: { ic: "flame", num: 1, name: "Flamethrowers 1", state: "moving", warn: [["fuel", "var(--warn)", "Fuel 30 %"]],
      members: [M("flame", 1, 0.3, { tip: "Flamer · fuel 30 %" }), M("flame", 0.6, 0.55, { tip: "Flamer · fuel 55 %" })],
      actions: [{ ic: "burn", key: "B", tip: "Burn area" }] },
    sniper: { ic: "sniper", num: 1, name: "Sniper 1", state: "engaging", warn: [["kills", "var(--dim)", "38 kills · on roof"]],
      members: [M("sniper", 0.85, 0.7, { tip: "Sniper · 5 / 40 · range 140 m" })],
      actions: [{ ic: "occupy", key: "O", tip: "Occupy tower" }, { ic: "garrison", key: "G", tip: "Garrison a building" }] },
  };
  const MULTI = [["rifle", 1, 0.9, "moving"], ["rifle", 2, 0.55, "engaging"], ["mg", 1, 0.8, "attacked"], ["sniper", 1, 0.85, "engaging"], ["engineer", 1, 0.9, "building"], ["flame", 1, 0.6, "moving"], ["rifle", 3, 1, "holding"], ["mg", 2, 0.3, "attacked"]];

  TTZ.screen({
    id: "selection", num: 3, group: "In play", title: "Selected squads",
    initState: () => ({ v: "rifle", pace: "auto", tab: "units", off: 0 }),
    notes: `<b>Selected squads</b>, bottom left, 336×112 pt fixed. No panel: the squad is a large counter and each soldier a small one.
<ul><li>A ring around each counter is health (green, amber, red; a wounded soldier's ring stays red). The thin line under a soldier is ammo, amber when low.</li>
<li>The squad state is one coloured word with an icon; warnings (low ammo, fuel, gas) sit on the same line.</li>
<li>Bottom row: Halt, then pace Auto / Run / Walk (<b>P</b> cycles), then what this squad can do. Actions it can't do right now are slashed; hover for the reason.</li>
<li>Hover a soldier for name, state and ammo. Several squads: one counter per squad, scrolling sideways past 7. Click one to select only it.</li></ul>`,
    render(ctx) {
      const s = ctx.state;
      let h = TTZ.frame(ctx, s) + TTZ.mock([["rifle", "rifle squad"], ["multi", "8 squads"], ["eng", "engineers"], ["flame", "flamers"], ["sniper", "sniper"]], s.v);
      if (s.v === "multi") {
        const vis = MULTI.slice(s.off, s.off + 7);
        h += `<div class="sel" id="sel"><div class="head"><div class="fl"><div class="nm">8 squads selected</div><div class="stt" style="color:var(--dim)">${TTZ.ic("troops", 13)}26 / 30 soldiers · <span style="color:var(--bad);margin-left:4px">2 under attack</span></div></div></div>` +
          `<div style="position:absolute;left:0;top:34px;display:flex;gap:6px;align-items:center">` +
          vis.map(([ic, n, hp, st]) => `<div style="display:grid;justify-items:center;gap:2px">${TTZ.tok({ ic, size: 36, isize: 21, round: true, ring: hp, n, tip: ic + " squad " + n + " · " + TTZ.STATE[st][2] })}<span style="color:${TTZ.STATE[st][1]}">${TTZ.ic(TTZ.STATE[st][0], 11)}</span></div>`).join("") +
          `<span class="fl" style="cursor:pointer;font-weight:800;font-size:16px;margin-left:2px;opacity:${MULTI.length > 7 ? 1 : 0}" data-more>›</span></div>` +
          `<div class="acts">${TTZ.tok({ ic: "halt", size: 28, isize: 17, key: "H", tip: "Halt all" })}<span class="sep"></span>${["auto", "run", "walk"].map((p) => TTZ.tok({ ic: p, size: 28, isize: 17, on: s.pace === p, attrs: ` data-pace="${p}"`, tip: "Pace: " + p })).join("")}</div></div>`;
      } else h += TTZ.selection({ ...SEL[s.v], pace: s.pace });
      return h;
    },
    mount(root, ctx) {
      const s = ctx.state;
      TTZ.wireDock(root, ctx, s, () => {}); TTZ.wireMock(root, ctx, "v");
      root.querySelectorAll("[data-pace]").forEach((b) => b.addEventListener("click", () => { s.pace = b.dataset.pace; ctx.rerender(); }));
      root.querySelector("[data-more]")?.addEventListener("click", () => { s.off = s.off ? 0 : 1; ctx.rerender(); });
      return (e) => { if (e.key === "p" || e.key === "P") { s.pace = { auto: "run", run: "walk", walk: "auto" }[s.pace]; ctx.rerender(); } else TTZ.dockKeys(e, ctx, s, () => {}); };
    },
  });

  TTZ.screen({
    id: "overview", num: 1, group: "In play", title: "Whole screen",
    initState: () => ({ tab: "units", offset: 0 }),
    notes: `<b>Whole screen</b>: everything you see during normal play, at once.
<ul><li>Four corners, one job each: money and forces top left, time top right, alerts down the right edge, your selected squad bottom left. Building is bottom centre.</li>
<li>Anything about a building, tower, car or light appears next to that object when you click or hover it, not in a side panel.</li>
<li>No frames anywhere: icons and numbers sit on the world with a shadow; only clickable things are solid counters.</li>
<li>Icons are game-icons.net silhouettes (CC BY 3.0, credit goes in the credits screen).</li></ul>`,
    render(ctx) {
      const s = ctx.state;
      let h = TTZ.frame(ctx, s, { funds: 3800, income: 530 });
      h += TTZ.selection({ ...SEL.rifle, pace: "auto" });
      if (TTZ.alerts) h += TTZ.alerts([
        { sev: "warn", ic: "alert", text: "Rifle squad 2 under attack", fresh: true },
        { sev: "gas", ic: "gas", text: "Squad 3 is standing in corpse gas" },
        { sev: "info", ic: "airdrop", text: "Ammo drop inbound" },
      ]);
      if (TTZ.marker) {
        h += TTZ.marker({ kind: "squad", ic: "rifle", n: 2, x: ctx.W * 0.5, y: ctx.H * 0.43, selected: true, attacked: true });
        h += TTZ.marker({ kind: "squad", ic: "sniper", n: 1, x: ctx.W * 0.36, y: ctx.H * 0.35 });
        h += TTZ.marker({ kind: "count", ic: "garrison", text: "5/12", x: ctx.W * 0.38, y: ctx.H * 0.2 });
      }
      return h;
    },
    mount(root, ctx) { TTZ.wireDock(root, ctx, ctx.state, () => {}); return (e) => TTZ.dockKeys(e, ctx, ctx.state, () => {}); },
  });
})();
