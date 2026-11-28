# Third-party notices

## Linked into the `ttz` executable

| Component | Version | License | Obligation for binary distribution |
|---|---|---|---|
| [SDL](https://github.com/libsdl-org/SDL) | 3.4.20 (`release-3.4.20`) | zlib | None required. Attribution appreciated; altered sources must be marked. |
| [Dear ImGui](https://github.com/ocornut/imgui) (core + `imgui_impl_sdl3`, `imgui_impl_sdlgpu3`) | v1.93.0 | MIT | Include the copyright and permission notice. |
| [cgltf](https://github.com/jkuhlmann/cgltf) | v1.15 | MIT (embeds jsmn, MIT) | Include the cgltf and jsmn notices. |
| [stb_image / stb_image_write](https://github.com/nothings/stb) | commit `6b5799b` | MIT or public domain (dual) | None under the public-domain option; we keep the notice below anyway. |
| [zstd](https://github.com/facebook/zstd) (decompressor only: `lib/common`, `lib/decompress`) | v1.5.7 | BSD-3-Clause (dual BSD / GPLv2; we use BSD) | Reproduce the copyright notice, conditions and disclaimer (below). |

All of these are fetched at configure time by CMake (`FetchContent`). Their full license texts end up in the build tree under `build/_deps/*-src/`. A shipping build must copy these license files next to the executable, or into an in-game credits/legal screen.

### MIT notice texts

- Dear ImGui: Copyright (c) 2014-2026 Omar Cornut.
- cgltf: Copyright (c) 2018-2021 Johannes Kuhlmann.
- jsmn: Copyright (c) 2010 Serge Zaitsev.
- stb: Copyright (c) 2017 Sean Barrett.

> Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions: The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

### BSD-3-Clause notice (zstd)

> Copyright (c) Meta Platforms, Inc. and affiliates. All rights reserved. Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met: * Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer. * Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution. * Neither the name Facebook, nor Meta, nor the names of its contributors may be used to endorse or promote products derived from this software without specific prior written permission. THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

The bake tools compress with Node.js's built-in zstd (`zlib.zstdCompressSync`, Node >= 22.15); nothing else is added.

### zlib notice (SDL)

> Copyright (C) 1997-2026 Sam Lantinga. This software is provided 'as-is', without any express or implied warranty. In no event will the authors be held liable for any damages arising from the use of this software. Permission is granted to anyone to use this software for any purpose, including commercial applications, and to alter it and redistribute it freely, subject to the following restrictions: 1. The origin of this software must not be misrepresented; you must not claim that you wrote the original software. If you use this software in a product, an acknowledgment in the product documentation would be appreciated but is not required. 2. Altered source versions must be plainly marked as such, and must not be misrepresented as being the original software. 3. This notice may not be removed or altered from any source distribution.

## Build tools only (not shipped)

These tools process our own shader sources offline; their output is not a derivative of the tools.

| Tool | License |
|---|---|
| glslangValidator (Khronos glslang) | BSD-3-Clause / Apache-2.0 and others (see the glslang repository) |
| [SDL_shadercross](https://github.com/libsdl-org/SDL_shadercross) CLI | zlib |
| SPIRV-Cross, SPIRV-Tools, SPIRV-Headers (vendored by shadercross) | Apache-2.0 / MIT-Khronos |

If a future build ships runtime shader translation (shadercross as a library), or DXC for D3D12, its licenses then apply to the binary: Apache-2.0 for SPIRV-Cross, and University of Illinois/NCSA for DXC, which requires attribution.

## Phase 3 additions

No new libraries are linked into the engine.

| Item | Use | License | Shipped |
|---|---|---|---|
| Node.js | runs `tools/convert_characters.mjs` and `tools/capture_lab.mjs` | MIT | no (build tool) |
| Playwright + Chromium | renders Zombie Lab reference images for visual comparison | Apache-2.0 / BSD-3 | no (dev tool) |
| Pillow | composes comparison sheets | MIT-CMU (HPND) | no (dev tool) |
| three.js r128 | loaded by the Zombie Lab design page (`assets/characters/source/zombie_lab_v3.html`) from a CDN | MIT | no (design tool only, never part of the game) |
| [meshoptimizer](https://github.com/zeux/meshoptimizer) 1.3 | evaluated, **not used** (see docs/RESEARCH.md) | MIT | no |

## Shader code adapted from third parties

| Component | Use | License | Obligation |
|---|---|---|---|
| [KinoBokeh](https://github.com/keijiro/KinoBokeh) (Keijiro Takahashi / Unity Technologies, `master`) | Miniature depth of field (`shaders/include/dof.glsl`, `shaders/post_dof_*.frag`, `shaders/post_composite.frag`): the structure (half-res prefilter with CoC-weighted downsample, disk-kernel gather with separate far / near fields where the far field takes the min of centre and sample CoC, post-filter, composite) and the prefilter / far-field weighting are adapted from its Unity shaders, rewritten in GLSL and extended (thin-lens CoC from the scene alpha, near-CoC tile max, CoC-scaled kernel, area-normalised near coverage, highlight boost, bilateral upsample). | MIT | Keep the notice below. |

> KinoBokeh: Copyright (C) 2016 Unity Technologies. Copyright (C) 2015 Keijiro Takahashi. Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions: The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

Techniques only (no code): scatter-as-gather near-field coverage and the CoC-scaled "fill" pass after Jorge Jimenez, *Next Generation Post Processing in Call of Duty: Advanced Warfare* (SIGGRAPH 2014).

## Research repositories (no code used)

The crowd-simulation repositories evaluated in [`docs/RESEARCH.md`](docs/RESEARCH.md) informed algorithm choices only. **No source code from them is included**, so they create no license obligations:

- iodiot/webgpu-crowd
- jsoulier/fluid_simulation
- daviskgit/continuum-crowd-simulation
- wayne-wu/webgpu-crowd-simulation
- gianmarcopicarella/crowd-simulation

## Assets

- `assets/models/zombie.glb` is generated by `tools/make_placeholder_zombie.py` (our code). It is original.
- `docs/reference/*` contains the art-direction reference images supplied by the project owner. They are not game assets and are not shipped.

## game-icons.net (UI preview icons)
Icons by Lorc, Delapouite and contributors, https://game-icons.net, licensed CC BY 3.0
(https://creativecommons.org/licenses/by/3.0/). Used in docs/ui_preview/icons.js (via @iconify-json/game-icons).
