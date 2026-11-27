// Military funding (WS-D): funding, ledger, passive income, kill rewards with seq dedupe (GAME_DESIGN 2, 14b).
#include "game/Economy.h"

#include "game/Config.h"

#include <cmath>

namespace ttz::game {

void Economy::reset(const BalanceConfig& cfg) {
    cfg_ = &cfg;
    funding_ = cfg.economy.startFunding;
    lastKillSeq_ = 0; kills_ = 0; dupes_ = 0;
    killsByCause_[0] = killsByCause_[1] = killsByCause_[2] = 0;
    byKind_.fill(0.0);
    ledger_.clear();
    passiveAcc_ = passiveAccT_ = now_ = 0;
    territoryRate_ = territoryAcc_ = 0;
    bucket_.fill(0.0);
    bucketSec_ = 0;
    add(0.0, LedgerKind::Start, funding_, "start");
}

void Economy::add(double time, LedgerKind kind, double amount, const char* what) {
    ledger_.push_back({time, kind, amount, what});
    byKind_[(size_t)kind] += amount;
}

void Economy::addIncome(double time, double amount) {
    const int64_t sec = (int64_t)std::floor(time);
    if (sec > bucketSec_) {   // advance the ring, clearing the seconds skipped
        for (int64_t s = bucketSec_ + 1; s <= sec && s <= bucketSec_ + 60; ++s) bucket_[(size_t)(s % 60)] = 0.0;
        bucketSec_ = sec;
    }
    if (sec > bucketSec_ - 60) bucket_[(size_t)((sec % 60 + 60) % 60)] += amount;
}

bool Economy::spend(double price, const char* what, double time) {
    if (!(price >= 0) || funding_ < price) return false;
    funding_ -= price;
    add(time, LedgerKind::Purchase, -price, what);
    return true;
}

void Economy::refund(double amount, const char* what, double time) {
    funding_ += amount;
    add(time, LedgerKind::Refund, amount, what);
}

bool Economy::creditKill(const KillEvent& k, double time) {
    if (k.seq <= lastKillSeq_) { ++dupes_; return false; }   // already credited (dedupe)
    lastKillSeq_ = k.seq;
    ++kills_;
    const size_t c = (size_t)k.cause < 3 ? (size_t)k.cause : 2;
    ++killsByCause_[c];
    const double r = cfg_ ? cfg_->economy.killReward[c] : 0.0;
    if (r != 0.0) { funding_ += r; add(time, LedgerKind::KillReward, r, c == 0 ? "kill" : c == 1 ? "kill (explosion)" : "kill (other)"); addIncome(time, r); }
    return true;
}

void Economy::creditAnonymousKills(uint64_t n, double time) {
    if (!n) return;
    kills_ += n;
    killsByCause_[2] += n;
    const double r = (cfg_ ? cfg_->economy.killReward[0] : 0.0) * (double)n;
    if (r != 0.0) { funding_ += r; add(time, LedgerKind::KillReward, r, "kills (ring overflow)"); addIncome(time, r); }
}

double Economy::passivePerMinute() const {
    if (!cfg_) return 0.0;
    return cfg_->economy.baseIncomePerMin + territoryRate_;   // base + territory (B2: controlled area x rate)
}

void Economy::tick(GameContext& ctx) {
    now_ = ctx.time + ctx.dt;
    const double base = (cfg_ ? cfg_->economy.baseIncomePerMin : 0.0) / 60.0 * ctx.dt, terr = territoryRate_ / 60.0 * ctx.dt;
    const double amount = base + terr;
    funding_ += amount;
    passiveAcc_ += base;
    territoryAcc_ += terr;
    passiveAccT_ += ctx.dt;
    addIncome(ctx.time, amount);
    if (passiveAccT_ >= 1.0 - 1e-9) {   // one ledger entry per second of passive income
        add(ctx.time, LedgerKind::PassiveIncome, passiveAcc_, "base income");
        if (territoryAcc_ > 0) add(ctx.time, LedgerKind::TerritoryIncome, territoryAcc_, "territory income");
        passiveAcc_ = 0; passiveAccT_ = 0; territoryAcc_ = 0;
    }
}

double Economy::incomePerMinute() const {
    // passive rate (exact) + kill rewards over the last 60 s (or the time elapsed, whichever is shorter)
    double kill = 0;
    const double window = std::min(60.0, std::max(1.0, now_));
    double sum = 0;
    for (double b : bucket_) sum += b;
    const double passiveInWindow = passivePerMinute() / 60.0 * window;
    kill = std::max(0.0, sum - passiveInWindow);
    return passivePerMinute() + kill * 60.0 / window;
}

} // namespace ttz::game
