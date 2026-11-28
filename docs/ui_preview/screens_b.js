/* screens_b — group "World & feedback": 6 world hover menus + labels, 7 placement mode, 8 notification feed.
   World-anchored things use % of the stage (bg is cover, 16:9 everywhere) so they stay on the same spot of the city. */
(function () {
  const esc = TTZ.esc;
  const at = (x, y) => `left:${x}%;top:${y}%`;
  /* extra 7x7 glyphs local to these screens (same format as TTZ.glyph) */
  const G2 = {
    chev:  ["0010000","0011000","0001100","0000110","0001100","0011000","0010000"],
    flag:  ["1111100","1222110","1222211","1222110","1111100","1000000","1000000"],
    breach:["1100011","1101011","0001000","0010100","0001000","1101011","1100011"],
    drop:  ["0111110","1111111","0100010","0010100","0001000","0011100","0011100"],
    hammer:["1111100","1111110","0011100","0001000","0001000","0001000","0001000"],
    cog:   ["0010100","0111110","1100011","0101010","1100011","0111110","0010100"],
  };
  const g2 = (name, size = 11, col) => {
    const g = G2[name]; if (!g) return TTZ.glyph(name, size, { color: col });
    let r = "";
    g.forEach((row, y) => [...row].forEach((c, x) => { if (c !== "0") r += `<rect x="${x}" y="${y}" width="1" height="1" fill="${c === "2" ? "var(--plate-solid)" : col || "currentColor"}"/>`; }));
    return `<svg class="px" width="${size}" height="${size}" viewBox="-0.5 -0.5 8 8" shape-rendering="crispEdges" aria-hidden="true">${r}</svg>`;
  };
  const cmdState = (tab, active) => ({ tab, active, offset: 0 });

  /* =====================================================================================
     6 · World hover menus + world labels
     ===================================================================================== */
  const LBL_MODES = [
    { id: "near", nm: "Zoomed in", max: 3 },
    { id: "far", nm: "Zoomed out", max: 1 },
    { id: "raw", nm: "No rule", max: 9 },
  ];
  TTZ.screen({
    id: "world-labels", num: 6, group: "World & feedback", title: "World hover menus + labels", status: "draft",
    notes: `<b>World labels: 4 priority tiers.</b> <ul>
      <li><b>T0 alerts</b> (BREACH pulsing red, capture progress) always show, even zoomed out. <b>T1</b> squad flags + the build radius of the selected engineers. <b>T2</b> occupancy counts (GARRISON 5/12, HOSPITAL 2/6). <b>T3</b> status chips + stock (WORKING, QUEUED, Ammo 640) only when zoomed in. Use the <b>LABELS</b> chip (or <span class="key">L</span>, mock only) to compare with "No rule".</li>
      <li>Squad flags: stencil pennant with the squad number. The selected squad gets a brass pennant + name; others stay khaki and number-only. A flag never has more than one extra line (state: under attack / gas).</li>
      <li>Hover menu = small plate on a leader line from a pin on the object; it opens on hover only when the current selection can act on it (engineers → car, shooters → tower). Disabled entries stay listed, hatched, with the reason in red underneath.</li>
      <li>Build radius: one dashed ellipse on the ground (SVG, perspective-squashed) and exactly one label on its rim, not a label per segment.</li>
      <li><b>Owner?</b> Hover-menu keys: K = Disassemble, O = Occupy as asked; Siphon has no key yet (F?). Should menus also open on RMB-hold for players who don't hover?</li>
      <li><b>Owner?</b> Is "far zoom" one threshold, or should T2 fade out between two zoom levels?</li></ul>`,
    initState() { return { cmd: cmdState("engineering", null), mode: "near" }; },
    render(ctx) {
      const s = ctx.state, mode = LBL_MODES.find((m) => m.id === s.mode), max = mode.max;
      const show = (t) => t <= max;
      let w = "";
      /* ground layer: build radius ring + queued wall + selection ring (SVG in % space) */
      w += `<svg class="wb-ground" viewBox="0 0 100 100" preserveAspectRatio="none">
        ${show(1) ? `<ellipse cx="39.5" cy="49.5" rx="10.5" ry="11" class="wb-ring"/>` : ""}
        <ellipse cx="50" cy="50.2" rx="2.6" ry="3.4" class="wb-sel"/>
        ${show(3) ? `<line x1="27.5" y1="47" x2="32.5" y2="42.5" class="wb-queued"/>` : ""}
        <ellipse cx="70.5" cy="77" rx="3.2" ry="2.6" class="wb-breachring"/>
      </svg>`;
      if (show(1)) w += `<div class="wl wb-ringlbl" style="${at(31.5, 58.5)}">${g2("hammer", 9)}BUILD RADIUS <b>35 m</b></div>`;
      /* placed props (towers, container) — voxel icons standing in for world objects */
      w += `<div class="wb-prop" style="${at(61, 54)}">${TTZ.icon("tower", 40)}</div>`;
      w += `<div class="wb-prop" style="${at(58.5, 72.5)}">${TTZ.icon("tower", 40)}</div>`;
      w += `<div class="wb-prop" style="${at(27.5, 70)}">${TTZ.icon("container", 36)}</div>`;
      /* T0 */
      w += `<div class="wb-alert" style="${at(70.5, 73)}">${TTZ.glyph("alert", 12, { color: "#fff", accent: "var(--bad)" })}BREACH<small>east wall</small></div>`;
      w += `<div class="wb-cap" style="${at(76, 37)}"><span class="tag brass">CAPTURING</span><span>Office · 9 fl</span><b>62%</b>${TTZ.bar(0.62, "var(--brass)", 118)}</div>`;
      /* T1 squad flags */
      const flag = (x, y, n, o = {}) => `<div class="wb-flag${o.sel ? " sel" : ""}${o.st ? " st-" + o.st : ""}" style="${at(x, y)}"><span class="pn">${n}</span>${o.sel && max >= 1 ? `<span class="nm">Rifle squad 2</span>` : ""}${o.note ? `<span class="nt">${o.note}</span>` : ""}</div>`;
      w += flag(50, 45.4, 2, { sel: 1 });
      w += flag(55.5, 57.5, 1, { st: "atk", note: s.mode === "far" ? "" : "under attack" });
      w += flag(33, 76.5, 3, { st: "gas", note: s.mode === "far" ? "" : "corpse gas" });
      w += flag(39.5, 46.5, "E", {});
      /* T2 occupancy */
      if (show(2)) {
        w += `<div class="wb-occ" style="${at(42, 27)}">${TTZ.glyph("occupy", 10)}<span>GARRISON</span><b>5/12</b></div>`;
        w += `<div class="wb-occ" style="${at(85, 60)}">${TTZ.glyph("cross", 10, { color: "var(--bad)" })}<span>HOSPITAL</span><b>2/6</b></div>`;
        w += `<div class="wb-occ sm" style="${at(61, 47.5)}">${TTZ.glyph("occupy", 9)}<b>2/4</b></div>`;
        w += `<div class="wb-occ sm full" style="${at(58.5, 66)}">${TTZ.glyph("occupy", 9)}<b>4/4</b></div>`;
      }
      /* T3 chips + stock */
      if (show(3)) {
        w += `<div class="wb-chip work" style="${at(41.5, 42.6)}">${g2("cog", 9)}WORKING</div>`;
        w += `<div class="wb-chip" style="${at(28.6, 42.4)}">QUEUED · 2</div>`;
        w += `<div class="wl wb-stock" style="${at(27.5, 65.5)}">${TTZ.icon("ammo", 14)}Ammo <b>640</b></div>`;
      }
      /* "no rule" clutter: what it looks like without tiers */
      if (s.mode === "raw") {
        const junk = [[37, 52, "Parked car"], [40, 45, "Parked car"], [36, 46, "Parked car"], [52, 40, "Parked car"], [48, 62, "Rifleman 92 hp"], [52, 51, "Rifleman 100 hp"], [50, 53, "Rifleman 64 hp"], [44, 56, "Street lamp"],
          [55, 61, "Rifleman 71 hp"], [46, 68, "MG gunner 110 hp"], [60, 42, "Traffic light"], [66, 50, "Office · 9 fl"], [38, 30, "Office · 14 fl"], [30, 55, "Tree"], [63, 60, "Parked car"], [72, 68, "Zombie x14"], [68, 80, "Zombie x9"], [33, 50, "Sandbags"]];
        w += junk.map(([x, y, t]) => `<div class="wl wb-junk" style="${at(x, y)}">${t}</div>`).join("");
      }
      /* hover-able objects with menus */
      const obj = (id, x, y, ring, menu, open) => `<div class="wb-obj${open ? " open" : ""}" data-obj="${id}" style="${at(x, y)}"><div class="wb-hot" style="width:${ring[0]}px;height:${ring[1]}px"></div><i class="wb-pin"></i>${menu}</div>`;
      const mi = (o) => `<div class="wb-mi${o.off ? " off" : ""}">${TTZ.icon(o.ic, 18, { grey: !!o.off })}<span class="t">${o.t}${o.sub ? `<small>${o.sub}</small>` : ""}</span>${o.cost ? `<span class="money">${o.cost}</span>` : ""}${o.k ? TTZ.key(o.k, !!o.off) : ""}${o.off ? `<span class="why">${esc(o.off)}</span>` : ""}</div>`;
      const menu = (dir, head, ctxt, items) => `<div class="wb-menu ${dir}"><svg class="wb-lead" width="34" height="26"><polyline points="${dir === "dl" ? "34,0 10,0 0,26" : "0,26 24,26 34,0"}"/></svg><div class="plate sm wb-mp"><div class="wb-mh"><span class="tag">${head}</span><span class="c">${ctxt}</span></div>${items.map(mi).join("")}</div></div>`;
      w += obj("car", 37.2, 56.8, [46, 28], menu("dr", "Parked car", "Engineers selected", [
        { ic: "siphon", t: "Siphon fuel", sub: "12 l to base", off: "No fuel store: build one" },
        { ic: "disassemble", t: "Disassemble", sub: "+fuel", cost: "$50", k: "K" },
      ]), s.open === "car");
      w += obj("tower", 61, 54, [34, 40], menu("dr", "Defense tower", "Rifle squad 2 · 2/4", [{ ic: "tower", t: "Occupy tower", sub: "+range, cover", k: "O" }]), s.open === "tower");
      w += obj("tower2", 58.5, 72.5, [34, 40], menu("dr", "Defense tower", "Rifle squad 2 · 4/4", [{ ic: "tower", t: "Occupy tower", off: "Tower full", k: "O" }]), s.open === "tower2");
      const chips = LBL_MODES.map((m) => `<button class="btn${m.id === s.mode ? " on" : ""}" data-mode="${m.id}">${m.nm}</button>`).join("");
      return `<div class="wb-world m-${s.mode}">${w}</div>` +
        TTZ.topBar({ night: ctx.night, time: ctx.night ? "21:40" : "13:05", dayFrac: ctx.night ? 0.9 : 0.55 }) +
        TTZ.plate({ cls: "wb-lblchip", html: `<span class="tag dim">Labels</span>${chips}` }) +
        TTZ.commandBar(s.cmd);
    },
    mount(root, ctx) {
      const s = ctx.state;
      if (s.open === undefined) s.open = "car";
      root.querySelectorAll(".wb-obj").forEach((o) => {
        if (o.dataset.obj === s.open) o.classList.add("open");
        o.addEventListener("mouseenter", () => { root.querySelectorAll(".wb-obj.open").forEach((x) => x.classList.remove("open")); s.open = o.dataset.obj; o.classList.add("open"); });
      });
      root.querySelectorAll("[data-mode]").forEach((b) => b.addEventListener("click", () => { s.mode = b.dataset.mode; ctx.rerender(); }));
      TTZ.wireCommandBar(root, ctx, s.cmd, (id) => { s.cmd.active = s.cmd.active === id ? null : id; ctx.rerender(); });
      return (e) => {
        if (e.key === "l" || e.key === "L") { const i = LBL_MODES.findIndex((m) => m.id === s.mode); s.mode = LBL_MODES[(i + 1) % 3].id; ctx.rerender(); return; }
        TTZ.cmdKeys(e, ctx, s.cmd, (id) => { s.cmd.active = id; ctx.rerender(); });
      };
    },
  });

  /* =====================================================================================
     7 · Placement mode
     ===================================================================================== */
  const REASONS = [
    { id: "radius", t: "Outside build radius", sub: "move closer to Engineers" },
    { id: "car", t: "Blocked by car", sub: "clear it first (Disassemble K)" },
    { id: "funds", t: "Not enough funding", sub: "need $200 · have $150" },
  ];
  TTZ.screen({
    id: "placement", num: 7, group: "World & feedback", title: "Placement mode", status: "draft",
    notes: `<b>Placement: the banner says what you are placing and how to get out.</b> <ul>
      <li>Banner (top, 420×40) has two fixed lines: what + cost, then the four verbs with key badges. It replaces nothing else, so the top bar and the feed stay readable.</li>
      <li>Ghost: <b>valid</b> = cool bone-green outline + 25% fill; <b>invalid</b> = red hatched footprint + greyed model, and the reason sits at the cursor (one reason, the most actionable one) with a hint on how to fix it.</li>
      <li>Wall drag shows type · length · pieces · cost in one label at the cursor; tick marks on the ghost line show each 4 m piece.</li>
      <li>Mock: press <span class="key">1</span> valid, <span class="key">2</span> invalid (press again to cycle reasons), <span class="key">3</span> wall drag, or use the MOCK chips; move the mouse to move the ghost. <span class="key">Q</span>/<span class="key">E</span> rotate.</li>
      <li><b>Owner?</b> During placement, should keys 1–7 still pick other cards (they do now in the command bar)? It collides with the mock keys here only.</li>
      <li><b>Owner?</b> Invalid + funds: grey the banner cost red too (done) or also shake it on click?</li></ul>`,
    initState() { return { st: "valid", reason: 0, rot: 0, mx: null, my: null }; },
    render(ctx) {
      const s = ctx.state, wall = s.st === "wall", bad = s.st === "invalid", r = REASONS[s.reason];
      const funds = bad && r.id === "funds" ? 150 : 3800;
      const far = bad && r.id === "radius", mx = s.mx ?? ctx.W * (far ? 0.62 : 0.47), my = s.my ?? ctx.H * (far ? 0.6 : 0.52);
      const cmd = cmdState("structures", wall ? "struct.wall" : "struct.tower");
      if (funds < 200) cmd.funds = funds;
      let w = `<svg class="wb-ground" viewBox="0 0 100 100" preserveAspectRatio="none"><ellipse cx="44" cy="52" rx="13" ry="15" class="wb-ring"/></svg>`;
      w += `<div class="wl wb-ringlbl" style="${at(51, 68.6)}">${g2("hammer", 9)}BUILD RADIUS <b>35 m</b></div>`;
      w += `<div class="wb-flag sel" style="${at(42, 49)}"><span class="pn">E</span><span class="nm">Engineers 1</span></div>`;
      w += `<div id="wb-ghost">${ghost(s, mx, my)}</div>`;
      const title = wall ? `Wall 1.6 m` : "Defense tower";
      const cost = wall ? `$40<small>/4 m</small>` : "$200";
      const hints = wall ? [["LMB", "drag"], ["Shift", "chain"], ["Ctrl", "snap"], ["RMB/Esc", "cancel"]] : [["LMB", "place"], ["Shift", "keep"], ["Q/E", "rotate"], ["RMB/Esc", "cancel"]];
      const banner = TTZ.plate({ cls: "wb-banner rivets", html:
        `<div class="l1"><span class="tag brass">Placing</span><span class="nm">${title}</span><span class="cost${bad && r.id === "funds" ? " c-bad" : " money"}">${cost}</span></div>` +
        `<div class="l2">${hints.map(([k, t]) => `${k.split("/").map((x) => TTZ.key(x)).join("")}<span>${t}</span>`).join('<i>·</i>')}</div>` });
      const mock = TTZ.plate({ cls: "wb-mock", html: `<span class="tag dim">Mock</span>` +
        [["valid", "1 Valid"], ["invalid", "2 Invalid"], ["wall", "3 Wall drag"]].map(([k, t]) => `<button class="btn${s.st === k ? " on" : ""}" data-st="${k}">${t}</button>`).join("") });
      return `<div class="wb-world" id="wb-world">${w}</div>` + TTZ.topBar({ funds, night: ctx.night, time: ctx.night ? "21:40" : "13:05", dayFrac: ctx.night ? 0.9 : 0.55 }) + banner + mock + TTZ.commandBar(cmd);
    },
    mount(root, ctx) {
      const s = ctx.state, world = root.querySelector("#wb-world");
      const setSt = (k) => { if (k === "invalid" && s.st === "invalid") s.reason = (s.reason + 1) % REASONS.length; s.st = k; ctx.rerender(); };
      root.querySelectorAll("[data-st]").forEach((b) => b.addEventListener("click", () => setSt(b.dataset.st)));
      world.addEventListener("mousemove", (e) => {
        const hr = root.getBoundingClientRect(), sc = ctx.u * ctx.fit;
        s.mx = (e.clientX - hr.left) / sc; s.my = (e.clientY - hr.top) / sc;
        root.querySelector("#wb-ghost").innerHTML = ghost(s, s.mx, s.my);
      });
      TTZ.wireCommandBar(root, ctx, cmdState("structures", s.st === "wall" ? "struct.wall" : "struct.tower"), (id) => { s.st = id === "struct.wall" || id === "struct.wall2" ? "wall" : "valid"; ctx.rerender(); });
      return (e) => {
        if (e.key === "1") return setSt("valid");
        if (e.key === "2") return setSt("invalid");
        if (e.key === "3") return setSt("wall");
        if (e.key === "q" || e.key === "Q") { s.rot = (s.rot + 3) % 4; root.querySelector("#wb-ghost").innerHTML = ghost(s, s.mx ?? ctx.W * 0.47, s.my ?? ctx.H * 0.52); return; }
        if (e.key === "e" || e.key === "E") { s.rot = (s.rot + 1) % 4; root.querySelector("#wb-ghost").innerHTML = ghost(s, s.mx ?? ctx.W * 0.47, s.my ?? ctx.H * 0.52); return; }
        if (e.key === "Escape") { s.st = "valid"; ctx.rerender(); return; }
        TTZ.cmdKeys(e, ctx, cmdState("structures", null), () => {});
      };
    },
  });
  function ghost(s, mx, my) {
    const bad = s.st === "invalid", r = REASONS[s.reason];
    if (s.st === "wall") {
      const ax = mx - 128, ay = my + 44; // drag anchor (where LMB went down)
      const dx = mx - ax, dy = my - ay, len = Math.hypot(dx, dy), m = Math.max(1, Math.round(len / 11.3)), pieces = Math.ceil(m / 4);
      let ticks = "";
      for (let i = 1; i < pieces; i++) { const f = (i * 4) / m; if (f < 1) ticks += `<circle cx="${ax + dx * f}" cy="${ay + dy * f}" r="2.5" class="wb-tick"/>`; }
      return `<svg class="wb-gsvg"><line x1="${ax}" y1="${ay}" x2="${mx}" y2="${my}" class="wb-wall"/><line x1="${ax}" y1="${ay}" x2="${mx}" y2="${my}" class="wb-wall2"/>${ticks}<circle cx="${ax}" cy="${ay}" r="3.5" class="wb-anchor"/></svg>` +
        `<div class="wb-curlbl ok" style="left:${mx + 14}px;top:${my - 30}px">${TTZ.icon("wall", 16)}<b>Wall 1.6 m</b><i>·</i>${m} m<i>·</i>${pieces} piece${pieces > 1 ? "s" : ""}<i>·</i><span class="money">$${pieces * 40}</span></div>`;
    }
    const deg = [0, 90, 180, 270][s.rot];
    return `<div class="wb-ghost ${bad ? "bad" : "ok"}" style="left:${mx}px;top:${my}px">
      <svg class="fp" width="76" height="44" viewBox="0 0 76 44"><defs><pattern id="wbhatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="3" height="6" fill="rgba(229,73,58,.55)"/></pattern></defs><polygon points="38,2 74,22 38,42 2,22"/></svg>
      <div class="face" style="transform:translate(-50%,-50%) scaleY(.55) rotate(${deg}deg)">${TTZ.glyph("arrow", 14)}</div>
      <div class="mdl">${TTZ.icon("tower", 58, { grey: bad })}</div></div>` +
      (bad ? `<div class="wb-curlbl bad" style="left:${mx + 34}px;top:${my - 6}px">${TTZ.glyph("alert", 12, { color: "#fff", accent: "var(--bad)" })}<b>${r.t}</b><small>${r.sub}</small></div>` : `<div class="wb-curlbl ok sm" style="left:${mx + 34}px;top:${my - 2}px">${TTZ.glyph("shield", 10, { color: "var(--ok)", accent: "var(--plate-solid)" })}Facing ${["N", "E", "S", "W"][s.rot]}</div>`);
  }

  /* =====================================================================================
     8 · Notification feed
     ===================================================================================== */
  const SEV = { crit: "Critical", warn: "Warning", toxic: "Hazard", loss: "Loss", info: "Info" };
  const GLY = { crit: "alert", warn: "alert", toxic: "gas", loss: "skull", info: "arrow" };
  const POOL = [
    ["crit", "Wall breached", [70, 76]], ["crit", "Breach! A controlled territory is open to the horde", [72, 70]], ["crit", "MG squad 1 wiped out", [55, 60]],
    ["warn", "Rifle squad 2 under attack", [50, 47]], ["warn", "MG squad 1 out of ammo", [55, 60]], ["warn", "Generator out of fuel: the lights go dark", [36, 38]],
    ["toxic", "Squad 3 is standing in corpse gas", [45, 65]], ["loss", "Rifleman KIA · Rifle squad 2", [50, 47]], ["loss", "Rifle squad 4 lost a soldier", [62, 50]],
    ["info", "Ammo drop inbound (rooftop drop)", [40, 30]], ["info", "Defense tower built", [61, 54]], ["info", "Territory secured: 2,400 m2 under control", [44, 58]],
    ["info", "Building captured (office, 9 floors)", [76, 40]], ["warn", "Not enough funding", null],
  ];
  const mk = (i, age, n = 1) => ({ sev: POOL[i][0], t: POOL[i][1], loc: POOL[i][2], age, n, id: Math.random() });
  TTZ.screen({
    id: "notifications", num: 8, group: "World & feedback", title: "Notification feed", status: "draft",
    notes: `<b>Feed: fixed 280×150 box, 6 rows of 22, never grows.</b> <ul>
      <li>Severity = left stripe colour + 7×7 glyph (shape differs, so it also reads colour-blind): <b>critical</b> red, stripe pulses + tinted row; <b>warning</b> amber; <b>hazard</b> toxic green (corpse gas); <b>loss</b> muted rust + skull; <b>info</b> intel blue.</li>
      <li>Newest on top. Rows 4–6 compact (dimmer, no age). Same message within 20 s merges into one row with a ×N stamp and jumps back to the top instead of adding a row.</li>
      <li>Click a row = camera jumps to the event (ping ring in the world). RMB on a row = dismiss. <span class="key">Backspace</span> = jump to the newest critical/warning (proposal; Space is pause, J is taken).</li>
      <li>Mock: the MOCK chips (or <span class="key">N</span>) push a random entry with the slide-in animation; "Dup" re-sends the top message to show the ×N merge.</li>
      <li><b>Owner?</b> Should info rows auto-expire (e.g. 30 s) while critical rows stay until clicked? Do we want a full message log behind the feed (key?) for what scrolled off?</li></ul>`,
    initState() { return { list: [mk(0, 3), mk(3, 6, 3), mk(6, 14), mk(7, 21), mk(4, 40), mk(9, 58)], ping: null }; },
    render(ctx) {
      const s = ctx.state;
      const mock = TTZ.plate({ cls: "wb-mock", html: `<span class="tag dim">Mock</span><button class="btn" data-push="rand">Push random<span class="key">N</span></button><button class="btn" data-push="dup">Dup top</button><button class="btn" data-push="crit">Push critical</button>` });
      return `<div class="wb-world" id="wb-world">${s.ping ? pingHtml(s.ping) : ""}</div>` +
        TTZ.topBar({ night: ctx.night, time: ctx.night ? "21:40" : "13:05", dayFrac: ctx.night ? 0.9 : 0.55, terrWarn: true, terrNote: "breach" }) +
        TTZ.plate({ cls: "wb-feed", id: "wb-feed", html: feedRows(s.list) }) + mock + TTZ.commandBar(s.cmd || (s.cmd = cmdState("units", null)));
    },
    mount(root, ctx) {
      const s = ctx.state, feed = root.querySelector("#wb-feed"), world = root.querySelector("#wb-world");
      const redraw = (anim) => {
        feed.innerHTML = feedRows(s.list, anim);
        if (anim && anim.out) setTimeout(() => { feed.querySelectorAll(".wb-n.out").forEach((x) => x.remove()); }, 380);
      };
      const push = (kind) => {
        let e;
        if (kind === "dup") e = { ...s.list[0] };
        else { const pool = POOL.map((p, i) => i).filter((i) => kind !== "crit" || POOL[i][0] === "crit"); e = mk(pool[Math.floor(Math.random() * pool.length)], 0); }
        s.list.forEach((x) => (x.age += 2));
        const j = s.list.findIndex((x) => x.t === e.t && x.age < 20 + 2);
        if (j >= 0) { const x = s.list.splice(j, 1)[0]; x.n += 1; x.age = 0; s.list.unshift(x); redraw({ bump: x.id }); return; }
        e.age = 0; e.id = Math.random(); s.list.unshift(e);
        const out = s.list.length > 6 ? s.list.splice(6) : null;
        redraw({ add: e.id, out });
      };
      const jump = (loc) => { if (!loc) return; s.ping = loc; world.innerHTML = pingHtml(loc); };
      root.querySelectorAll("[data-push]").forEach((b) => b.addEventListener("click", () => push(b.dataset.push)));
      feed.addEventListener("click", (e) => { const r = e.target.closest(".wb-n"); if (!r) return; const x = s.list.find((q) => String(q.id) === r.dataset.id); if (x) jump(x.loc); });
      feed.addEventListener("contextmenu", (e) => { const r = e.target.closest(".wb-n"); if (!r) return; e.preventDefault(); s.list = s.list.filter((q) => String(q.id) !== r.dataset.id); redraw(); });
      TTZ.wireCommandBar(root, ctx, s.cmd, () => {});
      return (e) => {
        if (e.key === "n" || e.key === "N") return push("rand");
        if (e.key === "Backspace") { e.preventDefault(); const x = s.list.find((q) => q.sev === "crit" || q.sev === "warn"); if (x) jump(x.loc); return; }
        TTZ.cmdKeys(e, ctx, s.cmd, () => {});
      };
    },
  });
  function feedRows(list, anim = {}) {
    let rows = list.slice(0, 6).map((x, i) => {
      const cls = ["wb-n", "s-" + x.sev, i >= 3 ? "old" : "", anim.add === x.id ? "in" : "", anim.bump === x.id ? "bump" : "", x.loc ? "" : "nojump"].join(" ");
      const age = x.age < 60 ? x.age + "s" : Math.floor(x.age / 60) + "m";
      return `<div class="${cls}" data-id="${x.id}" title="${SEV[x.sev]} · click: jump camera · RMB: dismiss">` +
        `<span class="g">${TTZ.glyph(GLY[x.sev], 11, { color: "currentColor", accent: x.sev === "crit" ? "#fff" : "var(--plate-solid)" })}</span>` +
        `<span class="t">${esc(x.t)}</span>${x.n > 1 ? `<span class="x">×${x.n}</span>` : ""}<span class="a">${i >= 3 ? "" : age}</span>` +
        `<span class="j">${x.loc ? g2("chev", 9) : ""}</span></div>`;
    }).join("");
    if (anim.out) rows += anim.out.slice(0, 1).map((x) => `<div class="wb-n s-${x.sev} old out"><span class="g"></span><span class="t">${esc(x.t)}</span></div>`).join("");
    return `<div class="wb-nl">${rows}</div>`;
  }
  const pingHtml = (loc) => `<div class="wb-ping" style="${at(loc[0], loc[1])}"><i></i><i></i><span class="wl">camera</span></div>`;
})();
