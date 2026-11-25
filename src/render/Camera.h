#pragma once
// Perspective RTS camera: orbits a ground target. Free horizontal movement, smooth zoom,
// full 360-degree yaw, clamped pitch (never street-level first person), frame-rate independent
// exponential smoothing towards the goal state.
#include "render/Math.h"

#include <functional>

namespace ttz {

struct CameraSettings {
    float moveSpeed = 28.f;       // m/s at reference distance (scales with zoom)
    float zoomStep = 0.12f;       // fraction of distance per wheel notch
    float rotateSpeed = 0.006f;   // rad per pixel
    float minDistance = 10.f, maxDistance = 220.f;
    float minPitch = 0.30f, maxPitch = 1.45f;   // rad above the horizon (~17 .. 83 degrees)
    float smoothing = 12.f;       // 1/s, higher = snappier
    float fovY = 0.75f;           // rad
};

class Camera {
public:
    CameraSettings settings;

    void setImmediate(V3 target, float yaw, float pitch, float distance);
    // Inputs are per-frame: move in camera-relative axes (-1..1), zoom notches, rotate in pixels.
    void update(float dt, float moveRight, float moveForward, float zoomNotches, float rotDx, float rotDy, float boost);
    void setGoalTarget(V3 t) { goal_.target = t; }

    M4 view() const;
    M4 proj(float aspect) const;
    V3 eye() const;
    V3 target() const { return cur_.target; }
    void setShake(V3 offset) { shake_ = offset; }   // screen shake: moves eye and target together
    float yaw() const { return cur_.yaw; }
    float pitch() const { return cur_.pitch; }
    float distance() const { return cur_.distance; }
    void clampTarget(float minX, float minZ, float maxX, float maxZ);
    // Buildings stay opaque; instead the camera tilts up until the eye is above any building it
    // would be inside (heightAt returns the obstacle top at a world xz).
    void avoidObstacles(const std::function<float(float, float)>& heightAt, float clearance = 2.0f);

    // Ray from screen point (pixels) intersected with the plane y = planeY.
    bool screenToGround(float sx, float sy, float w, float h, float planeY, V3& out) const;

private:
    struct State { V3 target{}; float yaw = 0.6f, pitch = 0.9f, distance = 80.f; };
    V3 shake_{};
    State cur_, goal_;
};

} // namespace ttz
