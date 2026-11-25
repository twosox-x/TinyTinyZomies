#include "render/Camera.h"

#include <algorithm>

namespace ttz {

void Camera::setImmediate(V3 target, float yaw, float pitch, float distance) {
    goal_ = {target, yaw, std::clamp(pitch, settings.minPitch, settings.maxPitch),
             std::clamp(distance, settings.minDistance, settings.maxDistance)};
    cur_ = goal_;
}

void Camera::update(float dt, float moveRight, float moveForward, float zoomNotches, float rotDx, float rotDy, float boost) {
    // movement speed scales with zoom so it feels constant on screen
    float speed = settings.moveSpeed * (goal_.distance / 80.f) * boost;
    V3 fwd{-std::sin(goal_.yaw), 0, -std::cos(goal_.yaw)};
    V3 right{std::cos(goal_.yaw), 0, -std::sin(goal_.yaw)};
    goal_.target = goal_.target + (fwd * moveForward + right * moveRight) * (speed * dt);
    if (zoomNotches != 0) goal_.distance *= std::pow(1.0f - settings.zoomStep, zoomNotches);
    goal_.distance = std::clamp(goal_.distance, settings.minDistance, settings.maxDistance);
    goal_.yaw -= rotDx * settings.rotateSpeed;
    goal_.pitch = std::clamp(goal_.pitch + rotDy * settings.rotateSpeed, settings.minPitch, settings.maxPitch);

    // exponential smoothing: identical feel at any frame rate
    float a = 1.0f - std::exp(-settings.smoothing * dt);
    cur_.target = cur_.target + (goal_.target - cur_.target) * a;
    cur_.distance += (goal_.distance - cur_.distance) * a;
    cur_.pitch += (goal_.pitch - cur_.pitch) * a;
    cur_.yaw += (goal_.yaw - cur_.yaw) * a;   // goal yaw is unwrapped, so 360-degree turns stay smooth
}

void Camera::clampTarget(float minX, float minZ, float maxX, float maxZ) {
    goal_.target.x = std::clamp(goal_.target.x, minX, maxX);
    goal_.target.z = std::clamp(goal_.target.z, minZ, maxZ);
}

void Camera::avoidObstacles(const std::function<float(float, float)>& heightAt, float clearance) {
    for (State* st : {&goal_, &cur_}) {
        for (int i = 0; i < 40; ++i) {
            float cp = std::cos(st->pitch), sp = std::sin(st->pitch);
            V3 e = st->target + V3{std::sin(st->yaw) * cp, sp, std::cos(st->yaw) * cp} * st->distance;
            // sample along the last part of the view ray too, so walls between eye and target do not cut the view
            bool blocked = false;
            for (float t = 0.0f; t <= 0.5f && !blocked; t += 0.1f) {
                V3 p = e + (st->target - e) * t;
                blocked = p.y < heightAt(p.x, p.z) + clearance;
            }
            if (!blocked || st->pitch >= settings.maxPitch) break;
            st->pitch = std::min(settings.maxPitch, st->pitch + 0.03f);
        }
    }
}

V3 Camera::eye() const {
    float cp = std::cos(cur_.pitch), sp = std::sin(cur_.pitch);
    V3 back{std::sin(cur_.yaw) * cp, sp, std::cos(cur_.yaw) * cp};
    return cur_.target + shake_ + back * cur_.distance;
}

M4 Camera::view() const { return lookAt(eye(), cur_.target + shake_, {0, 1, 0}); }

M4 Camera::proj(float aspect) const {
    float zn = std::max(0.5f, cur_.distance * 0.02f);
    return perspective(settings.fovY, aspect, zn, cur_.distance * 6.f + 600.f);
}

bool Camera::screenToGround(float sx, float sy, float w, float h, float planeY, V3& out) const {
    M4 vp = mul(proj(w / h), view()), inv;
    if (!invert(vp, inv)) return false;
    float nx = 2.f * sx / w - 1.f, ny = 1.f - 2.f * sy / h;
    auto unproject = [&](float z) {
        float v[4] = {nx, ny, z, 1};
        float r[4] = {0, 0, 0, 0};
        for (int i = 0; i < 4; ++i)
            for (int k = 0; k < 4; ++k) r[i] += inv(i, k) * v[k];
        return V3{r[0] / r[3], r[1] / r[3], r[2] / r[3]};
    };
    V3 a = unproject(0.f), b = unproject(1.f);
    V3 d = b - a;
    if (std::fabs(d.y) < 1e-6f) return false;
    float t = (planeY - a.y) / d.y;
    if (t < 0) return false;
    out = a + d * t;
    return true;
}

} // namespace ttz
