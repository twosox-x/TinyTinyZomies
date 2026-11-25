#include "sim/SimParams.h"

#include <SDL3/SDL.h>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <functional>
#include <map>
#include <sstream>

namespace ttz {

namespace {
using Setter = std::function<void(SimParams&, const std::string&)>;
using Getter = std::function<std::string(const SimParams&)>;
struct Field { Setter set; Getter get; };

std::map<std::string, Field>& fields() {
    static std::map<std::string, Field> f;
    if (!f.empty()) return f;
#define F(name) f[#name] = Field{[](SimParams& p, const std::string& v) { std::istringstream(v) >> p.name; }, \
                               [](const SimParams& p) { std::ostringstream o; o << p.name; return o.str(); }}
#define B(name) f[#name] = Field{[](SimParams& p, const std::string& v) { p.name = (v == "1" || v == "true"); }, \
                               [](const SimParams& p) { return std::string(p.name ? "true" : "false"); }}
    F(cellSize); F(gridW); F(gridH); F(agentCapacity); F(corpseCapacity);
    F(fixedDt); F(solverIterations); F(maxStepsPerFrame);
    F(radius); F(standHeight); F(proneHeight); F(baseSpeed); F(crawlSpeed); F(maxSpeed); F(accel); F(gravity);
    F(stepUp); F(wander); F(proneRate);
    F(densityComfort); F(densityMax); F(minSpeedFactor); F(lookAhead); F(maxNeighbors);
    F(sor); F(stiffness); F(massScaleK); F(friction);
    B(verticalEnabled); F(climbBlockThreshold); F(supportCos); F(climbSpeed); F(climbMaxTime);
    B(corpsesEnabled); F(corpseSplatHeight); F(corpseSettleSpeed);
    F(navDensityWeight); F(navClimbWeight); F(navClimbLimit); F(goalRadius); F(navIterationsPerStep);
    F(explosionRadius); F(explosionStrength); F(explosionLethality); F(explosionUpBias);
#undef F
#undef B
    return f;
}
} // namespace

bool SimParams::load(const std::string& path) {
    std::ifstream in(path);
    if (!in) return false;
    std::string line;
    int n = 0;
    while (std::getline(in, line)) {
        auto hash = line.find('#');
        if (hash != std::string::npos) line = line.substr(0, hash);
        auto eq = line.find('=');
        if (eq == std::string::npos) continue;
        auto trim = [](std::string s) {
            size_t a = s.find_first_not_of(" \t\r"), b = s.find_last_not_of(" \t\r");
            return a == std::string::npos ? std::string() : s.substr(a, b - a + 1);
        };
        std::string k = trim(line.substr(0, eq)), v = trim(line.substr(eq + 1));
        auto it = fields().find(k);
        if (it == fields().end()) { SDL_Log("sim.cfg: unknown key '%s'", k.c_str()); continue; }
        it->second.set(*this, v);
        ++n;
    }
    SDL_Log("loaded %d parameters from %s", n, path.c_str());
    return true;
}

bool SimParams::save(const std::string& path) const {
    std::ofstream out(path);
    if (!out) return false;
    out << "# Tiny Tiny Zombies simulation parameters (key = value)\n";
    for (auto& [k, f] : fields()) out << k << " = " << f.get(*this) << "\n";
    return true;
}

} // namespace ttz
