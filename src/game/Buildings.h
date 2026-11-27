#pragma once
// Building registry (Milestone B3, GAME_DESIGN 6 / 7 / 14b). SHARED HEADER between
//   B3a (CPU gameplay: selection, capture, roles Garrison / Hospital, garrison firing positions, hospital, barricades)
//   B3b (GPU vertical navigation for ZOMBIES: entrances, interiors, stairs, roof access, breaching barricades).
// Change by agreement only (docs/GAMEPLAY_ARCHITECTURE.md section 8). Plain data + CPU logic: no GPU, no SDL, no ImGui.
//
// Source of the static data: the optional BLDG section of each baked tile (tools/city_lab/bake/FORMAT.md 3, written by
// bake.js from the City Lab building jobs: one record per building the tile OWNS). Older packages without BLDG
// load no buildings (every building is "unsupported": GAME_DESIGN 14b requires the list of unsupported buildings).
//
// Frames: world metres, x / z ground, y up (FORMAT.md). A building's footprint is an oriented rectangle: corner O,
// unit axes e1 (along the street frontage) and e2 (into the lot, i.e. AWAY from the street), sizes w (along e1) and
// d (along e2). The front facade is the edge O .. O + e1 w and faces -e2 (the street). Local (u, v) = (dot(p - O, e1),
// dot(p - O, e2)), inside when 0 <= u <= w and 0 <= v <= d.
//
// Vertical model (PROPOSED, the 2D height grid has no interiors): floor f (0 = ground) has its walking level at
// y0 + f * floorHeight; the roof is at roofY (flat roofs; pitched house roofs: roofY = eave, roof not walkable). One
// stair core per building (local stairU / stairV) connects every floor and the roof hatch (RoofHatch opening).
// Zombies (B3b) move between floors only through the stair core; soldiers (B3a) are placed at firing positions
// (windows: floor level + standing at the window; roof edges: on roofY) and are visible there; the interior itself
// is never drawn.
#include "game/GameTypes.h"

#include <cstdint>
#include <functional>
#include <string>
#include <unordered_map>
#include <vector>

namespace ttz { struct TileCPU; }

