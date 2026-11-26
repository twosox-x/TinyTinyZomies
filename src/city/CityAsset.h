#pragma once
// Baked City Lab package (tools/city_lab/bake, format in tools/city_lab/bake/FORMAT.md):
//   city.json            bounds, 128 m tile grid, material palette, vehicle variants, roads, spawn points
//   tiles/<i>_<j>.bin    LOD0 / LOD1 meshes (int16 positions, int8 normals, u8 material), vehicle instances,
//                        0.5 m collision height grid (int16 cm + u8 flags)
//   vehicles.bin         vehicle variant meshes
// CityAsset owns the metadata and a background decode thread: tile files are read and decoded into
// GPU-ready CPU arrays off the main thread; GPU upload happens on the main thread (CityStreamer).
#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <deque>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

namespace ttz {

// GPU vertex (12 bytes), exactly the baked layout (FORMAT.md section 2): quantised position, vertex flags
// (bit 0 = body paint), normal * 127, material id.
struct CityVertex {
    int16_t x, y, z;
    uint16_t flags;
    int8_t nx, ny, nz;
    uint8_t mat;
};
static_assert(sizeof(CityVertex) == 12);

struct CityMesh {
    std::vector<CityVertex> verts;
    std::vector<uint32_t> idx;     // explicit indices; empty for implicit quad lists (drawn with the shared quad index buffer)
    uint32_t quads = 0, lod1Quads = 0;   // implicit quad list: quad count, leading quads drawn at LOD1
    float origin[3] = {0, 0, 0};   // world = origin + q * (scaleXZ, scaleY, scaleXZ)
    float scaleXZ = 1.f / 64.f, scaleY = 1.f / 32.f;
    float bmin[3] = {0, 0, 0}, bmax[3] = {0, 0, 0};   // world-space bounds
};

enum CityMatFlags : uint32_t { MAT_GLASS = 1, MAT_EMISSIVE = 2, MAT_WATER = 4, MAT_FOLIAGE = 8, MAT_PAINT = 16, MAT_SIGNAL = 32 };
// HGT0 cell flags
enum CityCellFlags : uint8_t { CELL_ROAD = 1, CELL_WALK = 2, CELL_BUILDING = 4, CELL_WATER = 8, CELL_VEG = 16, CELL_BLOCKED = 32,
                               CELL_VEHICLE = 64, CELL_OPEN = 128 };

enum EmissiveMode : uint32_t { EM_NONE = 0, EM_STEADY = 1, EM_WINDOWS = 2, EM_BLINK = 3, EM_FLASH = 4, EM_SIGNAL = 5 };

struct CityMaterial {
    float r = 0.5f, g = 0.5f, b = 0.5f;   // linear
    uint32_t flags = 0;                    // CityMatFlags
    uint32_t emissiveMode = EM_NONE;
    float emissiveNight = 0.f, emissiveDay = 0.f, roughness = 0.8f, gloss = 0.f;
    int dayMaterial = -1;                  // windows: the unlit-glass material drawn by day (-1 = itself)
    std::string name;
};

// Vehicle (kind 0) or prop (kind 1) instance; model -> world by quaternion q then translation.
struct CityInstance {
    float x, y, z;
    float q[4];                    // x, y, z, w
    float paint[4];                // linear rgb, w = 1 tint paint vertices (vehicles) / signal phase (props)
    uint16_t variant;
    uint16_t kind;
};

struct ModelVariant {
    std::string name;
    CityMesh lod0, lod1;           // model space; lod1 may be empty (use lod0)
};

// Sub-tile chunk of the tile mesh (CHNK, FORMAT.md 3): quads [first, first + n0) of LOD0, its LOD1 = [first, first + n1).
struct CityChunk {
    uint32_t first = 0, n1 = 0, n0 = 0;
    float bmin[3] = {0, 0, 0}, bmax[3] = {0, 0, 0};
};

struct TileCPU {
    int i = 0, j = 0;
    CityMesh lod[3];               // MESH (LOD0, LOD1 = its leading lod1Quads quads) / legacy MSH1 / LOD2 (far blocks)
    std::vector<CityChunk> chunks;          // empty: v1 tile (LOD1 = leading lod1Quads quads of LOD0)
    std::vector<CityInstance> instances;   // vehicles then props
    // collision / height grid
    int gw = 0, gh = 0;            // cells
    float gx0 = 0, gz0 = 0, gcell = 0.5f;
    std::vector<int16_t> heightCm;
    std::vector<uint8_t> flags;
    // WATR (optional): smooth water surface quads, 4 vertices per quad of (x, z, shore distance m), at waterLevel
    std::vector<float> water;
    float waterLevel = 0.f;
    // FOLI (optional): foliage instances (2 u32 each: x | z << 16 in 1/512 m from the tile corner; y mm (i16) | yaw << 16 |
    // scale << 24), sorted by chunk then type; foliStart[(chunk * foliTypes + type)] = first instance, + 1 entry
    std::vector<uint32_t> foliage, foliStart;
    uint32_t foliTypes = 0, foliChunks = 0;
    uint64_t fileBytes = 0, rawBytes = 0;  // stored / decompressed section bytes
    double decodeMs = 0;
    bool ok = false;
};

struct CitySpawn { float x, z, r; };

class CityAsset {
public:
    ~CityAsset() { stop(); }
    bool load(const std::string& dir);        // reads city.json + vehicles.bin (synchronous)
    bool loaded() const { return !dir_.empty(); }
    const std::string& dir() const { return dir_; }

    // world bounds and tile grid
    float x0 = 0, z0 = 0, x1 = 0, z1 = 0, tileSize = 128.f;
    int ni = 0, nj = 0;
    std::vector<uint8_t> tilePresent;          // ni*nj (1 if a tile file exists)
    std::vector<CityMaterial> materials;
    std::vector<ModelVariant> variants;        // vehicles
    std::vector<ModelVariant> props;           // street furniture
    std::vector<ModelVariant> foliage;         // instanced voxel foliage (foliage.bin: LOD0 F###, LOD1 G###)
    std::vector<float> foliageSway;            // wind sway weight per foliage type
    int lampProp = -1;                         // props index of street lamps (point lights), -1 if none
    std::vector<CitySpawn> spawns;
    std::vector<std::vector<float>> roads;     // polylines (x,z pairs)
    float collisionCell = 0.5f;

    // Synchronous decode (sim window setup, tests).
    bool decodeTileNow(int i, int j, TileCPU& out) const;

    // ---- background decode thread
    void start();
    void stop();
    void request(int i, int j);                // queue (deduplicated by caller)
    std::vector<std::pair<int, int>> cancelQueued();   // drop requests not yet started (returned)
    bool pop(TileCPU& out);                    // one decoded tile, if any
    size_t queued();

private:
    std::string tilePath(int i, int j) const;
    std::string dir_;
    std::thread thread_;
    std::mutex m_;
    std::condition_variable cv_;
    std::deque<std::pair<int, int>> queue_;
    std::deque<TileCPU> done_;
    std::atomic<bool> quit_{false};
    bool running_ = false;
};

// Decoders (CityAssetFormat.cpp), exposed for the synthetic test package.
bool decodeTileBytes(const std::vector<uint8_t>& bytes, TileCPU& out);
bool readFileBytes(const std::string& path, std::vector<uint8_t>& out);

} // namespace ttz
