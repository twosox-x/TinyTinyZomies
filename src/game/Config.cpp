#include "game/Config.h"

#include "city/Json.h"

#include <fstream>
#include <sstream>

namespace ttz::game {

const char* stateName(SoldierState s) {
    static const char* n[] = {"descending", "landing", "recovering", "forming", "idle", "moving", "engaging",
                              "reloading", "resupplying", "collecting", "hit", "dying", "dead"};
    return (size_t)s < sizeof(n) / sizeof(n[0]) ? n[(size_t)s] : "?";
}

const char* actionName(AnimAction a) {
    static const char* n[] = {"idle", "walk", "run", "aim", "fire", "crouch_aim", "crouch_fire", "reload", "hit", "death_a",
                              "collect_ammo", "turn_l", "turn_r", "para_descent", "para_land", "para_recover"};
    return (size_t)a < sizeof(n) / sizeof(n[0]) ? n[(size_t)a] : "idle";
}

namespace {
template <class T> void num(const json::Value& v, const char* k, T& out) {
    if (v.has(k)) out = (T)v[k].n((double)out);
}
const char* kCls[3] = {"rifleman", "mg", "sniper"};
const char* kSquad[3] = {"rifle", "mg", "sniper"};
const char* kAmmo[3] = {"rifle", "mg", "sniper"};
} // namespace

bool BalanceConfig::load(const std::string& path, std::string* error) {
    std::ifstream f(path, std::ios::binary);
    if (!f) { if (error) *error = "cannot open " + path; return false; }
    std::stringstream ss;
    ss << f.rdbuf();
    const std::string text = ss.str();
    json::Value root;
    if (!json::Parser(text).parse(root) || root.type != json::Value::Object) { if (error) *error = "parse error in " + path; return false; }
    if (root.has("status")) status = root["status"].str;
    for (int c = 0; c < 3; ++c) {
        const json::Value& w = root["weapons"][kCls[c]];
        WeaponStats& W = weapon[(size_t)c];
        num(w, "damage", W.damage); num(w, "headshotChance", W.headshotChance); num(w, "range", W.range);
        num(w, "accuracy", W.accuracy); num(w, "spreadDeg", W.spreadDeg); num(w, "fireInterval", W.fireInterval);
        num(w, "magazine", W.magazine); num(w, "reserve", W.reserve); num(w, "reloadTime", W.reloadTime);
        num(w, "noise", W.noise); num(w, "noiseRadius", W.noiseRadius); num(w, "acquireTime", W.acquireTime);
        num(w, "acquireRange", W.acquireRange);
        const json::Value& s = root["soldiers"][kCls[c]];
        SoldierStats& S = soldier[(size_t)c];
        num(s, "health", S.health); num(s, "walkSpeed", S.walkSpeed); num(s, "runSpeed", S.runSpeed);
        num(s, "lowAmmoFraction", S.lowAmmoFraction); num(s, "resupplySearchRadius", S.resupplySearchRadius);
        const json::Value& q = root["squads"][kSquad[c]];
        SquadDef& Q = squad[(size_t)c];
        Q.cls = (SoldierClass)c;
        num(q, "size", Q.size); num(q, "price", Q.price); num(q, "formationSpacing", Q.formationSpacing);
    }
    const json::Value& e = root["economy"];
    num(e, "startFunding", economy.startFunding); num(e, "baseIncomePerMin", economy.baseIncomePerMin);
    num(e, "territoryIncomePerKm2PerMin", economy.territoryIncomePerKm2PerMin);
    num(e["killReward"], "soldier", economy.killReward[0]); num(e["killReward"], "explosion", economy.killReward[1]);
    num(e["killReward"], "other", economy.killReward[2]);
    num(e, "containerPrice", economy.containerPrice); num(e, "airdropPrice", economy.airdropPrice);
    const json::Value& l = root["logistics"];
    for (int a = 0; a < 3; ++a) {
        num(l["containerStock"], kAmmo[a], logistics.containerStock[(size_t)a]);
        num(l["crateStock"], kAmmo[a], logistics.crateStock[(size_t)a]);
    }
    num(l, "containerSlots", logistics.containerSlots); num(l, "crateSlots", logistics.crateSlots);
    num(l, "collectRadius", logistics.collectRadius); num(l, "airdropAltitude", logistics.airdropAltitude);
    num(l, "airdropScatter", logistics.airdropScatter);
    const json::Value& t = root["threat"];
    num(t, "attackReach", threat.attackReach); num(t, "damagePerSecond", threat.damagePerSecond);
    num(t, "awarenessRadius", threat.awarenessRadius); num(t, "soldierAttraction", threat.soldierAttraction);
    return true;
}

} // namespace ttz::game