namespace ttz::game {

struct BuildingConfig;

struct BuildingId {                  // index into BuildingRegistry::all() (stable for the session: never removed)
    uint32_t v = ~0u;
    bool valid() const { return v != ~0u; }
    bool operator==(const BuildingId& o) const { return v == o.v; }
    bool operator!=(const BuildingId& o) const { return v != o.v; }
};

// Approved roles only (GAME_DESIGN 6): Garrison (olive chevron flag), Hospital (green cross on white). No others.
enum class BuildingRole : uint8_t { None = 0, Garrison = 1, Hospital = 2 };
const char* roleName(BuildingRole r);

// Baked building kinds (city_arch job kinds). Support for garrison / hospital depends on the kind (see supported).
enum class BuildingKind : uint8_t { Unknown = 0, House = 1, Row = 2, Mid = 3, Tower = 4, Shop = 5, Other = 6 };
const char* kindName(BuildingKind k);

// Capture (PROPOSED, owner approval): Unclaimed -> (a squad stands at an entrance / inside with no zombie inside for
// BuildingConfig::captureTime s) -> Captured. Zombies inside (B3b counts) make it Contested (progress pauses; a
// captured building with zombies inside shows a warning but stays captured; the role keeps working at reduced value).
enum class CaptureState : uint8_t { Unclaimed = 0, Capturing = 1, Captured = 2, Contested = 3 };
const char* captureName(CaptureState s);

// Openings = doors (entrances on the ground floor), windows (upper floors, firing positions) and the roof hatch.
enum class OpeningType : uint8_t { Door = 0, Window = 1, RoofHatch = 2 };
// Approved barricade props (docs/MILITARY_ASSETS.md): barricade_{door|window}_{planks|plate|sandbags}.
enum class BarricadeType : uint8_t { None = 0, Planks = 1, Plate = 2, Sandbags = 3, Count };
const char* barricadeName(BarricadeType b);

constexpr uint8_t kRoofFloor = 0xFF;  // "floor" value of roof positions / the roof hatch

struct Opening {
    OpeningType type = OpeningType::Door;
    uint8_t floor = 0;               // 0 = ground; kRoofFloor for the roof hatch
    V3 pos;                          // world: centre of the opening at its sill / threshold height
    float nx = 0.f, nz = -1.f;       // outward facade normal (xz, unit); the roof hatch: (0, 0)
    float width = 1.2f, height = 2.1f;
    // --- barricade (written by B3a placement; B3b breach damage goes through BuildingRegistry::damageBarricade)
    BarricadeType barricade = BarricadeType::None;
    float barricadeHealth = 0.f;     // 0 = none / broken (open)
    float barricadeMax = 0.f;
    bool open() const { return barricade == BarricadeType::None || barricadeHealth <= 0.f; }
};

enum class FiringKind : uint8_t { Window = 0, RoofEdge = 1 };

struct FiringPosition {
    FiringKind kind = FiringKind::Window;
    uint8_t floor = 0;               // window floor (>= 1 normally; ground-floor windows of houses allowed), kRoofFloor
    uint16_t opening = 0xFFFF;       // index into Building::openings (windows), 0xFFFF for roof edges
    V3 pos;                          // world: where the soldier's feet are (window: inside, 0.45 m behind the facade)
    float yaw = 0.f;                 // facing out (rad, model +z turns to (sin yaw, 0, cos yaw))
    float arcHalf = 1.0f;            // half angle of the firing arc around yaw (rad): windows ~60 deg, roof edges ~80 deg
    SoldierId occupant;              // B3a: the garrison soldier assigned to it (invalid: free)
    bool nest = false;               // a fort_window_nest / fort_roof_ring is built at it (defence bonus)
};

struct Building {
    // ---- static (from BLDG)
    uint32_t bakeId = 0;             // tile index << 12 | record (unique per package)
    BuildingKind kind = BuildingKind::Unknown;
    uint8_t floors = 1;              // storeys above ground (>= 1)
    float floorHeight = 3.0f;        // m per storey
    float ox = 0, oz = 0;            // footprint corner O (world)
    float e1x = 1, e1z = 0;          // unit axis along the frontage
    float e2x = 0, e2z = 1;          // unit axis into the lot (away from the street)
    float w = 0, d = 0;              // footprint size along e1 / e2 (m)
    float y0 = 0;                    // ground floor level (street + kerb)
    float roofY = 0;                 // walkable roof level (flat roofs) or eave height (pitched)
    float topY = 0;                  // highest point (antennas, tanks)
    bool flatRoof = true;            // roof walkable (rooftop positions + roof hatch exist)
    float stairU = 0, stairV = 0;    // stair core (local frame): connects all floors and the roof hatch
    std::vector<Opening> openings;   // doors first (ground), then windows by floor, then the roof hatch (if flatRoof)
    std::vector<FiringPosition> firing;
    // ---- support (GAME_DESIGN 14b: unsupported buildings are documented)
    bool prepared = false;           // openings / firing positions derived (BuildingRegistry::prepare)
    bool supported = false;          // garrison / hospital possible
    const char* unsupportedWhy = ""; // reason when !supported ("tower: > 12 floors", "no entrance", ...)
    // ---- dynamic: B3a writes
    CaptureState capture = CaptureState::Unclaimed;
    float captureProgress = 0.f;     // 0..1
    BuildingRole role = BuildingRole::None;
    std::vector<SoldierId> garrison; // soldiers assigned to firing positions (entering or in place)
    std::vector<SoldierId> patients; // hospital: soldiers inside being treated
    int capacity = 0;                // garrison: firing positions used; hospital: beds (BuildingConfig)
    // ---- dynamic: B3b writes (zombies; -1 = unknown / not simulated)
    int zombiesInside = -1;          // all floors
    int zombiesOnRoof = -1;
    std::vector<int16_t> zombiesPerFloor;   // size floors (or empty)

