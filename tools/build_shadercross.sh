#!/usr/bin/env bash
# Builds the SDL_shadercross CLI (SPIR-V -> MSL / HLSL / JSON reflection) without DXC.
# Only needed when editing shaders: compiled outputs are committed in shaders/compiled/.
#   tools/build_shadercross.sh [install-dir]      (default: ./.tools)
# Requires: git, cmake, a C/C++ compiler. Also install glslang (brew install glslang /
# apt install glslang-tools / Vulkan SDK) for GLSL -> SPIR-V.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-$ROOT/.tools}"
WORK="$OUT/src"
mkdir -p "$WORK"
cd "$WORK"
[ -d SDL ] || git clone --depth 1 -b release-3.4.20 https://github.com/libsdl-org/SDL.git
[ -d SDL_shadercross ] || git clone --depth 1 https://github.com/libsdl-org/SDL_shadercross.git
cd SDL_shadercross
git submodule update --init --depth 1 external/SPIRV-Cross external/SPIRV-Headers external/SPIRV-Tools
# Upstream quirk (Nov 2026): the vendored build checks for the DXC submodule even with DXC off.
mkdir -p external/DirectXShaderCompiler
[ -f external/DirectXShaderCompiler/CMakeLists.txt ] || touch external/DirectXShaderCompiler/CMakeLists.txt
cd "$WORK"
cmake -S SDL -B sdl-build -DCMAKE_BUILD_TYPE=Release -DSDL_TESTS=OFF -DSDL_EXAMPLES=OFF -DCMAKE_INSTALL_PREFIX="$OUT/sdl"
cmake --build sdl-build -j 8 && cmake --install sdl-build
cmake -S SDL_shadercross -B sc-build -DCMAKE_BUILD_TYPE=Release -DSDLSHADERCROSS_DXC=OFF -DSDLSHADERCROSS_VENDORED=ON \
  -DSDLSHADERCROSS_SPIRVCROSS_SHARED=OFF -DSDLSHADERCROSS_SHARED=OFF -DSDLSHADERCROSS_STATIC=ON \
  -DSDLSHADERCROSS_INSTALL=OFF -DCMAKE_PREFIX_PATH="$OUT/sdl"
cmake --build sc-build -j 8 --target shadercross
mkdir -p "$OUT/bin" && cp sc-build/shadercross "$OUT/bin/"
echo "shadercross built: $OUT/bin/shadercross"
echo "compile shaders with: SHADERCROSS=$OUT/bin/shadercross python3 tools/compile_shaders.py"
