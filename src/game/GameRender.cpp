// Game -> MilitaryRenderer adapter (WS-B). See GameRender.h.
#include "game/GameRender.h"
#include "game/Reanimation.h"

#include "app/App.h"
#include "game/Deploy.h"
#include "game/GameEvents.h"
#include "game/Config.h"
#include "game/HordeBridge.h"
#include "game/Logistics.h"
#include "game/Soldiers.h"

#include <SDL3/SDL.h>
#include <algorithm>
#include <cmath>
#include <cstring>

namespace ttz::game {

namespace {
constexpr float kPi = 3.14159265f;
constexpr float kEmptyCrateHold = 20.f, kEmptyCrateDissolve = 2.5f;   // visual only (OWNER: crate removal policy)
constexpr float kIconHeight = 2.7f;                                   // m above the squad's highest member

// The frozen canopy of a soldier drop after landing / harness release (the lab's advanceDrop does the same from its
// own events): released -> recover clip at its harness_release event, else the land clip's last frame.
void restingCanopy(const MilitaryLibrary& lib, const std::string& cls, bool released, float rel[MC_STRIDE]) {
    std::memset(rel, 0, sizeof(float) * MC_STRIDE);
    int cLand = lib.findClip(cls, "para_land"), cRec = lib.findClip(cls, "para_recover");
    if (released && cRec >= 0) {
        const MilKeyClip& k = lib.keyClips[(size_t)cRec];
        for (const MilFxEvent& e : k.events)
            if (e.type == "harness_release" && k.sampleCanopy(e.t, rel)) return;
    }
    if (cLand >= 0) lib.keyClips[(size_t)cLand].sampleCanopy(lib.keyClips[(size_t)cLand].duration, rel);
}
int dropPhaseOf(AnimAction a) { return a == AnimAction::ParaDescent ? 0 : a == AnimAction::ParaLand ? 1 : a == AnimAction::ParaRecover ? 2 : 3; }
} // namespace

bool GameRender::init(AppState& app) {
    mil_ = new MilitaryRenderer();
    if (!mil_->init(app.gpu, app.cityRenderer, app.chars, app.sim, app.chars.metresPerVoxel())) {
        mil_->shutdown();
        delete mil_;
        mil_ = nullptr;
        return false;
    }
    CityRenderer* city = &app.cityRenderer;
    mil_->groundHeight = [city](float x, float z) { return city->heightAt(x, z); };
    mil_->installHooks(app.renderer, true);   // own extension slot (+ flash lights); coexists with any other client
    anim_.init(mil_->library());
    demo_ = app.opt.gameDemoRender;
    if (demo_) initDemo(app);
    SDL_Log("game: soldier renderer ready (%zu infantry, %zu props, %zu clips)%s", mil_->library().infantry.size(), mil_->library().props.size(),
            mil_->library().keyClips.size(), demo_ ? "; --game-demo-render" : "");
    return true;
}

void GameRender::shutdown(AppState& app) {
    if (!mil_) return;
    mil_->removeHooks(app.renderer);
    mil_->shutdown();
    delete mil_;
    mil_ = nullptr;
}

// Pose input of a soldier `ahead` seconds after its last tick (clip times advanced; no events, no switches).
void GameRender::soldierPose(const AnimPlayback& a, int infantry, V3 pos, float yaw, float ahead, MilPoseInput& out) const {
    AnimPlayback s = anim_.sampleAhead(a, infantry, ahead);
    static_cast<MilPlayback&>(out) = static_cast<const MilPlayback&>(s);
    if (out.clip < 0) out.clip = 0;
    out.infantry = infantry;
    out.pos = pos;
    out.yaw = yaw;
    out.lod = -1;
}

// Visual clip events (muzzle flash, tracer, casing, puff, footstep, body fall) crossed since the last render frame on
// the same clip timeline the game tick reads its gameplay events from. Beyond LOD1 / off screen: none.
void GameRender::clipFx(uint32_t slot, uint32_t gen, const MilPoseInput& p, bool visible, float frameDt, std::vector<FxTrack>& tracks, bool shotFx) {
    if (tracks.size() <= slot) tracks.resize(slot + 1);
    FxTrack& tr = tracks[slot];
    const MilitaryLibrary& lib = mil_->library();
    const MilInfantry& inf = lib.infantry[(size_t)p.infantry];
    const bool same = tr.gen == gen && tr.clip == p.clip;
    const float prev = same ? tr.t : std::max(0.f, p.t - frameDt * p.rate);
    tr.gen = gen; tr.clip = p.clip; tr.t = p.t;
    if (!visible || p.clip < 0 || p.clip >= (int)inf.clips.size() || inf.clips[(size_t)p.clip].keyClip < 0) return;
    const MilKeyClip& k = lib.keyClips[(size_t)inf.clips[(size_t)p.clip].keyClip];
    const bool wrapped = same && k.loop && p.t < prev - 1e-5f;
    if (same && !wrapped && p.t <= prev) return;
    for (const MilFxEvent& e : k.events) {
        bool hit = wrapped ? (e.t > prev || e.t <= p.t) : same ? (e.t > prev && e.t <= p.t) : (e.t >= prev && e.t <= p.t);
        if (!hit) continue;
        if (!shotFx && (e.type == "muzzle_flash" || e.type == "tracer" || e.type == "suppressed" || e.type == "shell_eject")) continue;
        mil_->fxEvent(p, e);
    }
}

void GameRender::update(AppState& app, const GameContext& ctx, float frameDt, float alpha, const std::vector<FxEvent>& fx) {
    if (!mil_) return;
    float aspect = (float)app.opt.width / (float)std::max(1, app.opt.height);
    if (app.window) { int w, h; SDL_GetWindowSize(app.window, &w, &h); aspect = (float)w / (float)std::max(1, h); }
    mil_->beginFrame(app.camera, aspect);
    const float ahead = std::clamp(alpha, 0.f, 1.f) * (float)kTickDt;
    const MilitaryLibrary& lib = mil_->library();
    const float fdt = app.paused ? 0.f : frameDt * app.simSpeed;

    // ---- soldiers (alive, dying and dead bodies: the death clip holds its last frame)
    if (const SoldierPool* P = ctx.soldiers) {
        for (uint32_t i = 0; i < (uint32_t)P->capacity(); ++i) {
            if (!P->used[i] || P->infantry[i] >= lib.infantry.size()) continue;
            if (P->post[i] == POST_INSIDE) continue;   // B3a: patients inside a hospital (interiors are never drawn)
            MilPoseInput p;
            const bool moving = P->alive(i);
            soldierPose(P->anim[i], P->infantry[i], moving ? P->pos[i] + P->vel[i] * ahead : P->pos[i], P->yaw[i], app.paused ? 0.f : ahead, p);
            p.noWeapon = P->unarmed[i] != 0;   // rising dead soldier: his weapon stays on the ground
            ++mil_->stats().soldiers;
            const bool shown = mil_->addSoldier(p);
            clipFx(i, P->gen[i], p, shown && mil_->lodAt(p.pos) < 2, fdt, fxTracks_, false);   // rounds: shotFx below
            if (soldierRings && shown && P->alive(i) && P->state[i] != SoldierState::Descending)
                mil_->addMarker(MilMarker::Ring, classColor(P->cls[i]), P->pos[i] + V3{0, 0.02f, 0}, 0.f);
        }
        if (droppedWeapons)
            for (const DroppedWeapon& w : *droppedWeapons) {
                MilPoseInput p;
                p.infantry = w.infantry; p.clip = w.clip; p.t = w.t; p.pos = w.pos; p.yaw = w.yaw;
                if (mil_->visible(w.pos, 1.5f)) mil_->addDroppedWeapon(p);
            }
        // selection rings + class icons
        if (ctx.squads)
            for (const Squad& s : ctx.squads->squads) {
                const bool sel = std::find(selected_.begin(), selected_.end(), s.id) != selected_.end();
                V3 c{};
                float top = -1e9f;
                int n = 0;
                SoldierClass cls = SoldierClass::Rifleman;
                for (const SoldierId& m : s.members) {
                    if (!P->valid(m) || !P->alive(m.index)) continue;
                    const V3 pos = P->pos[m.index] + P->vel[m.index] * ahead;
                    cls = P->cls[m.index];
                    c = c + pos; top = std::max(top, pos.y); ++n;
                    if (sel && P->state[m.index] != SoldierState::Descending) mil_->addMarker(MilMarker::RingSelected, MK_WHITE, pos + V3{0, 0.02f, 0}, 0.f);
                }
                if (!n || !classIcons) continue;
                c = c * (1.f / (float)n);
                mil_->addMarker(classIcon(cls), sel ? (uint8_t)MK_WHITE : classColor(cls), {c.x, top + kIconHeight, c.z}, 0.f);
            }
    }

    // ---- deploy canopies (the body is the SoldierPool soldier above)
    if (ctx.deploy && ctx.soldiers) {
        const SoldierPool& P = *ctx.soldiers;
        for (const DropTrack& t : ctx.deploy->drops()) {
            const uint32_t i = t.soldier.index;
            if (!P.valid(t.soldier) || P.infantry[i] >= lib.infantry.size()) continue;
            if (canopy_.size() <= i) canopy_.resize(i + 1);
            CanopyClock& ck = canopy_[i];
            if (ck.gen != P.gen[i]) { ck.gen = P.gen[i]; ck.groundT = -1.f; }
            if (t.groundT >= 0.f) ck.groundT = ck.groundT < 0.f ? t.groundT : std::max(ck.groundT + fdt, t.groundT);
            const AnimPlayback& a = P.anim[i];
            MilDrop d;
            d.inf = P.infantry[i];
            d.yaw = P.yaw[i];
            d.drawBody = false; d.demoLoop = false; d.externalDescent = true;
            d.phase = t.phase == DropPhase::Descent ? 0 : t.phase == DropPhase::Land ? 1 : t.phase == DropPhase::Recover ? 2 : 3;
            const int animPhase = dropPhaseOf(a.action);
            AnimPlayback s = anim_.sampleAhead(a, d.inf, app.paused ? 0.f : ahead);
            d.t = animPhase == d.phase ? s.t : t.t;
            if (d.phase == 0) { V3 p = P.pos[i] + P.vel[i] * ahead; d.xz = {p.x, t.landing.y, p.z}; d.alt = std::max(0.f, p.y - t.landing.y); }
            else d.xz = t.landing;
            d.released = t.released;
            d.groundT = ck.groundT;
            std::memcpy(d.clamp, t.clamp, sizeof(d.clamp));
            if (d.phase >= 2 || d.released) restingCanopy(lib, lib.infantry[(size_t)d.inf].cls, d.released, d.relCanopy);
            mil_->addDrop(d);
        }
    }

    // ---- supply points: containers (approved prop), airdrop crates (crate clips + canopy dissolve)
    if (ctx.logistics) {
        const int container = mil_->findProp("container_supply");
        for (const SupplyPoint& sp : ctx.logistics->points()) {
            if (sp.kind == SupplyKind::Container) { if (!extraDraw) mil_->addProp(container, sp.pos, sp.yaw); continue; }   // B2: extraDraw (drop)
            const uint32_t k = sp.id.index;
            if (crates_.size() <= k) crates_.resize(k + 1);
            CrateSeq& cs = crates_[k];
            if (!cs.seen || cs.gen != sp.id.gen) {
                cs = CrateSeq{};
                cs.seen = true; cs.gen = sp.id.gen;
                cs.drop.cargo = true; cs.drop.demoLoop = false; cs.drop.externalDescent = true; cs.drop.yaw = sp.yaw;
                if (sp.landed) { cs.drop.phase = 3; cs.drop.groundT = 99.f; cs.landed = true; }   // already down: no canopy
            }
            MilDrop& d = cs.drop;
            d.xz = sp.pos;
            if (!sp.landed) { d.phase = 0; d.alt = sp.altitude; d.t = sp.descentT; }
            else if (!cs.landed) { cs.landed = true; d.phase = 1; d.t = 0.f; d.alt = 0.f; }
            if (d.phase > 0) mil_->advanceDrop(d, fdt);
            d.crateDissolve = sp.emptyFor > kEmptyCrateHold ? std::clamp((sp.emptyFor - kEmptyCrateHold) / kEmptyCrateDissolve, 0.f, 1.f) : 0.f;
            mil_->addDrop(d);
        }
    }

    // ---- FX requests from gameplay (dust, impacts). Footsteps come from the clip timeline above.
    for (const FxEvent& e : fx) {
        if (e.kind == FxKind::Landing || e.kind == FxKind::CrateTouch) mil_->fxBurst(e.pos, 1);
        else if (e.kind == FxKind::Impact) mil_->fxBurst(e.pos, 0);
        else if (e.kind == FxKind::Flame && ctx.soldiers && ctx.soldiers->valid(e.soldier)) {   // 14d flamethrower spray
            const SoldierPool& P = *ctx.soldiers;
            const uint32_t i = e.soldier.index;
            if (P.infantry[i] < mil_->library().infantry.size()) {
                MilPoseInput p;
                soldierPose(P.anim[i], P.infantry[i], P.pos[i] + P.vel[i] * ahead, P.yaw[i], app.paused ? 0.f : ahead, p);
                if (mil_->visible(p.pos, 10.f)) mil_->fxFlame(p, e.dir, ctx.cfg ? ctx.cfg->weapon[(size_t)SoldierClass::Flamethrower].range : 9.f);
            }
        }
    }
    shotFx(app, ctx, fx, ahead);

    if (demo_) updateDemo(app, frameDt);
    for (const WorldMarker& m : markers_) mil_->addMarker(m.shape, m.color, m.pos, m.yaw);
    if (extraDraw) extraDraw(*mil_, fdt);
    mil_->updateFx(fdt);
    mil_->endFrame();
}

// Rounds (FxKind::Shot, one per round Combat fired): muzzle flash at the posed muzzle (any distance: the flash keeps a
// minimum on-screen size), casing near the camera, and every tracerEvery[class]-th round a tracer from the posed
// muzzle along the shot ray. Its end is first estimated (the target's distance along the ray, else the weapon range)
// and corrected when the GPU resolves the round (HordeBridge::hitResults, same queue order per shooter), so the
// streak stops on the zombie or wall that took the round.
void GameRender::shotFx(AppState& app, const GameContext& ctx, const std::vector<FxEvent>& fx, float ahead) {
    (void)app;
    const SoldierPool* P = ctx.soldiers;
    if (!P || !ctx.cfg) return;
    for (const FxEvent& e : fx) {
        if (e.kind != FxKind::Shot || !P->valid(e.soldier)) continue;
        const uint32_t i = e.soldier.index;
        if (P->infantry[i] >= mil_->library().infantry.size()) continue;
        const int cls = std::clamp((int)P->cls[i], 0, 2);
        const float range = ctx.cfg->weapon[cls].range;
        float dist = range;
        if (P->target[i].active) {   // the round is aimed at the target: estimate its stop there (a hit) until resolved
            const float along = dot(P->target[i].pos - e.pos, e.dir);
            if (along > 1.f && along < range + 30.f) dist = along + 0.3f;   // 3D: roof / window shots reach a bit past the 2D range
        }
        const uint32_t n = i < P->rounds.size() ? P->rounds[i] : 0u;
        const bool tracer = tracerEvery[cls] > 0 && n % (uint32_t)tracerEvery[cls] == 0;
        MilPoseInput p;
        soldierPose(P->anim[i], P->infantry[i], P->pos[i] + P->vel[i] * ahead, P->yaw[i], app.paused ? 0.f : ahead, p);
        const bool near = mil_->visible(p.pos, 1.2f) && mil_->lodAt(p.pos) < 2;
        const uint32_t id = mil_->fxShotRay(p, e.pos + e.dir * dist, tracer, near);
        pendingRounds_.push_back({e.soldier.packed(), id, e.pos, e.dir, 0});
    }
    // resolved rounds (newest harvested frame): per shooter in queue order
    if (const HordeBridge* hb = dynamic_cast<const HordeBridge*>(ctx.horde); hb && hb->hitResultsFrame() != lastHitFrame_) {
        lastHitFrame_ = hb->hitResultsFrame();
        for (const HordeBridge::HitResult& r : hb->hitResults()) {
            auto it = std::find_if(pendingRounds_.begin(), pendingRounds_.end(), [&](const PendingRound& q) { return q.shooter == r.shooterPacked; });
            if (it == pendingRounds_.end()) continue;
            if (r.kind != HordeBridge::HitKind::Miss) mil_->fxTracerEnd(it->tracer, r.dist);
            pendingRounds_.erase(it);
        }
    }
    for (PendingRound& q : pendingRounds_) ++q.frames;
    pendingRounds_.erase(std::remove_if(pendingRounds_.begin(), pendingRounds_.end(), [](const PendingRound& q) { return q.frames > 30; }), pendingRounds_.end());
}

// ---------------------------------------------------------------------------------------------------------------
// --game-demo-render: static soldiers playing clips through SoldierAnimator (30 Hz ticks) + GameRender

void GameRender::initDemo(AppState& app) {
    const MilitaryLibrary& lib = mil_->library();
    std::vector<int> byCls[3];
    for (size_t i = 0; i < lib.infantry.size(); ++i)
        byCls[lib.infantry[i].cls == "mg" ? 1 : lib.infantry[i].cls == "sniper" ? 2 : 0].push_back((int)i);
    for (auto& v : byCls) if (v.empty()) v.push_back(0);
    // a clear street patch near the window centre (static raster), 22 x 16 m
    const Sandbox& sb = app.sandbox;
    auto h = [&](float x, float z) {
        int i = (int)std::floor((x - sb.originX) / sb.cellSize), j = (int)std::floor((z - sb.originZ) / sb.cellSize);
        if (i < 0 || j < 0 || i >= sb.gridW || j >= sb.gridH || app.staticHeights.empty()) return 99.f;
        return app.staticHeights[(size_t)j * sb.gridW + i];
    };
    const float cx = sb.originX + 0.5f * sb.gridW * sb.cellSize, cz = sb.originZ + 0.5f * sb.gridH * sb.cellSize;
    demoOrigin_ = {cx, 0.f, cz};
    demoYaw_ = 0.f;
    float best = 1e30f;
    for (float dz = -120.f; dz <= 120.f; dz += 2.f)
        for (float dx = -120.f; dx <= 120.f; dx += 2.f) {
            float d2 = dx * dx + dz * dz;
            if (d2 >= best) continue;
            for (int o = 0; o < 4; ++o) {
                float yaw = o * 0.5f * kPi, c = std::cos(yaw), s = std::sin(yaw);
                bool ok = true;
                for (float lz = -12.f; lz <= 4.f && ok; lz += 0.75f)
                    for (float lx = -11.f; lx <= 11.f && ok; lx += 0.75f) ok = h(cx + dx + lx * c + lz * s, cz + dz - lx * s + lz * c) <= 0.3f;
                if (ok) { best = d2; demoOrigin_ = {cx + dx, 0.f, cz + dz}; demoYaw_ = yaw; break; }
            }
        }
    demoOrigin_.y = h(demoOrigin_.x, demoOrigin_.z) < 90.f ? std::max(0.f, h(demoOrigin_.x, demoOrigin_.z)) : 0.f;
    auto world = [&](float lx, float lz) {
        float c = std::cos(demoYaw_), s = std::sin(demoYaw_);
        return V3{demoOrigin_.x + lx * c + lz * s, demoOrigin_.y, demoOrigin_.z - lx * s + lz * c};
    };
    auto add = [&](int cls, int variant, float lx, float lz, AnimAction act, float speed, float every, int squad) {
        DemoSoldier d;
        d.cls = (SoldierClass)cls;
        d.infantry = byCls[cls][(size_t)variant % byCls[cls].size()];
        d.pos = world(lx, lz); d.yaw = demoYaw_; d.action = act; d.every = every; d.squad = squad;
        anim_.reset(d.anim, d.infantry, AnimAction::Idle);
        anim_.request(d.anim, act, speed);
        d.anim.requestedSpeed = speed;
        demo_s_.push_back(d);
    };
    // row 0: rifle squad (selected): idle, walk, run (in place, rate from speed), aim, fire
    add(0, 0, -5.f, 0.f, AnimAction::Idle, 0.f, 0.f, 0);
    add(0, 1, -2.5f, 0.f, AnimAction::Walk, 1.3f, 0.f, 0);
    add(0, 2, 0.f, 0.f, AnimAction::Run, 3.8f, 0.f, 0);
    add(0, 3, 2.5f, 0.f, AnimAction::Aim, 0.f, 0.f, 0);
    add(0, 4, 5.f, 0.f, AnimAction::Fire, 0.f, 0.f, 0);
    // row 1: MG squad (fire, crouch fire, reload loop), snipers (fire, collect ammo)
    add(1, 0, -6.f, -3.5f, AnimAction::Fire, 0.f, 0.f, 1);
    add(1, 1, -3.5f, -3.5f, AnimAction::CrouchFire, 0.f, 0.f, 1);
    add(1, 2, -1.f, -3.5f, AnimAction::Reload, 0.f, 5.f, 1);
    add(2, 0, 2.5f, -3.5f, AnimAction::Fire, 0.f, 0.f, 2);
    add(2, 1, 5.f, -3.5f, AnimAction::CollectAmmo, 0.f, 4.5f, 3);
    // row 2: deaths a / b / c (restart every 6 s), hit reaction, turn left (root motion)
    for (int k = 0; k < 3; ++k) { add(0, k, -6.f + 2.5f * k, -7.f, AnimAction::Death, 0.f, 6.f, 4); demo_s_.back().anim.deathVariant = (uint8_t)(k + 1); }
    add(0, 3, 1.5f, -7.f, AnimAction::Hit, 0.f, 1.6f, 4);
    add(0, 4, 4.f, -7.f, AnimAction::TurnL, 0.f, 2.f, 4);
    // a parachute drop (soldier) and an airdrop crate, both looping; a supply container
    {
        DemoSoldier d;
        d.cls = SoldierClass::Rifleman; d.infantry = byCls[0][1 % byCls[0].size()];
        d.pos = world(9.f, -3.f); d.yaw = demoYaw_ + 0.4f; d.para = true; d.alt = 22.f; d.squad = 5; d.action = AnimAction::ParaDescent;
        anim_.reset(d.anim, d.infantry, AnimAction::ParaDescent);
        demo_s_.push_back(d);
        MilDrop canopy;   // driven from the soldier's AnimPlayback each frame
        canopy.inf = d.infantry; canopy.drawBody = false; canopy.demoLoop = false; canopy.externalDescent = true;
        demoDrops_.push_back(canopy);
        MilDrop crate;
        crate.cargo = true; crate.xz = world(-9.5f, -4.f); crate.yaw = demoYaw_ + 0.2f; crate.startH = 25.f;
        demoDrops_.push_back(crate);
    }
    app.camera.settings.minDistance = 3.f;   // screenshots: close-ups allowed (demo only)
    app.camera.settings.minPitch = 0.1f;
    if (app.opt.camSet) app.camera.setImmediate({app.opt.camX, app.opt.camY, app.opt.camZ}, app.opt.camYaw, app.opt.camPitch, app.opt.camDist);
    else app.camera.setImmediate(world(0.f, -3.f) + V3{0, 0.8f, 0}, demoYaw_ + 0.35f, 26.f * kPi / 180.f, 21.f);
    SDL_Log("game: demo render: %zu soldiers at (%.1f, %.1f) heading %.0f deg", demo_s_.size(), demoOrigin_.x, demoOrigin_.z, demoYaw_ * 180.f / kPi);
}

void GameRender::updateDemo(AppState& app, float frameDt) {
    const MilitaryLibrary& lib = mil_->library();
    const float fdt = app.paused ? 0.f : frameDt;
    // fixed 30 Hz ticks (the game's tick), render-time interpolation between them
    demoAcc_ += fdt;
    int n = 0;
    while (demoAcc_ >= (float)kTickDt && n < kMaxTicksPerFrame) {
        demoAcc_ -= (float)kTickDt;
        ++n;
        demoEvents_.clear();
        for (uint32_t i = 0; i < (uint32_t)demo_s_.size(); ++i) {
            DemoSoldier& d = demo_s_[i];
            d.clock += (float)kTickDt;
            if (d.para) {   // Deploy-like timeline: descent at the clip speed -> land -> recover -> idle, again after 16 s
                if (d.action == AnimAction::ParaDescent) {
                    int c = lib.findClip(lib.infantry[(size_t)d.infantry].cls, "para_descent");
                    d.alt -= (c >= 0 ? std::max(1.f, lib.keyClips[(size_t)c].descentSpeed) : 5.f) * (float)kTickDt;
                    if (d.alt <= 0.f) { d.alt = 0.f; d.action = AnimAction::ParaLand; anim_.request(d.anim, AnimAction::ParaLand); }
                }
                if (d.clock > 16.f) {
                    d.clock = 0.f; d.alt = 22.f; d.action = AnimAction::ParaDescent;
                    anim_.reset(d.anim, d.infantry, AnimAction::ParaDescent);
                    demoDrops_[0].released = false; demoDrops_[0].groundT = -1.f;
                }
            } else if (d.every > 0.f && d.clock >= d.every) {   // replay the one-shot (a new request edge)
                d.clock = 0.f;
                if (d.action == AnimAction::Death) { uint8_t v = d.anim.deathVariant; anim_.reset(d.anim, d.infantry, AnimAction::Idle); d.anim.deathVariant = v; }
                anim_.request(d.anim, AnimAction::Idle);
                anim_.request(d.anim, d.action);
            }
            float root[3];
            const size_t e0 = demoEvents_.size();
            anim_.tick(i, d.infantry, d.anim, (float)kTickDt, demoEvents_, root);
            SoldierAnimator::applyRootMotion(d.pos, d.yaw, root);   // turns: the yaw keeps the committed 90 degrees
            for (size_t k = e0; k < demoEvents_.size(); ++k) {
                const AnimEvent& e = demoEvents_[k];
                if (!d.para) continue;
                if (e.type == "land_end") { d.action = AnimAction::ParaRecover; anim_.request(d.anim, AnimAction::ParaRecover); }
                else if (e.type == "recover_end") { d.action = AnimAction::Idle; anim_.request(d.anim, AnimAction::Idle); }
                else if (e.type == "harness_release") demoDrops_[0].released = true;
                else if (e.type == "canopy_ground" && demoDrops_[0].groundT < 0.f) demoDrops_[0].groundT = 0.f;
                else if (e.type == "touchdown") mil_->fxBurst(d.pos, 1);
            }
        }
        if (demoDrops_[0].groundT >= 0.f) demoDrops_[0].groundT += (float)kTickDt;
        mil_->advanceDrop(demoDrops_[1], (float)kTickDt);   // crate: the lab's own sequence (descent, land, dissolve, loop)
    }
    if (demoAcc_ > (float)kTickDt) demoAcc_ = 0.f;
    const float ahead = app.paused ? 0.f : demoAcc_;
    for (uint32_t i = 0; i < (uint32_t)demo_s_.size(); ++i) {
        DemoSoldier& d = demo_s_[i];
        MilPoseInput p;
        soldierPose(d.anim, d.infantry, d.pos + V3{0, d.para ? d.alt : 0.f, 0}, d.yaw, ahead, p);
        ++mil_->stats().soldiers;
        const bool shown = mil_->addSoldier(p);
        clipFx(i, 0, p, shown && mil_->lodAt(p.pos) < 2, fdt, demoFx_, true);
        if (d.para) {
            MilDrop& c = demoDrops_[0];
            c.xz = d.pos; c.yaw = d.yaw; c.alt = d.alt; c.phase = dropPhaseOf(d.anim.action); c.t = p.t;
            if (c.phase >= 2 || c.released) restingCanopy(lib, lib.infantry[(size_t)d.infantry].cls, c.released, c.relCanopy);
            mil_->addDrop(c);
        }
    }
    mil_->addDrop(demoDrops_[1]);
    // markers: the rifle squad selected (rings), class icons above every row, a move target, a container
    float top[6] = {-1e9f, -1e9f, -1e9f, -1e9f, -1e9f, -1e9f};
    V3 cen[6];
    int cnt[6] = {0, 0, 0, 0, 0, 0};
    SoldierClass cls[6] = {SoldierClass::Rifleman, SoldierClass::Rifleman, SoldierClass::Rifleman, SoldierClass::Rifleman, SoldierClass::Rifleman, SoldierClass::Rifleman};
    for (const DemoSoldier& d : demo_s_) {
        if (d.squad == 0) mil_->addMarker(MilMarker::RingSelected, MK_WHITE, d.pos + V3{0, 0.02f, 0}, 0.f);
        else if (d.squad == 1 || d.squad == 2) mil_->addMarker(MilMarker::Ring, classColor(d.cls), d.pos + V3{0, 0.02f, 0}, 0.f);
        cen[d.squad] = cen[d.squad] + d.pos; top[d.squad] = std::max(top[d.squad], d.pos.y); ++cnt[d.squad]; cls[d.squad] = d.cls;
    }
    for (int s = 0; s < 4; ++s)
        if (cnt[s]) { V3 c = cen[s] * (1.f / (float)cnt[s]); mil_->addMarker(classIcon(cls[s]), s == 0 ? (uint8_t)MK_WHITE : classColor(cls[s]), {c.x, top[s] + kIconHeight, c.z}, 0.f); }
    float c = std::cos(demoYaw_), s = std::sin(demoYaw_);
    auto world = [&](float lx, float lz) { return V3{demoOrigin_.x + lx * c + lz * s, demoOrigin_.y, demoOrigin_.z - lx * s + lz * c}; };
    mil_->addMarker(MilMarker::MoveTarget, MK_GREEN, world(8.f, 2.5f) + V3{0, 0.02f, 0}, demoYaw_);
    mil_->addProp(mil_->findProp("container_supply"), world(-8.5f, -10.5f), demoYaw_ + 0.5f * kPi);
}

} // namespace ttz::game
