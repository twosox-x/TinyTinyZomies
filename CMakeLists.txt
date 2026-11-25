cmake_minimum_required(VERSION 3.24)
project(TinyTinyZombies VERSION 0.1.0 LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
if(NOT CMAKE_BUILD_TYPE AND NOT CMAKE_CONFIGURATION_TYPES)
  set(CMAKE_BUILD_TYPE Release CACHE STRING "" FORCE)
endif()

option(TTZ_USE_SYSTEM_SDL "Use an installed SDL3 (find_package) instead of fetching it" OFF)

include(FetchContent)
set(FETCHCONTENT_QUIET OFF)

# ---- SDL3 (zlib) -------------------------------------------------------------
if(TTZ_USE_SYSTEM_SDL)
  find_package(SDL3 REQUIRED CONFIG)
else()
  set(SDL_SHARED OFF CACHE BOOL "" FORCE)
  set(SDL_STATIC ON CACHE BOOL "" FORCE)
  set(SDL_TEST_LIBRARY OFF CACHE BOOL "" FORCE)
  set(SDL_TESTS OFF CACHE BOOL "" FORCE)
  set(SDL_EXAMPLES OFF CACHE BOOL "" FORCE)
  FetchContent_Declare(SDL3
    GIT_REPOSITORY https://github.com/libsdl-org/SDL.git
    GIT_TAG release-3.4.20
    GIT_SHALLOW TRUE)
  FetchContent_MakeAvailable(SDL3)
endif()

# ---- Dear ImGui (MIT) ------------------------------------------------------------
FetchContent_Declare(imgui
  GIT_REPOSITORY https://github.com/ocornut/imgui.git
  GIT_TAG v1.93.0
  GIT_SHALLOW TRUE)
FetchContent_MakeAvailable(imgui)
add_library(imgui STATIC
  ${imgui_SOURCE_DIR}/imgui.cpp
  ${imgui_SOURCE_DIR}/imgui_draw.cpp
  ${imgui_SOURCE_DIR}/imgui_tables.cpp
  ${imgui_SOURCE_DIR}/imgui_widgets.cpp
  ${imgui_SOURCE_DIR}/imgui_demo.cpp
  ${imgui_SOURCE_DIR}/backends/imgui_impl_sdl3.cpp
  ${imgui_SOURCE_DIR}/backends/imgui_impl_sdlgpu3.cpp)
target_include_directories(imgui PUBLIC ${imgui_SOURCE_DIR} ${imgui_SOURCE_DIR}/backends)
target_link_libraries(imgui PUBLIC SDL3::SDL3)

# ---- cgltf (MIT, single header) + stb (MIT / public domain) --------------------------
FetchContent_Declare(cgltf
  GIT_REPOSITORY https://github.com/jkuhlmann/cgltf.git
  GIT_TAG v1.15
  GIT_SHALLOW TRUE)
FetchContent_MakeAvailable(cgltf)
FetchContent_Declare(stb
  GIT_REPOSITORY https://github.com/nothings/stb.git
  GIT_TAG 6b5799bae8a1fe3792691ef4b72ae26434c3e799)
FetchContent_MakeAvailable(stb)

# ---- engine ----------------------------------------------------------------------
add_executable(ttz
  src/main.cpp
  src/app/App.cpp
  src/app/Bench.cpp
  src/app/SelfTest.cpp
  src/gpu/GpuContext.cpp
  src/render/Camera.cpp
  src/render/Renderer.cpp
  src/assets/Model.cpp
  src/assets/ThirdPartyImpl.cpp
  src/sim/CrowdSim.cpp
  src/sim/Sandbox.cpp
  src/sim/SimParams.cpp
  src/debug/DebugUI.cpp
  src/debug/Profiler.cpp)
target_include_directories(ttz PRIVATE src ${cgltf_SOURCE_DIR} ${stb_SOURCE_DIR})
target_link_libraries(ttz PRIVATE SDL3::SDL3 imgui)
target_compile_definitions(ttz PRIVATE TTZ_SOURCE_DIR="${CMAKE_SOURCE_DIR}")
if(MSVC)
  target_compile_options(ttz PRIVATE /W4 /permissive-)
else()
  target_compile_options(ttz PRIVATE -Wall -Wextra -Wno-unused-parameter -Wno-missing-field-initializers)
endif()

# Runtime data next to the executable (pre-compiled shaders, assets, config).
add_custom_command(TARGET ttz POST_BUILD
  COMMAND ${CMAKE_COMMAND} -E copy_directory ${CMAKE_SOURCE_DIR}/shaders/compiled $<TARGET_FILE_DIR:ttz>/shaders
  COMMAND ${CMAKE_COMMAND} -E copy_directory ${CMAKE_SOURCE_DIR}/assets $<TARGET_FILE_DIR:ttz>/assets
  COMMAND ${CMAKE_COMMAND} -E copy_directory ${CMAKE_SOURCE_DIR}/config $<TARGET_FILE_DIR:ttz>/config)

# Optional: regenerate shaders from GLSL when the tools are available.
find_program(TTZ_GLSLANG glslangValidator)
find_program(TTZ_SHADERCROSS shadercross)
find_package(Python3 COMPONENTS Interpreter)
if(TTZ_GLSLANG AND TTZ_SHADERCROSS AND Python3_FOUND)
  add_custom_target(shaders
    COMMAND ${Python3_EXECUTABLE} ${CMAKE_SOURCE_DIR}/tools/compile_shaders.py
            --glslang ${TTZ_GLSLANG} --shadercross ${TTZ_SHADERCROSS}
    WORKING_DIRECTORY ${CMAKE_SOURCE_DIR}
    COMMENT "Compiling GLSL -> SPIR-V / MSL / JSON")
endif()

# Headless simulation self-test (no window, no renderer).
add_executable(ttz_selftest
  src/app/SelfTestMain.cpp
  src/app/SelfTest.cpp
  src/gpu/GpuContext.cpp
  src/sim/CrowdSim.cpp
  src/sim/Sandbox.cpp
  src/sim/SimParams.cpp)
target_include_directories(ttz_selftest PRIVATE src)
target_link_libraries(ttz_selftest PRIVATE SDL3::SDL3)
target_compile_definitions(ttz_selftest PRIVATE TTZ_SOURCE_DIR="${CMAKE_SOURCE_DIR}")

enable_testing()
add_test(NAME selftest COMMAND ttz_selftest)
