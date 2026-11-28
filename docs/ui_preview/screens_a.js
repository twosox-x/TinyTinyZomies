/* screens_a (v2): world objects. Info and actions sit in a world card at the object. */
(function () {
  const ic = TTZ.ic, tok = TTZ.tok, esc = TTZ.esc, money = TTZ.money;

  // ground outlines in background-image pixels (1920x1080, cover, 16:9 so it maps 1:1 to the UI)
  const OBJ = {
    garrison: { at: [0.40, 0.50], poly: [[515, 230], [958, 192], [966, 420], [836, 498], [598, 400], [520, 322]] },
    hospital: { at: [0.67, 0.505], poly: [[1192, 552], [1222, 540], [1482, 690], [1440, 782], [1186, 652]] },
    tower: { at: [0.275, 0.585], poly: [[470, 722], [528, 690], [588, 722], [528, 754]] },
    generator: { at: [0.224, 0.585], poly: [[400, 660], [430, 640], [462, 662], [432, 684]], radius: [432, 662, 300, 175] },
    light: { at: [0.327, 0.68], poly: [[612, 778], [628, 768], [644, 778], [628, 788]], cone: [[628, 778], [905, 690], [960, 860]] },
    fuel: { at: [0.662, 0.63], poly: [[1226, 690], [1262, 670], [1326, 710], [1290, 734]] },
    car: { at: [0.589, 0.515], poly: [[1108, 608], [1122, 568], [1156, 562], [1146, 614]] },
  };

  const UP = {
    door: { ic: "door", nm: "Doors", lv: ["none", "planks", "steel plate", "sandbags"], price: [30, 80, 60] },
    window: { ic: "window", nm: "Windows", lv: ["none", "planks", "steel plate", "sandbags"], price: [30, 80, 60] },
    nest: { ic: "nest", nm: "Roof nests", lv: ["none", "1 nest", "2 nests", "3 nests"], price: [60, 60, 60] },
  };

  const pips = (n, max, col = "var(--bone)") => `<span class="oa-pips">${Array.from({ length: max }, (_, i) => `<i class="${i < n ? "f" : ""}" style="${i < n ? "background:" + col : ""}"></i>`).join("")}</span>`;
  const stat = (i, v, tip, col) => `<span class="oa-st" data-tip="${esc(tip)}">${ic(i, 14, col ? "color:" + col : "")}<b>${v}</b></span>`;
  const gauge = (f, col) => `<span class="oa-g"><i style="width:${Math.round(f * 100)}%;background:${col}"></i></span>`;

  const SEL_RIFLE = { ic: "rifle", num: 2, name: "Rifle squad 2", state: "holding",
    members: [{ ic: "rifle", hp: 1, ammo: 0.8, tip: "Sgt · holding" }, { ic: "rifle", hp: 0.9, ammo: 0.6, tip: "Rifleman · holding" }, { ic: "rifle", hp: 0.7, ammo: 0.5, tip: "Rifleman · holding" }, { ic: "rifle", hp: 1, ammo: 0.9, tip: "Rifleman · holding" }, { ic: "rifle", hp: 0.85, ammo: 0.4, tip: "Rifleman · holding" }],
    actions: [{ ic: "garrison", key: "G", tip: "Garrison a building" }, { ic: "occupy", key: "O", tip: "Occupy tower" }] };
  const SEL_ENG = { ic: "engineer", num: 1, name: "Engineers 1", state: "holding",
    members: [{ ic: "engineer", hp: 1, ammo: 1, tip: "Engineer" }, { ic: "engineer", hp: 0.9, ammo: 1, tip: "Engineer" }, { ic: "engineer", hp: 0.7, ammo: 1, tip: "Engineer" }],
    actions: [{ ic: "wall", key: "N", tip: "Build wall" }, { ic: "gate", key: "J", tip: "Build gate" }, { ic: "disassemble", key: "K", tip: "Clear car" }, { ic: "undo", key: "^Z", tip: "Undo build" }] };

  function cardFor(ctx, s) {
    const o = OBJ[s.v === "towerfull" ? "tower" : s.v], x = o.at[0] * ctx.W, y = o.at[1] * ctx.H;
    switch (s.v) {
      case "garrison": {
        const slots = `<span class="oa-slots" data-tip="Positions: 5 of 12 manned">${Array.from({ length: 12 }, (_, i) => `<i class="${i < 5 ? "f" : ""}"></i>`).join("")}</span>`;
        const rows = Object.entries(UP).map(([k, u]) => {
          const lv = s.up[k], max = lv >= 3, price = max ? null : u.price[lv], poor = !max && price > s.funds;
          return `<div class="oa-up">${`<span class="oa-ui" data-tip="${esc(u.nm + ": " + u.lv[lv])}">${ic(u.ic, 16)}</span>`}${pips(lv, 3, "var(--ok)")}` +
            `<span class="oa-plus">${tok({ ic: "none", size: 22, isize: 2, cls: "oa-p", off: max || poor, why: max ? "Fully upgraded" : poor ? "Not enough funds" : "", tip: max ? u.nm + ": " + u.lv[3] : "Upgrade " + u.nm.toLowerCase() + " to " + u.lv[lv + 1], attrs: max || poor ? "" : ` data-up="${k}"` })}<span class="c">${max ? "" : money(price)}</span></span></div>`;
        }).join("");
        return TTZ.worldCard({ x, y, ic: "garrison", title: "Mid-rise", extra: `<span data-tip="9 floors · captured" style="display:inline-flex;gap:3px;align-items:center;color:var(--ok)">${ic("flag", 13)}9</span>`,
          body: `<div class="oa-row">${stat("troops", "5/12", "Garrison positions manned")}${slots}</div>` +
            `<div class="oa-row">${stat("ammo", "3/4", "Ammo stock: 3 of 4 crates")}${pips(3, 4)}</div><div class="oa-ups">${rows}</div>`,
          actions: [{ ic: "garrison", key: "G", tip: "Garrison: send the selected squad in" }, { ic: "exit", tip: "Leave: everyone out" }, { ic: "hospital", cost: 250, tip: "Switch to hospital (empties the positions)", off: s.funds < 250, why: s.funds < 250 ? "Not enough funds" : "" }] });
      }
      case "hospital": {
        const pts = [[0.35, "Rifleman · 35 HP · 1 min to full"], [0.62, "Sgt · 62 HP · 30 s to full"]];
        const beds = pts.map(([hp, t], i) => tok({ ic: "rifle", size: 26, isize: 15, round: true, ring: hp, tip: t, on: s.pick === i, attrs: ` data-pick="${i}"` })).join("") +
          Array.from({ length: 4 }, () => `<span class="oa-bed" data-tip="Free bed"></span>`).join("");
        return TTZ.worldCard({ x, y, ic: "hospital", title: "Hospital",
          body: `<div class="oa-row">${stat("medic", "2/6", "Beds 2 of 6 · heals 2 HP/s per patient")}</div><div class="oa-row oa-beds">${beds}</div>`,
          actions: [{ ic: "exit", tip: s.pick != null ? "Discharge this patient" : "Discharge all" }, { ic: "garrison", cost: 250, tip: "Switch to garrison" }] });
      }
      case "tower": case "towerfull": {
        const full = s.v === "towerfull";
        const occ = tok({ ic: "sniper", size: 26, isize: 15, round: true, ring: 0.85, tip: "Sniper 1 · 38 kills" }) +
          (full ? tok({ ic: "rifle", size: 26, isize: 15, round: true, ring: 0.6, tip: "Rifleman · rifle squad 2" }) : `<span class="oa-bed" data-tip="Free position"></span>`);
        return TTZ.worldCard({ x, y, ic: "tower", title: "Tower",
          body: `<div class="oa-row">${tok({ ic: "tower", size: 26, isize: 14, round: true, ring: 0.72, tip: "Hit points 360 / 500" })}<b class="oa-n">72%</b><span class="oa-gap"></span>${stat("troops", full ? "2/2" : "1/2", "Occupants")}${occ}</div>`,
          actions: [{ ic: "occupy", key: "O", tip: "Occupy with the selected squad", off: full, why: full ? "Tower full: 2 of 2" : "" }, { ic: "exit", tip: "Leave the tower" }, { ic: "wrench", cost: 40, tip: "Repair to full (engineers)" }] });
      }
      case "generator":
        return TTZ.worldCard({ x, y, ic: "generator", title: "Generator",
          body: `<div class="oa-row" data-tip="Fuel 34 l · burns 1 l a minute">${ic("fuel", 14, "color:var(--warn)")}${gauge(0.34, "var(--warn)")}<b>34 l</b><span class="oa-d">${ic("time", 12)}34 min</span></div>` +
            `<div class="oa-row">${stat("light", "3", "Powers 3 floodlights within 30 m")}</div>`,
          actions: [{ ic: "bolt", on: s.genOn, tip: s.genOn ? "Running: click to switch off" : "Off: click to switch on", id: "gen" }, { ic: "fuel", key: "R", tip: "Refuel from the fuel store" }] });
      case "light":
        return TTZ.worldCard({ x, y, ic: "light", title: "Floodlight",
          body: `<div class="oa-row" style="color:var(--bad)" data-tip="No generator within 30 m">${ic("bolt", 14)}<b>No power</b></div><div class="oa-why">No generator within 30 m</div>`,
          actions: [{ ic: "light", off: 1, why: "No power", tip: "Switch on" }, { ic: "generator", cost: 150, tip: "Build a generator next to it" }] });
      case "fuel":
        return TTZ.worldCard({ x, y, ic: "fuel", title: "Fuel store",
          body: `<div class="oa-row" data-tip="Fuel 120 of 200 l">${ic("barrel", 14)}${gauge(0.6, "var(--bone)")}<b>120/200 l</b></div>` +
            `<div class="oa-row">${stat("siphon", "2", "2 siphon trips on the way (+24 l)", "var(--info)")}</div>` });
      case "car":
        return TTZ.worldCard({ x, y, ic: "vehicle", title: "Sedan", extra: `<span data-tip="Fuel in the tank" style="display:inline-flex;gap:3px;align-items:center">${ic("fuel", 12)}12 l</span>`,
          actions: [{ ic: "siphon", off: 1, why: "No fuel store: build one", tip: "Siphon fuel (12 l)" }, { ic: "disassemble", key: "K", cost: 50, tip: "Disassemble the car" }] });
    }
  }

  function ground(ctx, s) {
    const k = s.v === "towerfull" ? "tower" : s.v, o = OBJ[k], hov = k === "car";
    const pts = (p) => p.map((q) => q.join(",")).join(" ");
    let g = "";
    if (o.radius) { const [cx, cy, rx, ry] = o.radius; g += `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="rgba(124,198,226,.06)" stroke="var(--info)" stroke-width="2" stroke-dasharray="10 8" opacity=".8"/>`; }
    if (o.cone) g += `<polygon points="${pts(o.cone)}" fill="rgba(20,20,16,.22)" stroke="#e8e2cc" stroke-width="2.5" stroke-dasharray="9 7" opacity=".85"/>`;
    if (k === "tower") g += `<g transform="translate(528 690)" opacity=".9">${`<rect x="-16" y="-40" width="32" height="68" fill="#4a4436" stroke="#2a261d" stroke-width="2"/><rect x="-24" y="-52" width="48" height="16" fill="#5a533f" stroke="#2a261d" stroke-width="2"/>`}</g>`;
    g += `<polygon points="${pts(o.poly)}" fill="none" stroke="rgba(0,0,0,.6)" stroke-width="7" stroke-linejoin="round"/>`;
    g += `<polygon points="${pts(o.poly)}" fill="${hov ? "rgba(241,234,216,.10)" : "rgba(244,183,64,.14)"}" stroke="${hov ? "var(--bone)" : "var(--gold)"}" stroke-width="3" ${hov ? 'stroke-dasharray="7 6"' : ""} stroke-linejoin="round"/>`;
    return `<svg class="oa-world" viewBox="0 0 1920 1080" preserveAspectRatio="none" style="width:${ctx.W}px;height:${ctx.H}px">${g}</svg>`;
  }

  TTZ.screen({
    id: "objects", num: 4, group: "In play", title: "Buildings and structures", status: "draft",
    initState: () => ({ v: "garrison", tab: "structures", funds: 3800, up: { door: 1, window: 0, nest: 0 }, genOn: true, pick: null }),
    notes: `<b>Buildings and structures</b>: click a world object and its card opens right above it, with a gold outline on the ground so it is clear what the card belongs to.
<ul><li>Each card is a title, one or two icon + number rows and a row of action counters. Names, rates and reasons sit in tooltips.</li>
<li>Garrison upgrades are three tracks (doors, windows, roof nests) with three pips each; the hammer counter buys the next level and shows its price. Click it to raise the level.</li>
<li>Ranges and reach are drawn on the ground: the generator's 30 m circle, the floodlight's cone (grey and dashed while it has no power).</li>
<li>Hover only (parked car) uses a dashed bone outline; a selected object uses gold.</li>
<li>Question: should the card stay open while the camera pans, or close once the object leaves the centre of the screen?</li></ul>`,
    render(ctx) {
      const s = ctx.state;
      let h = ground(ctx, s) + TTZ.frame(ctx, s, { funds: s.funds }) +
        TTZ.mock([["garrison", "garrison"], ["hospital", "hospital"], ["tower", "tower"], ["towerfull", "tower full"], ["generator", "generator"], ["light", "floodlight"], ["fuel", "fuel store"], ["car", "parked car (hover)"]], s.v);
      h += cardFor(ctx, s);
      if (["garrison", "tower", "towerfull"].includes(s.v)) h += TTZ.selection(SEL_RIFLE);
      if (s.v === "car") h += TTZ.selection(SEL_ENG);
      return h;
    },
    mount(root, ctx) {
      const s = ctx.state;
      TTZ.wireDock(root, ctx, s, () => {}); TTZ.wireMock(root, ctx, "v");
      root.querySelectorAll("[data-up]").forEach((b) => b.addEventListener("click", () => {
        const k = b.dataset.up, lv = s.up[k]; if (lv >= 3) return;
        s.funds -= UP[k].price[lv]; s.up[k] = lv + 1; ctx.rerender();
      }));
      root.querySelectorAll("[data-pick]").forEach((b) => b.addEventListener("click", () => { s.pick = s.pick === +b.dataset.pick ? null : +b.dataset.pick; ctx.rerender(); }));
      root.querySelector('[data-id="gen"]')?.addEventListener("click", () => { s.genOn = !s.genOn; ctx.rerender(); });
      return (e) => { TTZ.dockKeys(e, ctx, s, () => {}); };
    },
  });
})();
