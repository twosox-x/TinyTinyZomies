#pragma once
// Military funding (WS-D). GAME_DESIGN 2: one currency; income = base passive + territory passive (B2) + kill
// bonuses; one-time purchases, no upkeep. All values from BalanceConfig (UNAPPROVED).
// Every change goes through the ledger (tests and the UI's income rate read it).
#include "game/GameContext.h"
#include "game/GameEvents.h"

#include <string>
#include <vector>

namespace ttz::game {

enum class LedgerKind : uint8_t { Start, PassiveIncome, TerritoryIncome, KillReward, Purchase, Refund };

struct LedgerEntry { double time; LedgerKind kind; double amount; std::string what; };

class Economy {
public:
    void reset(const BalanceConfig& cfg);
    double funding() const { return funding_; }
    bool canAfford(double price) const { return funding_ >= price; }
    bool spend(double price, const char* what, double time);   // false (and nothing changes) when unaffordable
    void refund(double amount, const char* what, double time);
    // Kill reward with dedupe: a KillEvent whose seq <= the last credited seq is ignored (returns false).
    bool creditKill(const KillEvent& k, double time);
    void tick(GameContext& ctx);                     // passive income (continuous, credited per tick)
    double incomePerMinute() const;                  // passive + kill income averaged over the last 60 s
    uint64_t kills() const { return kills_; }
    uint64_t killsByCause(KillCause c) const { return killsByCause_[(size_t)c]; }
    const std::vector<LedgerEntry>& ledger() const { return ledger_; }
private:
    const BalanceConfig* cfg_ = nullptr;
    double funding_ = 0;
    uint64_t lastKillSeq_ = 0, kills_ = 0;
    uint64_t killsByCause_[3] = {0, 0, 0};
    std::vector<LedgerEntry> ledger_;   // passive income is aggregated into one entry per second
};

} // namespace ttz::game
