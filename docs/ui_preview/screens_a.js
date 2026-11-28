/* Screens A — Panels: selection panel (3), building panel (4), structure panels (5).
   Fixed slots: selection = left 8 / bottom 6 / 300x210; building+structure = left 8 / bottom 222 / 300x250. */
(function () {
  const T = TTZ, esc = T.esc;

  /* ---------------- shared bits ---------------- */
  const STATES = {
    attack: ["UNDER ATTACK", "bad"], engaging: ["ENGAGING", "warn"], moving: ["MOVING", "ok"],
    holding: ["HOLDING", "dim"], resupplying: ["RESUPPLYING", "intel"],
  };
  const STATE_ORDER = ["attack", "engaging", "moving", "holding", "resupplying"];
  const pill = (txt, cls, attrs = "") => `<span class="sa-pill ${cls}"${attrs}>${txt}</span>`;
  const statePill = (k, attrs) => pill(STATES[k][0], STATES[k][1], attrs);
  // soldier state -> label + colour class
  const SST = { engaging: ["engaging", "c-warn"], reloading: ["reloading", "c-ammo"], moving: ["moving", "c-ok"], idle: ["idle", "c-dim"],
    hit: ["hit", "c-bad"], resupplying: ["resupplying", "c-intel"], covering: ["covering", "c-dim"], building: ["building", "c-ok"],
    dead: ["KIA", "c-bad"], dying: ["down", "c-bad"], aiming: ["aiming", "c-warn"] };

  const hpPips = (hp) => T.pips(hp, 10, T.hpCol(hp / 10));

  // one member row; tail = "ammo" | "fuel" | "job"
  function memberRow(m, i, sel, tail) {
    const dead = m.st === "dead";
    const st = SST[m.st] || [m.st, "c-dim"];
    let last;
    if (dead) last = `<span class="sa-res c-dim">—</span>`;
    else if (tail === "fuel") last = `<span class="sa-res"><span class="sa-fuel">${T.bar(m.fuel, m.fuel < .25 ? "var(--bad)" : "var(--warn)", 26)}</span><b class="${m.fuel < .25 ? "c-bad" : ""}">${Math.round(m.fuel * 100)}%</b></span>`;
    else last = `<span class="sa-res"><b class="${m.mag === 0 ? "c-bad" : m.mag <= m.magMax * 0.25 ? "c-warn" : ""}">${m.mag}</b><i>|</i>${m.res}</span>`;
    const stTxt = m.job ? `<span class="${st[1]}">${esc(m.job)}</span>` : `<span class="${st[1]}">${st[0]}</span>`;
    return `<div class="sa-mem${dead ? " dead" : ""}${sel === i ? " on" : ""}${m.hp <= 3 && !dead ? " wounded" : ""}" data-mem="${i}">` +
      `<span class="sa-ic">${dead ? T.glyph("skull", 11, { color: "var(--bad)" }) : T.icon(m.cls, 18)}</span>` +
      `<span class="sa-nm">${esc(m.nm)}</span>` +
      `<span class="sa-hp">${dead ? `<span class="c-bad sa-kia">KIA</span>` : hpPips(m.hp)}</span>` +
      `<span class="sa-st">${dead ? "" : T.bar(m.stam, m.stam < .3 ? "var(--warn)" : "var(--stam)", 26)}</span>` +
      last + `<span class="sa-state">${dead ? "" : stTxt}</span></div>`;
  }
  const memberHead = (tail) => `<div class="sa-mem sa-mh"><span></span><span class="lbl">Soldier</span><span class="lbl">Health</span><span class="lbl">Stam</span><span class="lbl">${tail === "fuel" ? "Fuel" : "Mag|Res"}</span><span class="lbl">State</span></div>`;

  const paceSeg = (pace) => `<span class="sa-seg" title="Pace (sticky)">${["auto", "run", "walk"].map((p) =>
    `<button class="btn${pace === p ? " on" : ""}" data-pace="${p}">${T.glyph(p, 11)}${p[0].toUpperCase() + p.slice(1)}</button>`).join("")}</span>`;

  /* squad rosters */
  const ROSTER = {
    rifle: { nm: "RIFLE SQUAD 2", ic: "rifle", tail: "ammo", members: [
      { nm: "Sgt Brandt", cls: "rifle", hp: 10, stam: .8, mag: 18, magMax: 30, res: 150, st: "engaging" },
      { nm: "Cpl Ruiz", cls: "rifle", hp: 8, stam: .7, mag: 0, magMax: 30, res: 120, st: "reloading" },
      { nm: "Pvt Hale", cls: "rifle", hp: 3, stam: .35, mag: 22, magMax: 30, res: 60, st: "hit" },
      { nm: "Pvt Mbeki", cls: "rifle", hp: 9, stam: .9, mag: 6, magMax: 30, res: 30, st: "engaging" },
      { nm: "Pvt Novak", cls: "rifle", hp: 0, st: "dead" } ] },
    eng: { nm: "ENGINEERS 1", ic: "engineer", tail: "ammo", members: [
      { nm: "Cpl Ito", cls: "engineer", hp: 9, stam: .5, mag: 14, magMax: 20, res: 80, st: "building", job: "building wall" },
      { nm: "Pvt Sato", cls: "engineer", hp: 10, stam: .8, mag: 20, magMax: 20, res: 60, st: "covering", job: "covering" },
      { nm: "Pvt Lund", cls: "engineer", hp: 7, stam: .6, mag: 4, magMax: 20, res: 40, st: "engaging", job: "covering" } ] },
    flame: { nm: "FLAMERS 1", ic: "flame", tail: "fuel", members: [
      { nm: "Cpl Dresner", cls: "flame", hp: 10, stam: .6, fuel: .64, st: "engaging", job: "burning" },
      { nm: "Pvt Okoro", cls: "flame", hp: 6, stam: .4, fuel: .18, st: "moving" } ] },
  };

  /* hover tooltip for any [data-why] or [data-tip] inside our panels */
  function wireTips(root, ctx) {
    root.querySelectorAll(".sa-panel [data-why], .sa-panel [data-tip]").forEach((el) => {
      el.addEventListener("mouseenter", () => {
        const r = el.getBoundingClientRect(), hr = root.getBoundingClientRect(), s = ctx.u * ctx.fit;
        const x = Math.min(ctx.W - 230, Math.max(8, (r.left - hr.left) / s)), y = (r.top - hr.top) / s;
        const tt = el.dataset.tt || el.textContent.trim();
        root.insertAdjacentHTML("beforeend", `<div class="tip" id="satip" style="left:${x}px;top:0"><div class="tt">${esc(tt)}</div>${el.dataset.tip ? `<div style="margin-top:4px">${esc(el.dataset.tip)}</div>` : ""}${el.dataset.why ? `<div class="why">${esc(el.dataset.why)}</div>` : ""}</div>`);
        const t = root.querySelector("#satip"); t.style.top = Math.max(4, y - t.offsetHeight - 4) + "px";
      });
      el.addEventListener("mouseleave", () => root.querySelector("#satip")?.remove());
    });
  }
  const flash = (root, sel) => { const el = root.querySelector(sel); if (!el) return; el.classList.remove("sa-flash"); void el.offsetWidth; el.classList.add("sa-flash"); };

  /* ---------------- selection panel ---------------- */
  // o: {kind:'rifle'|'eng'|'flame'|'sniper'|'multi', state}
  function selPanel(o) {
    const s = o.state, kind = o.kind;
    if (kind === "multi") return multiPanel(s);
    if (kind === "sniper") return sniperPanel(s);
    const R = ROSTER[kind], alive = R.members.filter((m) => m.st !== "dead").length;
    const stk = s.squadState || (kind === "eng" ? "holding" : kind === "flame" ? "engaging" : "engaging");
    const lowAmmo = kind === "rifle", gas = kind === "rifle" || kind === "flame";
    const lowFuel = kind === "flame";
    let sub = (lowAmmo ? pill(T.glyph("ammo", 9) + "LOW AMMO", "warn sm") : "") + (lowFuel ? pill("LOW FUEL", "warn sm") : "") + (gas ? pill(T.glyph("gas", 9) + "GAS", "toxic sm") : "");
    if (kind === "eng") sub += `<span class="sa-q">Queue <b>3 wall · 1 gate</b> <span class="money">$280</span></span>`;
    const lead = `<span class="sa-sub-r">${kind === "rifle" ? "order: <b>attack-move</b>" : kind === "flame" ? "order: <b>burn area</b>" : "radius <b>35 m</b>"}</span>`;
    let ctxRow;
    if (kind === "rifle") ctxRow = T.btn("Garrison", { id: "garrison", icon: "garrison", k: "G" }) + T.btn("Occupy tower", { id: "occupy", glyph: "occupy", k: "O", off: true, why: "No defense tower built" }) + T.btn("Resupply", { id: "resup", icon: "ammo", why: "No ammo container in 40 m", off: true });
    else if (kind === "eng") ctxRow = T.btn("Wall", { id: "wall", icon: "wall", on: s.tool === "wall" }) + T.btn("Gate", { id: "gate", icon: "gate", on: s.tool === "gate" }) + T.btn("Clear car", { id: "clear", icon: "disassemble", on: s.tool === "clear" }) + T.btn("Undo", { id: "undo", glyph: "undo", k: "^Z" });
    else ctxRow = T.btn("Burn area", { id: "burn", icon: "burn", k: "B", on: s.tool === "burn" }) + T.btn("Garrison", { id: "garrison", icon: "garrison", k: "G" }) + T.btn("Refuel", { id: "refuel", icon: "fuel", off: true, why: "No fuel store built" });
    return T.plate({ cls: "sa-panel sa-sel rivets", id: "sa-sel", html:
      `<div class="sa-head"><span class="tag">SEL</span>${T.icon(R.ic, 22)}<span class="sa-title">${R.nm}</span><span class="sa-cnt"><b>${alive}</b>/${R.members.length}</span>${statePill(stk, ` data-cycle="1" data-tip="Demo: click to cycle squad states" data-tt="Squad state"`)}</div>` +
      `<div class="sa-sub">${sub}${lead}</div>` +
      memberHead(R.tail) +
      `<div class="sa-list scroll">${R.members.map((m, i) => memberRow(m, i, s.sel, R.tail)).join("")}</div>` +
      `<div class="sa-row">${T.btn("Halt", { id: "halt", glyph: "halt", k: "H" })}${paceSeg(s.pace || "auto")}<span class="sa-hint">${T.key("P")} pace</span></div>` +
      `<div class="sa-row">${ctxRow}</div>` });
  }

  const SQUADS = [
    { nm: "Rifle Squad 1", ic: "rifle", a: 5, n: 5, hp: .92, am: .7, st: "holding" },
    { nm: "Rifle Squad 2", ic: "rifle", a: 4, n: 5, hp: .6, am: .22, st: "attack", low: true },
    { nm: "Rifle Squad 3", ic: "rifle", a: 3, n: 5, hp: .45, am: .5, st: "engaging" },
    { nm: "MG Squad 1", ic: "mg", a: 3, n: 3, hp: .88, am: .61, st: "engaging" },
    { nm: "MG Squad 2", ic: "mg", a: 3, n: 3, hp: 1, am: .9, st: "moving" },
    { nm: "Engineers 1", ic: "engineer", a: 3, n: 3, hp: .8, am: .4, st: "resupplying" },
  ];
  function multiPanel(s) {
    const a = SQUADS.reduce((t, q) => t + q.a, 0), n = SQUADS.reduce((t, q) => t + q.n, 0);
    const rows = SQUADS.map((q, i) => `<div class="sa-sq${s.sel === i ? " on" : ""}" data-sq="${i}">` +
      `<span class="sa-ic">${T.icon(q.ic, 18)}</span><span class="sa-nm">${q.nm}</span><span class="sa-cnt2"><b>${q.a}</b>/${q.n}</span>` +
      `<span>${T.pips(Math.round(q.hp * 10), 10, T.hpCol(q.hp))}</span>` +
      `<span class="sa-am">${T.bar(q.am, q.am < .25 ? "var(--warn)" : "var(--ammo)", 30)}</span>` +
      `<span class="sa-stc">${statePill(q.st, "")}</span></div>`).join("");
    return T.plate({ cls: "sa-panel sa-sel rivets", id: "sa-sel", html:
      `<div class="sa-head"><span class="tag">SEL</span>${T.glyph("troops", 14)}<span class="sa-title">${SQUADS.length} SQUADS</span><span class="sa-cnt"><b>${a}</b>/${n} soldiers</span>${pill("1 UNDER ATTACK", "bad")}</div>` +
      `<div class="sa-sq sa-mh"><span></span><span class="lbl">Squad</span><span class="lbl">Alive</span><span class="lbl">Avg HP</span><span class="lbl">Ammo</span><span class="lbl">State</span></div>` +
      `<div class="sa-list sa-list-m scroll">${rows}</div>` +
      `<div class="sa-foot">${SQUADS.length} squads · ${a}/${n} soldiers<span class="sa-hint">click: focus · dbl-click: select only · ${T.key("Ctrl")}+${T.key("1")} group</span></div>` +
      `<div class="sa-row">${T.btn("Halt", { id: "halt", glyph: "halt", k: "H" })}${paceSeg(s.pace || "auto")}${T.btn("Garrison", { id: "garrison", icon: "garrison", k: "G" })}</div>` });
  }

  function sniperPanel(s) {
    const stk = s.squadState || "holding";
    return T.plate({ cls: "sa-panel sa-sel rivets", id: "sa-sel", html:
      `<div class="sa-head"><span class="tag">SEL</span>${T.icon("sniper", 22)}<span class="sa-title">SNIPER 1</span><span class="sa-cnt"><b>1</b>/1</span>${statePill(stk, ` data-cycle="1" data-tip="Demo: click to cycle squad states" data-tt="Squad state"`)}</div>` +
      `<div class="sa-snip">` +
        `<div class="sa-portrait">${T.icon("sniper", 52)}<span class="sa-pos">${T.glyph("occupy", 9)} ${s.inTower ? "IN TOWER" : "ON ROOF"}</span></div>` +
        `<div class="sa-sd"><div class="sa-sdn">Cpl Varga <span class="c-warn">aiming</span></div>` +
          `<div class="sa-kv"><span class="lbl">Health</span>${hpPips(8)}<b>80/90</b></div>` +
          `<div class="sa-kv"><span class="lbl">Stamina</span>${T.bar(.7, "var(--stam)", 50)}<b>70%</b></div>` +
          `<div class="sa-kv"><span class="lbl">Ammo</span><span class="sa-rounds">${"<i class=f></i>".repeat(4)}<i></i></span><b>4<i class="c-dim">|</i>32</b></div>` +
        `</div></div>` +
      `<div class="sa-stats">` +
        `<div><span class="lbl">Range</span><b>${s.inTower ? "180 m" : "160 m"}</b><small class="c-ok">${s.inTower ? "+40 tower" : "+20 roof"}</small></div>` +
        `<div><span class="lbl">Kills</span><b>37</b><small>12 runners</small></div>` +
        `<div><span class="lbl">Position</span><b>${s.inTower ? "Tower 1" : "Bakery roof"}</b><small>${s.inTower ? "slot 1 of 2" : "4 floors up"}</small></div>` +
        `<div><span class="lbl">Target</span><b class="c-warn">Runner</b><small>92 m</small></div>` +
      `</div>` +
      `<div class="sa-row">${T.btn("Halt", { id: "halt", glyph: "halt", k: "H" })}${(s.inTower ? T.btn("Leave tower", { id: "leave", glyph: "arrow", k: "L" }) : T.btn("Occupy tower", { id: "occupy", glyph: "occupy", k: "O", off: true, why: "No defense tower built" }))}${s.inTower ? "" : T.btn("Leave roof", { id: "leave", glyph: "arrow", k: "L" })}</div>` });
  }

  /* ---------------- building panel ---------------- */
  const LADDER = [
    { id: "doors", nm: "Doors", steps: [["Planks", 30], ["Plate", 80], ["Sandbags", 60]] },
    { id: "windows", nm: "Windows", steps: [["Planks", 30], ["Plate", 80], ["Sandbags", 60]] },
    { id: "nests", nm: "Nests", steps: [["Win. nests", 60], ["Roof ring", 60]] },
  ];
  const defLevel = (d) => Math.min(d.doors, d.windows);
  // little facade elevation: shows each upgrade on the model so "visibly safer" reads in the panel too
  function facade(d) {
    const cols = ["#2a2c22", "#9a6b3f", "#7d8589", "#cdb98a"]; // open, planks, plate, sandbags
    let r = `<rect x="4" y="10" width="52" height="78" fill="#a9a596"/><rect x="4" y="10" width="52" height="3" fill="#6f6b5a"/>`;
    for (let fl = 0; fl < 6; fl++) for (let c = 0; c < 4; c++) {
      if (fl === 5 && (c === 1 || c === 2)) continue;
      const x = 8 + c * 12, y = 16 + fl * 11.5;
      const wc = cols[d.windows];
      r += `<rect x="${x}" y="${y}" width="8" height="7" fill="${d.windows ? wc : "#3a3d3f"}"/>`;
      if (d.windows === 1) r += `<rect x="${x}" y="${y + 3}" width="8" height="1" fill="#5d4024"/>`;
      if (d.nests >= 1 && fl === 1 && (c === 0 || c === 3)) r += `<rect x="${x - 1}" y="${y + 5}" width="10" height="3" fill="#cdb98a"/>`;
    }
    r += `<rect x="22" y="76" width="16" height="12" fill="${d.doors ? cols[d.doors] : "#1f201a"}"/>`;
    if (d.doors === 1) r += `<rect x="22" y="79" width="16" height="1.5" fill="#5d4024"/><rect x="22" y="84" width="16" height="1.5" fill="#5d4024"/>`;
    if (d.doors === 3) r += `<rect x="19" y="84" width="22" height="4" fill="#b9a774"/>`;
    if (d.nests >= 2) r += `<rect x="4" y="6" width="52" height="4" fill="#cdb98a"/><rect x="4" y="6" width="52" height="1" fill="#b9a774"/>`;
    r += `<rect x="0" y="88" width="60" height="2" fill="#4b5530"/>`;
    return `<svg class="sa-facade" width="60" height="92" viewBox="0 0 60 92" shape-rendering="crispEdges">${r}</svg>`;
  }
  function ladder(d) {
    return LADDER.map((L) => {
      const lv = d[L.id];
      const chips = L.steps.map(([nm, c], i) => {
        const done = i < lv, next = i === lv;
        return `<button class="sa-step${done ? " done" : next ? " next" : " lock"}"${next ? ` data-up="${L.id}"` : ""}${!done && !next ? ` data-why="Needs ${esc(L.steps[i - 1][0])} first" data-tt="${esc(nm)}"` : ""}>` +
          `<span class="n">${done ? "✓ " : ""}${esc(nm)}</span><span class="c">${done ? "built" : "$" + c}</span></button>`;
      }).join("");
      return `<div class="sa-lad"><span class="sa-ladn">${L.nm}<small>Lv ${lv}/${L.steps.length}</small></span>${chips}</div>`;
    }).join("");
  }
  function buildingPanel(s) {
    const role = s.role || "garrison", d = s.def;
    const lv = defLevel(d);
    const roleSeg = `<div class="sa-roles"><span class="lbl">Role</span>` +
      `<button class="sa-role${role === "garrison" ? " on" : ""}" data-role="garrison">${T.icon("garrison", 18)}Garrison<span class="c">${role === "garrison" ? "ACTIVE" : "$150"}</span></button>` +
      `<button class="sa-role${role === "hospital" ? " on" : ""}" data-role="hospital">${T.icon("hospital", 18)}Hospital<span class="c">${role === "hospital" ? "ACTIVE" : "$250"}</span></button></div>`;
    let body;
    if (role === "garrison") {
      const slots = Array.from({ length: 12 }, (_, i) => `<i class="${i < 5 ? "f" : ""}"></i>`).join("");
      body = `<div class="sa-kv2"><span class="lbl">Positions</span><span class="sa-slots">${slots}</span><b>5/12</b></div>` +
        `<div class="sa-kv2"><span class="lbl">Ammo stock</span><span class="sa-crates">${T.icon("ammo", 16).repeat(3)}<span class="sa-crate-e"></span></span><b>3/4 crates</b></div>` +
        `<div class="sa-row tight">${T.btn("Garrison selected", { id: "garrison", icon: "garrison", k: "G" })}${T.btn("Leave", { id: "leave", glyph: "arrow", k: "L" })}${T.btn("Sell role", { id: "sell", cls: "danger", why: "Squads must leave first", off: true })}</div>`;
    } else {
      const beds = Array.from({ length: 6 }, (_, i) => `<span class="sa-bed${i < 2 ? " f" : ""}">${T.glyph("cross", 9, { color: i < 2 ? "var(--bad)" : "var(--bone-mute)" })}</span>`).join("");
      body = `<div class="sa-kv2"><span class="lbl">Beds</span><span class="sa-beds">${beds}</span><b>2/6</b></div>` +
        `<div class="sa-kv2"><span class="lbl">Heal rate</span><b class="c-ok">+2 hp/s</b><small class="c-dim">per bed · KIA can't be saved</small></div>` +
        `<div class="sa-pat"><span class="sa-nm">Pvt Hale</span>${hpPips(4)}<span class="c-dim">→ full 0:42</span><span class="c-dim">R.Sq 2</span></div>` +
        `<div class="sa-pat"><span class="sa-nm">Pvt Okoro</span>${hpPips(7)}<span class="c-dim">→ full 0:15</span><span class="c-dim">Flm 1</span></div>` +
        `<div class="sa-row tight">${T.btn("Admit wounded", { id: "admit", glyph: "cross", k: "G" })}${T.btn("Discharge all", { id: "discharge", glyph: "arrow", k: "L" })}</div>`;
    }
    return T.plate({ cls: "sa-panel sa-bld rivets", id: "sa-bld", html:
      `<div class="sa-head"><span class="tag">BLDG</span>${T.icon(role === "hospital" ? "hospital" : "garrison", 22)}<span class="sa-title">MID-RISE <small>9 FLOORS · FLAT ROOF</small></span>${pill("CAPTURED", "ok")}</div>` +
      `<div class="sa-sub"><span>${T.glyph("skull", 9)} Zombies inside <b class="c-ok">0</b></span><span class="c-dim">cleared 2 min ago</span><span class="sa-sub-r">Defence <b class="money">Lv ${lv}</b>/3</span></div>` +
      `<div class="sa-bbody scroll">` + roleSeg + body +
        `<div class="sa-sect"><span class="tag dim">DEFENCE UPGRADES</span><span class="c-dim">each step shows on the model</span></div>` +
        `<div class="sa-def">${facade(d)}<div class="sa-ladder">${ladder(d)}</div></div>` +
      `</div>` });
  }

  /* ---------------- structure panels ---------------- */
  function structPanel(kind, s) {
    let head, sub, body;
    if (kind === "tower") {
      const occ = s.occ ?? 1;
      head = [T.icon("tower", 22), "DEFENSE TOWER", pill("BUILT", "ok")];
      sub = `<span>Timber · 6 m</span><span class="sa-sub-r">${T.key("O")} occupy</span>`;
      const slot = (i) => i < occ ? `<div class="sa-slot f">${T.icon("sniper", 30)}<span>Cpl Varga</span><small class="c-warn">aiming</small></div>` : `<div class="sa-slot"><span class="c-dim">EMPTY</span><small>sniper / rifleman</small></div>`;
      body = `<div class="sa-kv2"><span class="lbl">Integrity</span>${T.pips(8, 10, T.hpCol(.85))}<b>340/400</b></div>` +
        `<div class="sa-kv2"><span class="lbl">Occupants</span><b>${occ}/2</b><small class="c-dim">sniper slots</small></div>` +
        `<div class="sa-slots2">${slot(0)}${slot(1)}</div>` +
        `<div class="sa-kv2"><span class="lbl">Bonus</span><b class="c-ok">+40 m range</b><b class="c-ok">· 50% cover</b></div>` +
        `<div class="sa-row tight">${T.btn("Occupy", { id: "occupy", glyph: "occupy", k: "O", off: occ >= 2, why: occ >= 2 ? "Tower full (2/2)" : "" })}${T.btn("Leave", { id: "leave", glyph: "arrow", k: "L", off: occ === 0, why: occ === 0 ? "Nobody inside" : "" })}${T.btn("Repair $20", { id: "repair", icon: "build", off: true, why: "Select engineers to repair" })}</div>`;
    } else if (kind === "gen") {
      const on = s.on !== false, fuel = s.fuel ?? 14.2, cap = 20, burn = on ? 1.0 : 0;
      const left = on ? Math.round(fuel / burn) : "—";
      let ticks = ""; for (let i = 0; i <= 20; i += 5) ticks += `<span style="left:${i / cap * 100}%">${i}</span>`;
      head = [T.icon("generator", 22), "GENERATOR", pill(on ? "RUNNING" : "OFF", on ? "ok" : "dim")];
      sub = `<span>Feeds lights in <b>30 m</b></span><span class="sa-sub-r"><button class="btn sa-onoff${on ? " on" : ""}" data-onoff="1">${T.glyph("bolt", 10)}${on ? "ON" : "OFF"}</button></span>`;
      body = `<div class="sa-gauge"><div class="sa-gbar"><i style="width:${fuel / cap * 100}%"></i><em style="left:25%"></em></div><div class="sa-gticks">${ticks}</div></div>` +
        `<div class="sa-big3"><div><span class="lbl">Fuel</span><b>${fuel.toFixed(1)}<small> / ${cap} l</small></b></div><div><span class="lbl">Burn</span><b>${burn.toFixed(1)}<small> l/min</small></b></div><div><span class="lbl">Time left</span><b class="${on && left < 6 ? "c-warn" : ""}">${left}<small> min</small></b></div></div>` +
        `<div class="sa-kv2"><span class="lbl">Floodlights</span><span class="sa-lights">${[1, 1, 1, 0].map((p) => `<span class="${p && on ? "on" : ""}">${T.icon("light", 16, { grey: !(p && on) })}</span>`).join("")}</span><b>${on ? 3 : 0} powered</b></div>` +
        `<div class="sa-row tight">${T.btn("Refuel from store", { id: "refuel", icon: "fuel", k: "R" })}<span class="c-dim sa-note">store 86 l · fills to 20 l</span></div>`;
    } else if (kind === "light") {
      const pw = !!s.powered, on = s.on !== false;
      head = [T.icon("light", 22), "FLOODLIGHT", pill(pw ? (on ? "LIT" : "OFF") : "UNPOWERED", pw ? (on ? "ok" : "dim") : "bad")];
      sub = `<span>Sodium lamp · 18 m cone</span><span class="sa-sub-r"><button class="btn sa-onoff${on ? " on" : ""}" data-onoff="1">${T.glyph("bolt", 10)}${on ? "ON" : "OFF"}</button></span>`;
      const cone = `<svg class="sa-cone" width="96" height="62" viewBox="0 0 96 62"><path d="M48 58 L8 8 A60 60 0 0 1 88 8 Z" fill="${pw && on ? "rgba(255,210,74,.28)" : "rgba(255,255,255,.05)"}" stroke="${pw && on ? "var(--brass)" : "var(--bone-mute)"}" stroke-dasharray="${pw && on ? "0" : "3 2"}"/><rect x="45" y="55" width="6" height="6" fill="var(--bone)"/>${pw && on ? `<rect x="30" y="22" width="3" height="5" fill="var(--toxic)"/><rect x="58" y="30" width="3" height="5" fill="var(--toxic)"/>` : ""}</svg>`;
      body = (pw ? `<div class="sa-ok-line">${T.glyph("bolt", 10, { color: "var(--ok)" })} Powered by <b>Generator 1</b> · 12 m · 0.3 l/min share</div>`
                 : `<div class="sa-why">${T.glyph("alert", 10, { color: "var(--bad)" })} No generator in 30 m <span>— nearest is 42 m NE, out of reach</span></div>`) +
        `<div class="sa-cov">${cone}<div><div class="sa-kv2"><span class="lbl">Coverage</span><b>18 m</b><small class="c-dim">90° cone</small></div><div class="sa-kv2"><span class="lbl">Lit now</span><b class="${pw && on ? "c-toxic" : "c-dim"}">${pw && on ? "2 zombies" : "nothing"}</b></div><div class="sa-kv2"><span class="lbl">Aim</span><b>NE</b><small class="c-dim">${T.key("R")} rotate</small></div></div></div>` +
        `<div class="sa-row tight">${pw ? T.btn("Rotate", { id: "rot", glyph: "arrow", k: "R" }) : T.btn("Place generator $150", { id: "placegen", icon: "generator" })}<button class="btn" data-pw="1">demo: ${pw ? "cut power" : "connect power"}</button></div>`;
    } else {
      const stock = 86, cap = 200;
      const segs = Array.from({ length: 20 }, (_, i) => `<i class="${i < Math.round(stock / 10) ? "f" : i < Math.round((stock + 32) / 10) ? "in" : ""}"></i>`).join("");
      head = [T.icon("fuel", 22), "FUEL STORE", pill("86 l", "warn")];
      sub = `<span>Capacity <b>${cap} l</b></span><span class="sa-sub-r c-dim">fuel from Siphon / Clear car</span>`;
      body = `<div class="sa-tank">${segs}</div><div class="sa-tankl"><span><b>${stock}</b> l stock</span><span class="c-intel">+32 l incoming</span><span class="c-dim">${cap - stock} l free</span></div>` +
        `<div class="sa-sect"><span class="lbl">Incoming siphon trips · 2</span></div>` +
        `<div class="sa-trip">${T.icon("siphon", 16)}<span>Pvt Lund</span><span class="c-dim">carrying</span><b>12 l</b><span class="c-dim">ETA 0:35</span></div>` +
        `<div class="sa-trip">${T.icon("car", 16)}<span>Sedan, Elm St</span><span class="c-dim">queued</span><b>~20 l</b><span class="c-dim">ETA 2:10</span></div>` +
        `<div class="sa-sect"><span class="lbl">Linked generators · 2</span></div>` +
        `<div class="sa-trip">${T.icon("generator", 16)}<span>Generator 1</span>${T.bar(.71, "var(--warn)", 40)}<b>14.2 l</b><span class="c-dim">14 min</span></div>` +
        `<div class="sa-trip">${T.icon("generator", 16)}<span>Generator 2</span>${T.bar(.2, "var(--bad)", 40)}<b class="c-bad">4.0 l</b><span class="c-warn">4 min</span></div>`;
    }
    return T.plate({ cls: "sa-panel sa-bld rivets", id: "sa-bld", html:
      `<div class="sa-head"><span class="tag">STRUCT</span>${head[0]}<span class="sa-title">${head[1]}</span>${head[2]}</div><div class="sa-sub">${sub}</div><div class="sa-bbody scroll">${body}</div>` });
  }

  /* ---------------- composition + wiring ---------------- */
  function compose(ctx, focusHtml, cmdOpts) {
    const s = ctx.state;
    return T.topBar({ night: ctx.night, time: ctx.night ? "21:40" : "13:10", dayFrac: ctx.night ? 0.9 : 0.55 }) +
      T.commandBar(Object.assign({}, s, cmdOpts || {})) + focusHtml;
  }
  function mountCommon(root, ctx, extra) {
    const s = ctx.state;
    const onPick = (id, why) => { if (why) return; s.active = s.active === id ? null : id; ctx.rerender(); };
    T.wireCommandBar(root, ctx, s, onPick);
    wireTips(root, ctx);
    root.querySelectorAll("[data-mem]").forEach((el) => el.addEventListener("click", () => { s.sel = s.sel === +el.dataset.mem ? null : +el.dataset.mem; ctx.rerender(); }));
    root.querySelectorAll("[data-sq]").forEach((el) => {
      el.addEventListener("click", () => { s.sel = s.sel === +el.dataset.sq ? null : +el.dataset.sq; ctx.rerender(); });
    });
    root.querySelectorAll("[data-pace]").forEach((el) => el.addEventListener("click", () => { s.pace = el.dataset.pace; ctx.rerender(); }));
    root.querySelectorAll("[data-cycle]").forEach((el) => el.addEventListener("click", () => {
      const cur = s.squadState || el.dataset.def || "engaging"; s.squadState = STATE_ORDER[(STATE_ORDER.indexOf(cur) + 1) % STATE_ORDER.length]; ctx.rerender(); }));
    root.querySelectorAll(".sa-panel .btn[data-id]").forEach((el) => el.addEventListener("click", () => {
      if (el.classList.contains("off")) return;
      const id = el.dataset.id;
      if (["wall", "gate", "clear", "burn"].includes(id)) { s.tool = s.tool === id ? null : id; ctx.rerender(); return; }
      el.classList.add("sa-flash"); setTimeout(() => el.classList.remove("sa-flash"), 400);
    }));
    root.querySelectorAll("[data-role]").forEach((el) => el.addEventListener("click", () => { s.role = el.dataset.role; ctx.rerender(); }));
    root.querySelectorAll("[data-up]").forEach((el) => el.addEventListener("click", () => { s.def[el.dataset.up]++; ctx.rerender(); }));
    root.querySelectorAll("[data-onoff]").forEach((el) => el.addEventListener("click", () => { s.on = s.on === false; ctx.rerender(); }));
    root.querySelectorAll("[data-pw]").forEach((el) => el.addEventListener("click", () => { s.powered = !s.powered; ctx.rerender(); }));
    const press = (id) => { const b = root.querySelector(`.sa-panel .btn[data-id="${id}"]`); if (b) b.click(); else return false; return true; };
    return (e) => {
      if (T.cmdKeys(e, ctx, s, onPick)) return;
      const k = e.key.toLowerCase();
      if (e.ctrlKey && k === "z") { e.preventDefault(); press("undo"); return; }
      if (k === "p") { const o = ["auto", "run", "walk"]; s.pace = o[(o.indexOf(s.pace || "auto") + 1) % 3]; ctx.rerender(); return; }
      const map = { h: "halt", g: root.querySelector('[data-id="admit"]') ? "admit" : "garrison", o: "occupy", b: "burn", l: "leave", r: root.querySelector('[data-id="refuel"]') ? "refuel" : "rot" };
      if (map[k]) press(map[k]);
      if (extra) extra(e);
    };
  }

  const defState = (o) => () => Object.assign({ tab: "units", active: null, offset: 0, sel: null, pace: "auto" }, o || {});

  /* ---------------- register: 3 selection ---------------- */
  const SEL_SCREENS = [
    { id: "sel-rifle", num: 3.1, badge: "3a", title: "Selection · rifle squad", kind: "rifle", notes:
      `<ul><li><b>Fixed 300×210 slot</b>, left-bottom; never touches the command bar (8 pt gap at 1280). The member list is a fixed 5-row window that scrolls for larger squads (MG 3, rifle 5 fit without scrolling).</li>
      <li><b>One row per soldier</b>: class voxel, name, 10 health pips, stamina hairline, <b>mag | reserve</b> (mag turns amber ≤25 %, red at 0), soldier state word. Wounded row gets a red edge; KIA stays in the list (dimmed, struck, skull) so the player sees the loss.</li>
      <li><b>State pill</b> is the only loud colour in the header (red UNDER ATTACK, amber ENGAGING, green MOVING, dim HOLDING, blue RESUPPLYING). Click it here to cycle the five states. Condition pills (LOW AMMO, GAS) sit on their own line so they never push the title.</li>
      <li><b>Two fixed action rows</b>: orders (Halt H, sticky pace toggle Auto/Run/Walk, P cycles), then context actions. Unavailable actions stay visible but hatched; hover shows the reason (e.g. "No defense tower built").</li>
      <li>Click a soldier row to focus that soldier (camera follow suggested). <b>Owner:</b> should soldier names exist at all, or just "Rifleman 1..5"?</li></ul>` },
    { id: "sel-multi", num: 3.2, badge: "3b", title: "Selection · multiple squads", kind: "multi", notes:
      `<ul><li>Same fixed slot; with 2+ squads the panel turns into a <b>roster</b>: icon, name, alive/total, average-HP pips, average-ammo bar, state pill.</li>
      <li>6 rows do not fit; the list window shows ~4.5 rows and <b>scrolls inside</b> — the half row is the cue that there is more. Header keeps the summary ("21/24 soldiers") and the worst state ("1 UNDER ATTACK").</li>
      <li>Click = highlight/focus a squad (brass edge); double-click = select only that squad (opens 3a). Ctrl+1..9 control groups proposed.</li>
      <li>Only orders shared by every squad are shown (Halt, pace, Garrison). Class-specific actions appear once a single squad is selected.</li>
      <li><b>Owner:</b> sort order — by threat (under attack first) or by creation order? Currently creation order.</li></ul>` },
    { id: "sel-eng", num: 3.3, badge: "3c", title: "Selection · engineers", kind: "eng", notes:
      `<ul><li>Engineers reuse the member row, but the state column shows the <b>job</b>: "building wall 62%", "covering".</li>
      <li>The sub line shows the build queue and committed money ("3 wall · 1 gate $280").</li>
      <li>Context row = engineering tools: Wall, Gate, Clear car (sticky, brass when active) and Undo (Ctrl+Z). They are shortcuts into the Engineering/Structures tabs of the command bar, not a second build menu.</li>
      <li><b>Owner:</b> do Wall/Gate need their own keys here, or should we rely on the command bar's 1–7 after Tab?</li></ul>` },
    { id: "sel-flame", num: 3.4, badge: "3d", title: "Selection · flamethrowers", kind: "flame", notes:
      `<ul><li>Flamers show <b>fuel %</b> (amber bar, red under 25 %) in the slot riflemen use for ammo; the header gets LOW FUEL instead of LOW AMMO.</li>
      <li><b>Burn area [B]</b> is a sticky targeting mode (brass while active). GAS pill is shown because flamers are the counter to gas clouds.</li>
      <li>Refuel is disabled with reason "No fuel store built" — ties flamers into the fuel economy. <b>Owner:</b> do flamers refuel from the fuel store, or from ammo containers?</li></ul>` },
    { id: "sel-sniper", num: 3.5, badge: "3e", title: "Selection · sniper", kind: "sniper", notes:
      `<ul><li>Single-soldier squads get a <b>detail layout</b> in the same slot: big voxel portrait with position badge (ON ROOF), health, stamina, ammo as individual rounds (5-round mag).</li>
      <li>Stat block: effective range (with roof bonus called out), kills, position, current target and distance.</li>
      <li>Actions: Halt, Occupy tower (disabled with reason), Leave roof. </li>
      <li><b>Owner:</b> should the panel let the player pick a target priority (runners / gas / nearest)? There is room for one more row.</li></ul>` },
  ];
  for (const sc of SEL_SCREENS) {
    T.screen({ id: sc.id, num: sc.num, badge: sc.badge, group: "Panels", title: sc.title, status: "draft", notes: sc.notes,
      initState: defState({ squadState: sc.kind === "eng" ? "holding" : sc.kind === "sniper" ? "holding" : sc.kind === "flame" ? "engaging" : "engaging", sel: sc.kind === "rifle" ? 2 : sc.kind === "multi" ? 1 : null, tab: sc.kind === "eng" ? "engineering" : "units" }),
      render: (ctx) => compose(ctx, selPanel({ kind: sc.kind, state: ctx.state })),
      mount: (root, ctx) => mountCommon(root, ctx) });
  }

  /* ---------------- register: 4 building ---------------- */
  const BLD = [
    { id: "bld-garrison", num: 4.1, badge: "4a", title: "Building · garrison", role: "garrison", def: { doors: 2, windows: 1, nests: 0 }, notes:
      `<ul><li>Building panel sits <b>directly above the selection panel</b> (left 8, bottom 222, 300×250 fixed). Selection (the squad you'd send in) stays visible underneath — no overlap.</li>
      <li>Header: building type + floors + roof, capture state pill, zombies inside, overall defence level. Body scrolls inside the fixed plate.</li>
      <li><b>Role switch</b> Garrison $150 / Hospital $250 is a two-way choice (click to preview the other role here). Garrison shows 12 position pips (5 filled), ammo crates, Garrison selected [G] / Leave [L].</li>
      <li><b>Defence ladder</b>: one row per part (Doors, Windows, Nests); built steps are khaki ✓, the next step is the only brass (clickable, shows cost), later steps are hatched with "needs X first". The facade sketch on the left updates with each step — planks, plate, sandbags, nests, roof ring — echoing the in-world model change.</li>
      <li><b>Owner:</b> overall level = min(Doors, Windows) and Nests are a bonus — or should all three count?</li></ul>` },
    { id: "bld-hospital", num: 4.2, badge: "4b", title: "Building · hospital", role: "hospital", def: { doors: 3, windows: 3, nests: 1 }, notes:
      `<ul><li>Same panel with role Hospital: 6 bed cells (2 occupied, red cross), heal rate, patient rows with HP pips, time to full and home squad.</li>
      <li>Admit wounded [G] sends the selected squad's wounded in; Discharge [L] sends everyone back. Same keys as garrison so the hand doesn't have to relearn.</li>
      <li>Defence ladder stays (here fully built doors/windows → Lv 3), because a hospital still needs protecting.</li>
      <li><b>Owner:</b> do healed soldiers auto-rejoin their squad, or wait for a discharge order?</li></ul>` },
  ];
  for (const b of BLD) {
    T.screen({ id: b.id, num: b.num, badge: b.badge, group: "Panels", title: b.title, status: "draft", notes: b.notes,
      initState: defState({ role: b.role, def: Object.assign({}, b.def), squadState: "holding", sel: null }),
      render: (ctx) => compose(ctx, buildingPanel(ctx.state) + selPanel({ kind: "rifle", state: ctx.state })),
      mount: (root, ctx) => mountCommon(root, ctx) });
  }

  /* ---------------- register: 5 structures ---------------- */
  const STR = [
    { id: "str-tower", num: 5.1, badge: "5a", title: "Structure · defense tower", kind: "tower", below: "sniper", initState: { inTower: true }, notes:
      `<ul><li>Structure panels use the <b>same slot</b> as the building panel, so the eye always finds "the thing I clicked" in one place.</li>
      <li>Tower: integrity pips, two occupant slots as cards (who's in, what they're doing), the bonus it gives, Occupy [O] / Leave [L] / Repair (needs engineers, reason on hover).</li>
      <li>The sniper selected below shows the pairing: select squad → Occupy. Occupy greys out with "Tower full (2/2)" when both slots are taken.</li>
      <li><b>Owner:</b> can riflemen occupy towers too, or snipers only? Copy currently says "sniper / rifleman".</li></ul>` },
    { id: "str-generator", num: 5.2, badge: "5b", title: "Structure · generator", kind: "gen", below: "eng", notes:
      `<ul><li>Fuel gauge in litres with a 25 % low mark; three big readouts: fuel, burn rate, time left (amber under 6 min).</li>
      <li>Powered floodlights shown as small icons (lit vs grey) with count. ON/OFF toggle in the sub line (click it: burn → 0, lights go dark).</li>
      <li>Refuel from store [R] shows store stock inline so the player knows if it will work.</li>
      <li><b>Owner:</b> should generators auto-refuel from a linked store (then Refuel becomes a toggle)?</li></ul>` },
    { id: "str-light", num: 5.3, badge: "5c", title: "Structure · floodlight", kind: "light", below: "eng", initState: { powered: false }, notes:
      `<ul><li>Default shown is the problem case: <b>UNPOWERED</b> pill + a reason line ("No generator in 30 m — nearest 42 m NE") and a one-click fix: Place generator $150.</li>
      <li>Coverage sketch: 90° cone, dashed when dark, filled when lit, with lit zombies as dots. "demo: connect power" toggles the powered state.</li>
      <li>ON/OFF is kept even when unpowered (it's the player's intent; it lights as soon as power arrives).</li>
      <li><b>Owner:</b> is the cone rotatable (R) or fixed at build time?</li></ul>` },
    { id: "str-fuel", num: 5.4, badge: "5d", title: "Structure · fuel store", kind: "fuel", below: "eng", notes:
      `<ul><li>Tank as 20 segments of 10 l: solid = stock (86 l), hatched blue = incoming (+32 l), empty = free.</li>
      <li>Incoming siphon trips list who is carrying how much and ETA; linked generators list fuel and time left, red when low — the store is the hub of the fuel loop.</li>
      <li>Content longer than the plate scrolls inside it (fixed 300×250).</li>
      <li><b>Owner:</b> what happens at 200 l — trips stop, or fuel is lost?</li></ul>` },
  ];
  for (const st of STR) {
    T.screen({ id: st.id, num: st.num, badge: st.badge, group: "Panels", title: st.title, status: "draft", notes: st.notes,
      initState: defState(Object.assign({ squadState: "holding", tab: "structures" }, st.initState || {})),
      render: (ctx) => compose(ctx, structPanel(st.kind, ctx.state) + selPanel({ kind: st.below, state: ctx.state })),
      mount: (root, ctx) => mountCommon(root, ctx) });
  }
})();
