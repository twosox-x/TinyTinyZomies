#pragma once
// All tunable simulation parameters. Editable at runtime through the debug UI and
// loadable/savable as a simple "key = value" text file (config/sim.cfg) without recompiling.
#include <string>

namespace ttz {

struct SimParams {
    // world / capacity
    float cellSize = 0.75f;
    int gridW = 256, gridH = 256;
    int agentCapacity = 65536;
    int corpseCapacity = 262144;

    // time
    float fixedDt = 1.0f / 60.0f;
    int solverIterations = 3;
    int maxStepsPerFrame = 2;

    // body
    float radius = 0.26f;
    float standHeight = 1.70f;
    float proneHeight = 0.62f;
    float baseSpeed = 1.6f;
    float crawlSpeed = 0.9f;
    float maxSpeed = 16.0f;
    float accel = 4.0f;
    float gravity = 9.81f;
    float stepUp = 0.45f;
    float wander = 0.35f;
    float proneRate = 4.0f;

    // crowd
    float densityComfort = 1.6f;     // agents / m^2
    float densityMax = 4.5f;
    float minSpeedFactor = 0.35f;    // agents keep pushing in jams
    float lookAhead = 1.5f;
    int maxNeighbors = 128;

    // solver
    float sor = 1.4f;
    float stiffness = 0.9f;
    float massScaleK = 1.2f;
    float friction = 0.85f;

    // vertical accumulation
    bool verticalEnabled = true;
    float climbBlockThreshold = 0.7f;
    float supportCos = 0.7f;         // support normals steeper than this cone slide (angle of repose)
    float climbSpeed = 1.6f;
    float climbMaxTime = 1.6f;

    // corpses
    bool corpsesEnabled = true;
    float corpseSplatHeight = 0.11f; // metres per body splat point (2 points per body)
    float corpseSettleSpeed = 0.6f;

    // navigation
    float navDensityWeight = 0.6f;
    float navClimbWeight = 12.0f;
    float navClimbLimit = 4.5f;
    float goalRadius = 4.0f;
    int navIterationsPerStep = 8;      // red+black sweeps per step

    // explosions
    float explosionRadius = 7.0f;
    float explosionStrength = 14.0f; // m/s impulse at the centre
    float explosionLethality = 2.2f;
    float explosionUpBias = 0.8f;

    bool load(const std::string& path);
    bool save(const std::string& path) const;
};

} // namespace ttz
