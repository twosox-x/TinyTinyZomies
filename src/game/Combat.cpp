// Combat logic (WS-C): STUB. spreadDir is real (deterministic cone sampling, used by tests of every workstream).
#include "game/Combat.h"

#include <algorithm>
#include <cmath>

namespace ttz::game {

void Combat::tick(GameContext& ctx) {}

V3 Combat::spreadDir(V3 dir, float spreadDeg, uint32_t& rng) {
    const float a = spreadDeg * 3.14159265f / 180.f;
    const float u = rand01(rng), v = rand01(rng);
    const float cosT = 1.f - u * (1.f - std::cos(a)), sinT = std::sqrt(std::max(0.f, 1.f - cosT * cosT)), phi = v * 6.2831853f;
    V3 d = normalize(dir);
    V3 t = std::fabs(d.y) < 0.99f ? normalize(cross(d, V3{0, 1, 0})) : V3{1, 0, 0};
    V3 b = cross(d, t);
    return normalize(d * cosT + t * (sinT * std::cos(phi)) + b * (sinT * std::sin(phi)));
}

} // namespace ttz::game
