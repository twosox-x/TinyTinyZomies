/* Screens 1–2: top bar + command bar (owned by the main design thread). */
(function () {
  const pick = (ctx, state) => (id, why) => {
    if (why) { state.flash = why; state.flashId = id; } else { state.active = state.active === id ? null : id; state.flash = null; }
    ctx.rerender();
  };

  TTZ.screen({
    id: "topbar", num: 1, group: "HUD", title: "Top bar",
    initState: () => ({ v: "normal" }),
    notes: `<b>Top bar</b> — one fixed plate, 640×28 pt, centred. It never changes width: values are tabular numbers in fixed cells.
<ul><li>Order: funds (brass, the only gold on screen) + income · kills · troops with losses · territory with its status · clock with a day strip (dawn/dusk marks) and game time.</li>
<li>Status words change colour only when something needs attention (income negative, territory threatened).</li>
<li>Click the variants below the bar to see calm / under pressure / broke.</li>
<li>The "UNAPPROVED" balance tag moves to the pause menu footer instead of taking bar space.</li></ul>`,
    render(ctx) {
      const s = ctx.state, n = ctx.night;
      const V = {
        normal: { funds: 3800, income: 530, kills: 146, troops: 14, lost: 0, terr: 3.4, terrNote: "secured" },
        pressure: { funds: 1240, income: 210, kills: 612, troops: 11, lost: 3, terr: 3.4, terrNote: "2 threatened", terrWarn: true },
        broke: { funds: 60, income: -40, kills: 1083, troops: 4, lost: 10, terr: 0.8, terrNote: "income paused", terrWarn: true },
      }[s.v];
      Object.assign(V, n ? { time: "23:10", night: true, dayFrac: 0.96 } : { time: "13:25", night: false, dayFrac: 0.55 });
      const sw = ["normal", "pressure", "broke"].map((k) => `<button class="btn${s.v === k ? " on" : ""}" data-v="${k}">${k}</button>`).join("");
      return TTZ.topBar(V) + `<div style="position:absolute;top:44px;left:50%;transform:translateX(-50%);display:flex;gap:4px">${sw}</div>` + TTZ.commandBar({ tab: "units", funds: V.funds });
    },
    mount(root, ctx) { root.querySelectorAll("[data-v]").forEach((b) => b.addEventListener("click", () => { ctx.state.v = b.dataset.v; ctx.rerender(); })); },
  });

  TTZ.screen({
    id: "cmdbar", num: 2, group: "HUD", title: "Command bar",
    initState: () => ({ tab: "units", active: null, offset: 0, overfull: false }),
    notes: `<b>Command bar</b> — fixed 560×104 pt plate, bottom centre. Always 7 card slots; empty slots show as dashed outlines so the bar never resizes.
<ul><li><b>Keys 1–7</b> pick the cards of the open tab (try it). <b>Tab / Shift+Tab</b> switch category. The key badge sits top-left on every card, the squad size or stock top-right.</li>
<li>Disabled cards keep their colour slot but are hatched; the cost turns red and the tooltip states the reason (hover the MG squad — funds are set to $1,200 here).</li>
<li>Overfull tab: arrows + mouse wheel scroll the strip; tick "overfull" to see a 10-card Structures tab.</li>
<li>Active tool = brass outline + brass cost strip, matching the placement banner.</li>
<li>Vehicles tab is visible but greyed ("coming later").</li></ul>`,
    render(ctx) {
      const s = ctx.state;
      s.cards = s.overfull && s.tab === "structures" ? TTZ.CARDS.structures.concat([
        { id: "struct.barricade", nm: "Barricade", ic: "barricade", cost: 25, tip: "Sandbag line. Cheap, slows the horde." },
        { id: "struct.crate", nm: "Supply crate", ic: "crate", cost: 80, tip: "Small ammo cache." },
        { id: "struct.hosp", nm: "Field hosp.", ic: "hospital", cost: 300, tip: "Tent hospital." }]) : null;
      const disable = { "struct.tower": "Needs engineers: buy engineers first [5 in Units]", "struct.light": "Needs engineers" };
      let h = TTZ.topBar({ funds: 1200, income: 380, night: ctx.night, time: ctx.night ? "22:05" : "11:40", dayFrac: ctx.night ? 0.92 : 0.45 });
      h += TTZ.commandBar({ tab: s.tab, active: s.active, offset: s.offset, funds: 1200, disable, cards: s.cards });
      h += `<label class="plate sm" style="position:absolute;right:8px;bottom:6px;padding:6px 9px;display:flex;gap:6px;align-items:center;cursor:pointer"><input type="checkbox" id="ovf" ${s.overfull ? "checked" : ""}> overfull Structures tab</label>`;
      if (s.flash) h += `<div class="plate sm" style="position:absolute;left:50%;transform:translateX(-50%);bottom:118px;padding:5px 10px;color:#f3c0b8;border-left:2px solid var(--bad)">${TTZ.glyph("alert", 11, { color: "var(--bad)" })} ${TTZ.esc(s.flash)}</div>`;
      if (s.active) {
        const c = (s.cards || TTZ.CARDS[s.tab]).find((x) => x.id === s.active);
        if (c) h += `<div class="plate" style="position:absolute;top:40px;left:50%;transform:translateX(-50%);width:420px;height:40px;display:flex;align-items:center;gap:8px;padding:0 12px"><span class="tag brass">PLACING</span><b style="font-size:14px">${TTZ.esc(c.nm)}</b><span class="money">${c.cost > 0 ? TTZ.money(c.cost) : ""}</span><span class="c-dim" style="margin-left:auto;font-size:11.5px">LMB place · ${TTZ.key("Esc")} cancel</span></div>`;
      }
      return h;
    },
    mount(root, ctx) {
      const s = ctx.state, p = pick(ctx, s);
      TTZ.wireCommandBar(root, ctx, s, p);
      root.querySelector("#ovf").addEventListener("change", (e) => { s.overfull = e.target.checked; s.tab = "structures"; s.offset = 0; ctx.rerender(); });
      return (e) => { if (e.key === "Escape") { s.active = null; s.flash = null; ctx.rerender(); return; } TTZ.cmdKeys(e, ctx, s, (id) => { const el = root.querySelector(`[data-card="${id}"]`); p(id, el && el.dataset.why); }); };
    },
  });
})();
