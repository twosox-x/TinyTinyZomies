#pragma once
// Military funding (WS-D). GAME_DESIGN 2: one currency; income = base passive + territory passive (B2) + kill
// bonuses; one-time purchases, no upkeep. All values from BalanceConfig (UNAPPROVED).
// Every change goes through the ledger (tests and the UI's income rate read it).
#include "game/GameContext.h"
#include "game/GameEvents.h"

#include <array>
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
    // Kills the GPU ring could not hold (HordeInterface::killsOverflowed delta): counted and paid at the soldier rate
    // (anonymous, no seq), so rewards never silently drop.
    void creditAnonymousKills(uint64_t n, double time);
    void tick(GameContext& ctx);                     // passive income (continuous, credited per tick)
    double incomePerMinute() const;                  // passive + kill income averaged over the last 60 s
    double passivePerMinute() const;                 // base (+ territory in B2) rate
    double totalByKind(LedgerKind k) const { return byKind_[(size_t)k]; }
    double spentTotal() const { return -byKind_[(size_t)LedgerKind::Purchase]; }
    uint64_t kills() const { return kills_; }
    uint64_t killsByCause(KillCause c) const { return killsByCause_[(size_t)c]; }
    uint64_t duplicatesDropped() const { return dupes_; }
    double pendingPassive() const { return passiveAcc_ + territoryAcc_; }   // passive income of the current second (not yet a ledger entry)
    // B2: territory income rate (controlled area x rate, Territory::incomePerMin), credited per tick like base income
    // with its own ledger kind (one entry per second).
    void setTerritoryRate(double perMin) { territoryRate_ = perMin > 0 ? perMin : 0.0; }
    double territoryPerMinute() const { return territoryRate_; }
    const std::vector<LedgerEntry>& ledger() const { return ledger_; }
private:
    void add(double time, LedgerKind kind, double amount, const char* what);
    const BalanceConfig* cfg_ = nullptr;
    double funding_ = 0;
    uint64_t lastKillSeq_ = 0, kills_ = 0, dupes_ = 0;
    uint64_t killsByCause_[3] = {0, 0, 0};
    std::array<double, 6> byKind_{};
    std::vector<LedgerEntry> ledger_;   // passive income is aggregated into one entry per second
    double passiveAcc_ = 0, passiveAccT_ = 0, now_ = 0;
    double territoryRate_ = 0, territoryAcc_ = 0;
    // income-rate window: 60 one-second buckets of (passive + kill) income
    std::array<double, 60> bucket_{};
    int64_t bucketSec_ = 0;
    void addIncome(double time, double amount);
};

} // namespace ttz::game
