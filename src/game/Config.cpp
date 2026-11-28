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
                              "collect_ammo", "turn_l", "turn_r", "para_descent", "para_land", "para_recover", "enter_building",
                              "build_hammer", "build_shovel", "build_sandbag", "cut_car", "pry_car", "ignite", "stop", "burn_ground"};
    return (size_t)a < sizeof(n) / sizeof(n[0]) ? n[(size_t)a] : "idle";
}

namespace {
template <class T> void num(const json::Value& v, const char* k, T& out) {
    if (v.has(k)) out = (T)v[k].n((double)out);
}
const char* kCls[kSoldierClasses] = {"rifleman", "mg", "sniper", "flamethrower"};
const char* kSquad[kSquadTypes] = {"rifle", "mg", "sniper", "flamethrower", "engineer"};
// soldier class of each squad type: one per class, plus engineers (riflemen by class, GAME_DESIGN 14d / EngineerAI.h)
const SoldierClass kSquadCls[kSquadTypes] = {SoldierClass::Rifleman, SoldierClass::MachineGunner, SoldierClass::Sniper, SoldierClass::Flamethrower,
                                             SoldierClass::Rifleman};
const char* kAmmo[kAmmoTypes] = {"rifle", "mg", "sniper", "fuel"};
static_assert(kSoldierClasses + 1 == kSquadTypes, "one squad type per soldier class, plus engineers (kSquadCls)");
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
    for (int c = 0; c < (int)kSoldierClasses; ++c) {
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
    }
    for (int c = 0; c < (int)kSquadTypes; ++c) {
        const json::Value& q = root["squads"][kSquad[c]];
        SquadDef& Q = squad[(size_t)c];
        Q.cls = kSquadCls[c];
        num(q, "size", Q.size); num(q, "price", Q.price); num(q, "formationSpacing", Q.formationSpacing);
    }
    const json::Value& e = root["economy"];
    num(e, "startFunding", economy.startFunding); num(e, "baseIncomePerMin", economy.baseIncomePerMin);
    num(e, "territoryIncomePerKm2PerMin", economy.territoryIncomePerKm2PerMin);
    num(e["killReward"], "soldier", economy.killReward[0]); num(e["killReward"], "explosion", economy.killReward[1]);
    num(e["killReward"], "other", economy.killReward[2]);
    num(e, "containerPrice", economy.containerPrice); num(e, "airdropPrice", economy.airdropPrice);
    const json::Value& l = root["logistics"];
    for (int a = 0; a < (int)kAmmoTypes; ++a) {
        num(l["containerStock"], kAmmo[a], logistics.containerStock[(size_t)a]);
        num(l["crateStock"], kAmmo[a], logistics.crateStock[(size_t)a]);
    }
    num(l, "containerSlots", logistics.containerSlots); num(l, "crateSlots", logistics.crateSlots);
    num(l, "collectRadius", logistics.collectRadius); num(l, "airdropAltitude", logistics.airdropAltitude);
    num(l, "airdropScatter", logistics.airdropScatter);
    num(l, "runnerCarryMagazines", logistics.runnerCarryMagazines); num(l, "runnerTrigger", logistics.runnerTrigger);
    const json::Value& t = root["threat"];
    num(t, "attackReach", threat.attackReach); num(t, "damagePerSecond", threat.damagePerSecond);
    num(t, "awarenessRadius", threat.awarenessRadius); num(t, "soldierAttraction", threat.soldierAttraction);
    const json::Value& r = root["reanimation"];
    if (r.has("enabled")) reanimation.enabled = r["enabled"].n(1.0) != 0.0;
    num(r, "delayMin", reanimation.delayMin); num(r, "delayMax", reanimation.delayMax);
    num(r, "riseTime", reanimation.riseTime); num(r, "healthMul", reanimation.healthMul);
    const json::Value& st = root["stamina"];
    num(st, "max", stamina.max); num(st, "drainRun", stamina.drainRun); num(st, "regenWalk", stamina.regenWalk);
    num(st, "regenRest", stamina.regenRest); num(st, "minToRun", stamina.minToRun); num(st, "resumeRun", stamina.resumeRun);
    num(st, "sprintScale", stamina.sprintScale); num(st, "threatRadius", stamina.threatRadius);
    {
        const json::Value& bo = root["buildings"];
        BuildingConfig& b = buildings;
        num(bo, "captureTime", b.captureTime); num(bo, "captureRadius", b.captureRadius); num(bo, "doorClearRadius", b.doorClearRadius);
        num(bo, "garrisonPrice", b.garrisonPrice); num(bo, "hospitalPrice", b.hospitalPrice); num(bo, "garrisonAmmo", b.garrisonAmmo);
        num(bo, "hospitalBeds", b.hospitalBeds); num(bo, "healRate", b.healRate); num(bo, "hospitalSearch", b.hospitalSearch);
        num(bo, "dischargeFraction", b.dischargeFraction); num(bo, "maxFloors", b.maxFloors); num(bo, "windowFloors", b.windowFloors);
        num(bo, "windowSpacing", b.windowSpacing); num(bo, "roofSpacing", b.roofSpacing); num(bo, "maxPositions", b.maxPositions);
        num(bo, "breachDps", b.breachDps); num(bo, "nestPrice", b.nestPrice); num(bo, "nestDamageScale", b.nestDamageScale);
        static const char* bk[3] = {"planks", "plate", "sandbags"};
        for (int k = 0; k < 3; ++k) {
            if (bo.has("barricadePrice")) num(bo["barricadePrice"], bk[k], b.barricadePrice[(size_t)k]);
            if (bo.has("barricadeHealth")) num(bo["barricadeHealth"], bk[k], b.barricadeHealth[(size_t)k]);
        }
    }
    {
        const json::Value& vo = root["vertical"];   // B3b (UNAPPROVED)
        VerticalConfig& v = vertical;
        num(vo, "walkSpeed", v.walkSpeed); num(vo, "climbTimePerFloor", v.climbTimePerFloor); num(vo, "doorTime", v.doorTime);
        num(vo, "hatchTime", v.hatchTime); num(vo, "doorCapacity", v.doorCapacity); num(vo, "stairCapacity", v.stairCapacity);
        num(vo, "floorCapacity", v.floorCapacity); num(vo, "hatchCapacity", v.hatchCapacity); num(vo, "captureRadius", v.captureRadius);
        num(vo, "defenderDps", v.defenderDps); num(vo, "attackersPerSoldier", v.attackersPerSoldier);
        num(vo, "entranceRadius", v.entranceRadius); num(vo, "routeWeight", v.routeWeight); num(vo, "minReachFraction", v.minReachFraction);
        vertical.breachPerZombie = buildings.breachDps;
    }
    {
        const json::Value& ro = root["rot"];   // GAME_DESIGN 14d (UNAPPROVED)
        RotConfig& R = rot;
        if (ro.has("enabled")) R.enabled = ro["enabled"].n(1.0) != 0.0;
        num(ro, "delay", R.delay); num(ro, "ramp", R.ramp); num(ro, "emitPerCorpse", R.emitPerCorpse);
        num(ro, "diffusion", R.diffusion); num(ro, "decay", R.decay); num(ro, "maxGas", R.maxGas);
        num(ro, "damageThreshold", R.damageThreshold); num(ro, "damagePerSecond", R.damagePerSecond);
        num(ro, "maxDamagePerSecond", R.maxDamagePerSecond); num(ro, "warnLevel", R.warnLevel);
        num(ro, "navAvoidLevel", R.navAvoidLevel); num(ro, "navCost", R.navCost);
        const json::Value& fl = root["flame"];
        FlameConfig& F = flame;
        num(fl, "coneDeg", F.coneDeg); num(fl, "zombieDps", F.zombieDps); num(fl, "groundFireTime", F.groundFireTime);
        num(fl, "groundFireDps", F.groundFireDps); num(fl, "corpseIgnite", F.corpseIgnite); num(fl, "corpseBurnTime", F.corpseBurnTime);
        num(fl, "seekRadius", F.seekRadius); num(fl, "seekInterval", F.seekInterval); num(fl, "seekMinCorpses", F.seekMinCorpses);
        num(fl, "standoff", F.standoff); num(fl, "friendlyClearance", F.friendlyClearance);
    }
    const json::Value& fo = root["fort"];
    for (int v = 0; v < 2; ++v) {
        const char* kv = v ? "reinforced" : "cheap";
        num(fo["wallPrice"], kv, fort.wallPrice[(size_t)v]); num(fo["wallHealth"], kv, fort.wallHealth[(size_t)v]);
        num(fo["wallHeight"], kv, fort.wallHeight[(size_t)v]);
    }
    num(fo, "gatePriceMul", fort.gatePriceMul); num(fo, "damagePerZombie", fort.damagePerZombie);
    num(fo, "pressureThreshold", fort.pressureThreshold); num(fo, "buildTime", fort.buildTime);
    num(fo, "territoryCell", fort.territoryCell); num(fo, "minRegionArea", fort.minRegionArea);
    num(fo, "incomePerHectarePerMin", fort.incomePerHectarePerMin); num(fo, "clearDelay", fort.clearDelay);
    num(fo, "lossTime", fort.lossTime); num(fo, "containerAltitude", fort.containerAltitude);
    num(fo, "containerDescentSpeed", fort.containerDescentSpeed); num(fo, "containerLandDuration", fort.containerLandDuration);
    if (fo.has("containerNeedsTerritory")) fort.containerNeedsTerritory = fo["containerNeedsTerritory"].n(0) != 0;
    const json::Value& en = root["engineers"];
    num(en, "radius", engineer.radius); num(en, "pieceTime", engineer.pieceTime); num(en, "gateTime", engineer.gateTime);
    num(en, "carTime", engineer.carTime); num(en, "carPrice", engineer.carPrice); num(en, "workRange", engineer.workRange);
    num(en, "carSearch", engineer.carSearch);
    const json::Value& st = root["structures"];
    StructureConfig& S = structures;
    num(st, "towerPrice", S.towerPrice); num(st, "generatorPrice", S.generatorPrice); num(st, "lightPrice", S.lightPrice); num(st, "fuelStorePrice", S.fuelStorePrice);
    num(st, "towerTime", S.towerTime); num(st, "generatorTime", S.generatorTime); num(st, "lightTime", S.lightTime); num(st, "fuelStoreTime", S.fuelStoreTime);
    num(st, "towerHealth", S.towerHealth); num(st, "towerDamagePerZombie", S.towerDamagePerZombie); num(st, "towerPressureThreshold", S.towerPressureThreshold);
    num(st, "towerHalf", S.towerHalf); num(st, "towerObstacleTop", S.towerObstacleTop); num(st, "deckHeight", S.deckHeight); num(st, "towerCapacity", S.towerCapacity);
    num(st, "climbTime", S.climbTime); num(st, "fallDamage", S.fallDamage);
    num(st, "generatorTank", S.generatorTank); num(st, "generatorBurn", S.generatorBurn); num(st, "burnPerLight", S.burnPerLight);
    num(st, "generatorMaxLights", S.generatorMaxLights); num(st, "cableRange", S.cableRange); num(st, "fuelLinkRange", S.fuelLinkRange);
    if (st["lightsOnlyAtNight"].type == json::Value::Bool) S.lightsOnlyAtNight = st["lightsOnlyAtNight"].b;
    num(st, "lightRadius", S.lightRadius); num(st, "lightIntensity", S.lightIntensity); num(st, "lightHeight", S.lightHeight); num(st, "lightReach", S.lightReach);
    num(st, "noiseIntensity", S.noiseIntensity); num(st, "noiseRadius", S.noiseRadius); num(st, "noiseStackRadius", S.noiseStackRadius);
    num(st, "noiseCap", S.noiseCap); num(st, "noiseRadiusCap", S.noiseRadiusCap); num(st, "noiseInterval", S.noiseInterval);
    num(st, "fuelStoreCapacity", S.fuelStoreCapacity); num(st, "fuelStoreStart", S.fuelStoreStart);
    num(st, "carFuel", S.carFuel); num(st, "siphonTime", S.siphonTime); num(st, "siphonPrice", S.siphonPrice);
    num(st, "jerrycanLitres", S.jerrycanLitres); num(st, "deliverRange", S.deliverRange);
    return true;
}

} // namespace ttz::game
