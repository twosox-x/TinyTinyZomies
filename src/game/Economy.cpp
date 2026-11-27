// Military funding (WS-D). Implemented (tiny, validates the kill-dedupe interface): funding, spend, kill credit.
#include "game/Economy.h"

#include "game/Config.h"

namespace ttz::game {

void Economy::reset(const BalanceConfig& cfg) {
    cfg_ = &cfg;
    funding_ = cfg.economy.startFunding;
    lastKillSeq_ = 0; kills_ = 0;
    killsByCause_[0] = killsByCause_[1] = killsByCause_[2] = 0;
    ledger_.clear();
    ledger_.push_back({0.0, LedgerKind::Start, funding_, "start"});
}

bool Economy::spend(double price, const char* what, double time) {
    if (price < 0 || funding_ < price) return false;
    funding_ -= price;
    ledger_.push_back({time, LedgerKind::Purchase, -price, what});
    return true;
}

void Economy::refund(double amount, const char* what, double time) {
    funding_ += amount;
    ledger_.push_back({time, LedgerKind::Refund, amount, what});
}

bool Economy::creditKill(const KillEvent& k, double time) {
    if (k.seq <= lastKillSeq_) return false;   // already credited (dedupe)
    lastKillSeq_ = k.seq;
    ++kills_;
    ++killsByCause_[(size_t)k.cause];
    const double r = cfg_ ? cfg_->economy.killReward[(size_t)k.cause] : 0.0;
    if (r != 0.0) { funding_ += r; ledger_.push_back({time, LedgerKind::KillReward, r, "kill"}); }
    return true;
}

void Economy::tick(GameContext& ctx) {}   // passive income: WS-D

double Economy::incomePerMinute() const { return cfg_ ? cfg_->economy.baseIncomePerMin : 0.0; }

} // namespace ttz::game
