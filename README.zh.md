<div align="center">

<img src="assets/logo.svg" alt="Mochi" width="400">

# Mochi (dsh-cae)

[English](README.md) | **中文**

[![ci](https://github.com/DaiYuhangSustc/dsh-cae-plugin/actions/workflows/ci.yml/badge.svg)](https://github.com/DaiYuhangSustc/dsh-cae-plugin/actions/workflows/ci.yml)
[![MIT License](https://img.shields.io/github/license/DaiYuhangSustc/dsh-cae-plugin)](LICENSE)
![commit-activity](https://img.shields.io/github/commit-activity/m/DaiYuhangSustc/dsh-cae-plugin)
![last-commit](https://img.shields.io/github/last-commit/DaiYuhangSustc/dsh-cae-plugin)

**微信公众号** · 不定期推送插件使用文章

<img src="assets/qrcode.jpg" alt="微信公众号二维码" width="150">

</div>

DeepSeek Harness 的自然语言驱动 CAE 流水线：agent 接收一句自然语言的仿真请求，驱动完整的 CAD → 网格 → 求解 → 后处理链路，底层依托 build123d、Gmsh、CalculiX、OpenFOAM 与 PyVista。
六个工具覆盖全链路 —— 几何构建、四面体网格划分、线性静力求解、结果提取与绘图，外加一条并行 CFD 链路（blockMesh → 稳态不可压缩求解 → 后处理）处理内流请求 —— 每个阶段结束后将回执（路径、体积、网格质量、场极值）反馈给模型。

## 安装

先装 Python 栈：`pip install build123d gmsh pyvista ccx2paraview`，再装 CalculiX 求解器 —— Debian/Ubuntu 上 `sudo apt install calculix-ccx`，其他平台 `conda install -c conda-forge calculix`（`ccx` 必须在 PATH 上）。
CFD 链路需要安装 OpenFOAM（Foundation v11–13 或 ESI）；其 `etc/bashrc` 会被自动探测（`$FOAM_BASHRC`、`/opt/openfoam*`、`/usr/lib/openfoam*`），也可通过 `openfoamBashrc` 指定。
然后把插件装入 profile —— 在 DeepSeek Harness 检出里运行 `dsh`：

- 本地检出（插件开发）：`dsh plugin --profile web add /path/to/dsh-cae` —— 以 `link:` 依赖安装；改动插件后 `pnpm build` 并重启界面即可生效。
- 直接 git 检出：`dsh plugin --profile web add https://github.com/DaiYuhangSustc/dsh-cae-plugin.git`（git 安装会运行 `prepare` 构建脚本；pnpm 用户可能需要通过 `allowBuilds` 允许该构建步骤）。
- npm 源安装（发布后）：`dsh plugin --profile web add dsh-cae`。

每个 profile 各自维护插件列表 —— 换用其他 profile（如 `headless`）时对该 profile 重复 `add`。

## 启动使用

- 浏览器：`dsh web` 启动 Web 界面，地址 http://127.0.0.1:3080（`--port` 可改端口；默认自动打开浏览器）—— 打开后粘贴自然语言请求，即可看到工具调用与回执的流动。
- 终端：`dsh --profile headless "20×20 mm 方管、长 1 m、水、入口 0.02 m/s —— 稳态层流求解并出压力云图"` 无界面跑单个任务并输出完整记录。
插件装入前已启动的界面看不到它 —— `add` 之后（`link:` 安装则是重新 build 之后）需重启界面。

## 试一试

见 [examples/cantilever.md](examples/cantilever.md)：一句中文即可生成一端固定、端部受载的悬臂梁，在粗细两档网格上求解，输出 von Mises 云图并做网格无关性验证。
另见 [examples/duct-flow.md](examples/duct-flow.md)：一句中文即可生成层流管流解，并与 Shah–London 摩擦常数做验证。

## 六个工具

| 工具 | 输入 | 输出 |
| --- | --- | --- |
| `cae_cad_build` | build123d `script`（定义 `part`，可选 `NAMED_FACES`）+ `name` | `.step` 路径、体积、包围盒、命名面及其面积/质心 |
| `cae_mesh_generate` | `.step` 路径、`elementSizeMm`、`elementType`（`tet4`/`tet10`） | `.msh` 路径、节点/单元数、质量指标 |
| `cae_solve_static` | `.msh` 路径、材料（`youngMPa`、`poisson`）、命名面上的载荷/边界条件 | `.frd`/`.vtu` 路径、求解日志尾部、反力摘要 |
| `cae_post_process` | `.vtu`/`.frd` 路径、场/点/绘图查询 | 带位置的场极值、点值、云图 PNG 路径 |
| `cae_cfd_mesh` | 管道 `lengthMm`/`widthMm`/`heightMm`/`cellSizeMm`（+ `wallGrading`、完整 `blockMeshDict` 文本、`name`） | `caseDir`（SI 包围盒、单元数、checkMesh 质量、`checksPassed`） |
| `cae_cfd_steady` | `caseDir`、`inletVelocityMS`、`kinematicViscosityM2S`、`densityKgM3`、`iterations`、字典 `overrides` | 求解日志尾部、`converged` 与最终残差、VTK 路径 |

## 信任边界

`script` 参数是模型生成的 Python（及批处理文本），在本地执行，信任级别与 harness 自带的 bash 工具相同；请据此对待，并通过 profile 权限层（tools/pre-execute）进行治理。

## 单位

全程毫米、牛顿、兆帕：几何用 mm，力用 N，应力用 MPa，因此挠度输出为 mm，弹性模量按 MPa 输入（钢 ≈ 210000）。
CFD 链路在 `cae_cfd_mesh` 处按 mm 接收几何（一次性换算为 m），之后全程 SI：m、m/s、Pa、Pa·s；`cae_post_process` 在给定 `densityKgM3` 时把运动压力换算为 Pa。

## 配置

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `python` | `auto` | `'auto'` 自动探测名为 `dsh-cae` 的 conda 环境（`$CONDA_PREFIX`、`$CONDA_ENVS_PATH`、`~/.conda`、`~/miniconda3`、`~/anaconda3`、`~/mambaforge`、`/opt/conda`），找不到再回退 `python3`；也可显式指定解释器路径 |
| `workdir` | `./cae` | 工件目录（相对 agent cwd），存放 STEP/MSH/INP/FRD/VTU/PNG 文件 |
| `stageTimeoutMs` | `600000` | 每阶段墙钟预算（毫秒）；超时则终止阶段进程组 |
| `openfoamBashrc` | 自动探测 | OpenFOAM `etc/bashrc` 路径；自动探测检查 `$FOAM_BASHRC`、`/opt/openfoam*/etc/bashrc`、`/usr/lib/openfoam/*/etc/bashrc` |

## 故障排查

若 `import build123d` 报 `pyexpat ... undefined symbol: XML_SetAllocTrackerActivationThreshold`，是被继承的 `LD_LIBRARY_PATH`（如 OpenFOAM 的 bashrc 把 `/usr/lib` 目录排在了前面）遮蔽了解释器自带的更新版 libexpat。对 conda 风格解释器（`python: auto` 或显式 env 路径），runner 在 spawn 时已自动把该环境的 `lib` 前置到 `LD_LIBRARY_PATH`、`bin` 前置到 `PATH`；其他布局请自行 `LD_PRELOAD=$CONDA_PREFIX/lib/libexpat.so.1` 强制优先加载新版。
无显示器的 Linux 服务器需要 EGL 或 OSMesa 才能进行 PyVista 渲染 —— 推荐使用 conda 的 vtk，其构建支持 OSMesa：`conda install -c conda-forge vtk osmesa`；CI 设置 `PYVISTA_OFF_SCREEN=true`，此时 vtk 无需 X 即可离屏渲染。
OpenFOAM 11+（Foundation）移除了独立求解器可执行文件：本插件运行 `foamRun`（`solver incompressibleFluid`），即 simpleFoam 的后继者；ESI 版本仍保留 `simpleFoam`，但此处调用的名称是 Foundation 的。`foamToVTK` 输出传统 `.vtk`，`cae_post_process` 直接读取。

## 限制

结构：仅线性静力分析、仅四面体网格；CFD：仅稳态不可压缩层流内流、仅六面体块网格；仅 POSIX；单机。

## 路线图

面向提示引导的 CAE skill、经 `ctx.jobs` 的后台任务、模态/热分析、湍流（kOmegaSST + y+ 处理）、snappyHexMesh/STL 几何、可插拔求解器提供方。

## 贡献指南

欢迎 PR 和 issue —— 自然语言 CAE 栈覆盖面很广，需要大家一起合作：更多物理场、更多求解器、更好的示例与文档。

开发环境（TS 侧）：`pnpm install`。
注意：`@deepseek-ai/dsh-tools` 处于 rc.1，其运行时导入链会拉入 `dsh-llm`/`dsh-scope`/`dsh-session`/`dsh-timeout`；以 out-of-tree 方式装进 profile 时，解析通常来自 profile 内的 `dsh-base`。
独立开发检出场景下，`pnpm install` 需要 `autoInstallPeers: false`（已写入 pnpm-workspace.yaml）加上已声明的额外 devDeps —— 若 peer 仍无法解析，请改为在 dsh profile 内安装，而非独立安装。

内核环境，无需 sudo（本仓库本地做 CI 等效验证所用的路线）：

```sh
conda create -n dsh-cae -c conda-forge python=3.11 calculix -y
conda run -n dsh-cae python -m ensurepip --upgrade
conda run -n dsh-cae pip install build123d gmsh pyvista ccx2paraview pytest
```

环境名就是关键：默认的 `python: auto` 探测的正是名为 `dsh-cae` 的 conda 环境，因此建好后无需任何额外配置。

按改动所属的层选跑对应测试：

| 层 | 命令 | 说明 |
| --- | --- | --- |
| TS 工具 / runner | `pnpm build && pnpm vitest run` | 无密钥，任何机器可跑 |
| Python 阶段 | `pytest pytest -v` | 在内核环境内运行；`pytest/` 目录会遮蔽 `pytest` 包名，必须用控制台脚本，绝不能在仓库根目录 `python -m pytest` |
| Loader 组合 | `DSH_COMPOSITION=1 pnpm vitest run tests/composition.e2e.ts` | 需要一份 dsh harness 检出；自愿开启，CI 不门控 |

所有改动必须守住的契约：

- TS 层只做编排（工具 schema、子进程、超时、回执）；全部领域知识在 `python/dsh_cae/`。两层只通过 argv 和 stdout 回执行 `<<<DSH_CAE_JSON>>>` 耦合 —— 不许有别的通道。
- 求解结果是数据：ccx 非零退出是携带 `exitCode` 与 `logTail` 的正常回执，供模型诊断；只有基础设施失败（缺二进制、超时、输出不可解析）才抛错。
- 全程单位 mm/N/MPa，任何地方不做换算。
- 若干求解器特性是刻意编码并加了注释的：Gmsh tet10 的第 9/10 中间节点在 `solve.py` 里对 Abaqus C3D10 做了交换；ccx 对奇异（无约束）系统也退出 0，因此域失败测试用指向不存在节点的 `*CLOAD` 驱动 ccx。

对 PR 的期望：覆盖你改动层面的测试保持绿色；内核测试在无内核环境自动跳过 —— 在 PR 里说明这一点，让 CI 真跑；`README.md` 与 `README.zh.md` 同步更新（两份文件互为镜像）；提交说明遵循约定式前缀（`feat:`、`fix:`、`docs:`、`test:`）。

适合上手的目标即上面的路线图：新增分析类型（`*FREQUENCY`、`*HEAT TRANSFER`）、在 CFD 链路上扩展湍流与 snappyHexMesh、教模型 build123d/INP 习惯用法的 cae skill、以及更多 `examples/cantilever.md` 风格的可运行示例。

## 许可证

MIT