    // helpers
    V3 centre() const { return {ox + e1x * w * 0.5f + e2x * d * 0.5f, y0, oz + e1z * w * 0.5f + e2z * d * 0.5f}; }
    void toLocal(float x, float z, float& u, float& v) const { u = (x - ox) * e1x + (z - oz) * e1z; v = (x - ox) * e2x + (z - oz) * e2z; }
    V3 toWorld(float u, float v, float y) const { return {ox + e1x * u + e2x * v, y, oz + e1z * u + e2z * v}; }
    bool contains(float x, float z, float margin = 0.f) const {
        float u, v; toLocal(x, z, u, v);
        return u >= -margin && u <= w + margin && v >= -margin && v <= d + margin;
    }
    float floorY(int f) const { return f == kRoofFloor ? roofY : y0 + f * floorHeight; }
    int floorAt(float y) const;      // floor whose level is the nearest at or below y (kRoofFloor on the roof)
    float area() const { return w * d; }
};

// Compact record for GPU upload (B3b): one per opening of every loaded building (16 B x 2).
struct OpeningGpu {
    float x, y, z;                   // world centre (threshold / sill)
    uint32_t building;               // BuildingId.v
    float nx, nz;                    // outward normal
    float health;                    // barricade health (<= 0: open / passable)
    uint32_t flags;                  // bits 0-1 type (Door / Window / RoofHatch), bits 8-15 floor, bit 16 barricaded
};

// Barricade damage report (B3b -> B3a: notices, rubble FX, noise).
struct BarricadeBroken { BuildingId building; uint16_t opening; BarricadeType type; V3 pos; };

class BuildingRegistry {
public:
    // ---- loading (B3a, CPU). Tiles are parsed once (BLDG section); buildings are never removed during a session.
    void addTile(const TileCPU& tile);           // idempotent per tile (i, j)
    bool hasTile(int i, int j) const { for (uint32_t t : tiles_) if (t == ((uint32_t)i | ((uint32_t)j << 16))) return true; return false; }
    // Derive openings / firing positions / support for buildings not prepared yet whose footprint lies inside the
    // height grid (heightAt returns the walkable / solid top at (x, z), NaN when unknown). B3a calls it after the
    // simulation window moved (GameWorld); B3b sees openings only for prepared buildings (Building::prepared).
    void prepare(const std::function<float(float, float)>& heightAt, const BuildingConfig& cfg);
    void clear();
    size_t size() const { return b_.size(); }
    const std::vector<Building>& all() const { return b_; }
    Building* get(BuildingId id) { return id.v < b_.size() ? &b_[id.v] : nullptr; }
    const Building* get(BuildingId id) const { return id.v < b_.size() ? &b_[id.v] : nullptr; }

    // ---- queries (uniform 16 m bucket grid; O(1) per call)
    BuildingId at(float x, float z, float margin = 0.f) const;          // the building whose footprint holds (x, z)
    BuildingId nearest(float x, float z, float maxDist, BuildingRole role = BuildingRole::None, bool supportedOnly = true) const;
    void inRect(float x0, float z0, float x1, float z1, std::vector<BuildingId>& out) const;
    int nearestEntrance(BuildingId id, float x, float z) const;         // opening index of the nearest Door, -1 none

    // ---- barricades (B3a places / repairs; B3b damages). version() increments on any change (GPU re-upload).
    bool setBarricade(BuildingId id, uint16_t opening, BarricadeType t, float health);
    // Applies breach damage; returns true when this call broke it (pushes a BarricadeBroken report).
    bool damageBarricade(BuildingId id, uint16_t opening, float damage);
    void takeBroken(std::vector<BarricadeBroken>& out) { out.insert(out.end(), broken_.begin(), broken_.end()); broken_.clear(); }
    uint64_t version() const { return version_; }

    // ---- zombie occupancy (B3b writes after its readback; B3a reads for capture / warnings)
    void setZombieCounts(BuildingId id, int inside, int onRoof, const int16_t* perFloor, int nFloors);

    // ---- GPU export (B3b): every opening of the loaded buildings, in building order; firstOpening[b] = first index
    void packOpenings(std::vector<OpeningGpu>& out, std::vector<uint32_t>& firstOpening) const;

    // ---- dynamic state written by B3a (exposed for B3b: soldiers inside / on the roof are attack targets)
    Building* mut(BuildingId id) { return get(id); }
    uint64_t loadedTiles() const { return tiles_.size(); }
    int supportedCount() const;

private:
    void bucketAdd(uint32_t idx);
    std::vector<Building> b_;
    std::vector<uint32_t> tiles_;                // (i | j << 16) of tiles already added
    std::unordered_map<uint64_t, std::vector<uint32_t>> grid_;   // 16 m buckets (every bucket a footprint touches)
    std::vector<BarricadeBroken> broken_;
    uint64_t version_ = 0;
};

// Parse the optional BLDG section of a tile (FORMAT.md 3): static records only (openings: doors; no windows yet).
bool parseBldg(const std::vector<uint8_t>& bytes, std::vector<Building>& out);

} // namespace ttz::game
