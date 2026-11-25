#include "assets/Model.h"

#include "cgltf.h"
#include "stb_image.h"

#include <SDL3/SDL.h>
#include <algorithm>
#include <cctype>
#include <cfloat>
#include <cmath>
#include <cstdlib>

namespace ttz {

int partIdFromName(const std::string& raw) {
    std::string n = raw;
    for (char& c : n) c = (char)std::tolower((unsigned char)c);
    auto has = [&](const char* s) { return n.find(s) != std::string::npos; };
    auto left = [&] { return has("left") || n.ends_with("_l") || n.ends_with(".l") || n.starts_with("l_"); };
    auto right = [&] { return has("right") || n.ends_with("_r") || n.ends_with(".r") || n.starts_with("r_"); };
    if (has("head") || has("skull")) return PART_HEAD;
    if (has("arm") || has("hand")) return right() ? PART_ARM_R : (left() ? PART_ARM_L : PART_ARM_L);
    if (has("leg") || has("foot")) return right() ? PART_LEG_R : (left() ? PART_LEG_L : PART_LEG_L);
    return PART_BODY;
}

bool Model::load(const std::string& path, float targetHeight) {
    cgltf_options opt{};
    cgltf_data* data = nullptr;
    if (cgltf_parse_file(&opt, path.c_str(), &data) != cgltf_result_success) {
        SDL_Log("glTF: cannot parse %s", path.c_str());
        return false;
    }
    if (cgltf_load_buffers(&opt, data, path.c_str()) != cgltf_result_success || cgltf_validate(data) != cgltf_result_success) {
        SDL_Log("glTF: invalid buffers in %s", path.c_str());
        cgltf_free(data);
        return false;
    }
    vertices.clear();
    indices.clear();
    float minY = FLT_MAX, maxY = -FLT_MAX;
    for (cgltf_size ni = 0; ni < data->nodes_count; ++ni) {
        cgltf_node* node = &data->nodes[ni];
        if (!node->mesh) continue;
        // part from this node's name, or the nearest named ancestor
        int part = PART_BODY;
        for (cgltf_node* p = node; p; p = p->parent) {
            if (p->name) { part = partIdFromName(p->name); if (part != PART_BODY || p == node) break; }
        }
        float world[16];
        cgltf_node_transform_world(node, world);
        float pivot[3] = {world[12], world[13], world[14]};
        for (cgltf_size pi = 0; pi < node->mesh->primitives_count; ++pi) {
            cgltf_primitive& prim = node->mesh->primitives[pi];
            if (prim.type != cgltf_primitive_type_triangles) continue;
            const cgltf_accessor *aPos = nullptr, *aNrm = nullptr, *aUv = nullptr;
            for (cgltf_size ai = 0; ai < prim.attributes_count; ++ai) {
                auto& at = prim.attributes[ai];
                if (at.type == cgltf_attribute_type_position) aPos = at.data;
                else if (at.type == cgltf_attribute_type_normal) aNrm = at.data;
                else if (at.type == cgltf_attribute_type_texcoord && at.index == 0) aUv = at.data;
            }
            if (!aPos) continue;
            uint32_t base = (uint32_t)vertices.size();
            for (cgltf_size v = 0; v < aPos->count; ++v) {
                float p[3] = {0, 0, 0}, nrm[3] = {0, 1, 0}, t[2] = {0.5f, 0.5f};
                cgltf_accessor_read_float(aPos, v, p, 3);
                if (aNrm) cgltf_accessor_read_float(aNrm, v, nrm, 3);
                if (aUv) cgltf_accessor_read_float(aUv, v, t, 2);
                ModelVertex mv{};
                for (int k = 0; k < 3; ++k) {
                    mv.pos[k] = world[k] * p[0] + world[4 + k] * p[1] + world[8 + k] * p[2] + world[12 + k];
                    mv.normal[k] = world[k] * nrm[0] + world[4 + k] * nrm[1] + world[8 + k] * nrm[2];
                    mv.pivot[k] = pivot[k];
                }
                float nl = std::sqrt(mv.normal[0] * mv.normal[0] + mv.normal[1] * mv.normal[1] + mv.normal[2] * mv.normal[2]);
                for (float& c : mv.normal) c /= std::max(nl, 1e-6f);
                mv.uv[0] = t[0];
                mv.uv[1] = t[1];
                mv.part = (float)part;
                minY = std::min(minY, mv.pos[1]);
                maxY = std::max(maxY, mv.pos[1]);
                vertices.push_back(mv);
            }
            if (prim.indices) {
                for (cgltf_size i = 0; i < prim.indices->count; ++i)
                    indices.push_back(base + (uint32_t)cgltf_accessor_read_index(prim.indices, i));
            } else {
                for (cgltf_size i = 0; i < aPos->count; ++i) indices.push_back(base + (uint32_t)i);
            }
        }
    }
    // base colour texture of the first textured material
    rgba = {255, 255, 255, 255};
    texW = texH = 1;
    for (cgltf_size mi = 0; mi < data->materials_count; ++mi) {
        cgltf_texture* tex = data->materials[mi].pbr_metallic_roughness.base_color_texture.texture;
        if (!tex || !tex->image) continue;
        cgltf_image* img = tex->image;
        int w, h, n;
        stbi_uc* px = nullptr;
        if (img->buffer_view) {
            const uint8_t* bytes = (const uint8_t*)img->buffer_view->buffer->data + img->buffer_view->offset;
            px = stbi_load_from_memory(bytes, (int)img->buffer_view->size, &w, &h, &n, 4);
        } else if (img->uri) {
            std::string dir = path.substr(0, path.find_last_of("/\\") + 1);
            px = stbi_load((dir + img->uri).c_str(), &w, &h, &n, 4);
        }
        if (px) {
            rgba.assign(px, px + (size_t)w * h * 4);
            texW = w;
            texH = h;
            stbi_image_free(px);
            break;
        }
    }
    variantRows = 1;
    if (data->json && data->extras.start_offset) {
        std::string extras(data->json + data->extras.start_offset, data->extras.end_offset - data->extras.start_offset);
        auto k = extras.find("ttz_variant_rows");
        if (k != std::string::npos) variantRows = std::max(1, std::atoi(extras.c_str() + extras.find(':', k) + 1));
    }
    cgltf_free(data);
    if (vertices.empty()) {
        SDL_Log("glTF: no triangle meshes in %s", path.c_str());
        return false;
    }
    // normalise: feet at y=0, requested height
    height = maxY - minY;
    float s = targetHeight > 0 && height > 0 ? targetHeight / height : 1.0f;
    for (auto& v : vertices) {
        v.pos[1] -= minY;
        v.pivot[1] -= minY;
        for (int k = 0; k < 3; ++k) { v.pos[k] *= s; v.pivot[k] *= s; }
    }
    height *= s;
    SDL_Log("loaded %s: %zu vertices, %zu indices, texture %dx%d, %d variant rows", path.c_str(), vertices.size(),
            indices.size(), texW, texH, variantRows);
    return true;
}

} // namespace ttz
