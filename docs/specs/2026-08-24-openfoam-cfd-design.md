# dsh-cae v1.1 OpenFOAM CFD 设计规格

日期：2026-08-24 · 状态：已与发起人逐节确认

## 背景与定位

v1.0 交付了结构静力链（build123d → Gmsh → CalculiX → PyVista）。v1.1 在其旁增加平行的 CFD 链：稳态不可压缩内流（blockMesh → simpleFoam → foamToVTK），复用现有 runner、workdir、回执协议与 `cae_post_process`。本机已装 OpenFOAM 13（`/opt/openfoam13`），全部内核测试可本机真跑。

## 已确认决策

| # | 决策 | 结论 |
|---|---|---|
| 1 | 物理范围 | 稳态不可压缩内流（simpleFoam），层流；湍流进 v1.2 |
| 2 | 网格路径 | blockMesh 参数化（矩形管道）+ 完整 blockMeshDict 文本逃生口；snappyHexMesh+STL 进 v1.2 |
| 3 | 工具面 | 新增 `cae_cfd_mesh` + `cae_cfd_steady` 两个工具；后处理复用并小幅扩展 `cae_post_process` |
| 4 | 单位 | 几何参数 mm 输入，在 cfd_mesh 边界做唯一一次显式 mm→m 换算；链内全程 SI（m、m/s、Pa、Pa·s）。第二处显式换算：post 的 pressure 字段乘 `densityKgM3`（simpleFoam 输出运动压强 p/ρ） |
| 5 | case 组装 | 参数化模板 case + dict 顶层条目覆盖（`overrides` 类型化数组）；不引入 pyFoam 等第三方组装库 |
| 6 | OpenFOAM 环境 | 配置项 `openfoamBashrc`（默认自动探测 `$FOAM_BASHRC` → `/opt/openfoam*/etc/bashrc` → `/usr/lib/openfoam/*/etc/bashrc`，全部失败报错并列出尝试路径）；工具以 `bash -c "source <bashrc> && <utility>"` 调用 |

## 链路与工具契约

```
结构链:  cae_cad_build → cae_mesh_generate → cae_solve_static → cae_post_process
CFD 链:  cae_cfd_mesh ──────────→ cae_cfd_steady ──────────────→ cae_post_process
              blockMesh+checkMesh    simpleFoam+foamToVTK            （共用）
```

层间契约不变：领域知识全部在 `python/dsh_cae/cfd_*.py`；TS 层只做 schema/子进程/回执；两层仍只靠 argv + stdout 回执行 `<<<DSH_CAE_JSON>>>` 耦合。

### cae_cfd_mesh

- 参数：`lengthMm`/`widthMm`/`heightMm`（必填，流向 x，入口 x-min）、`cellSizeMm`（必填，各方向取整单元数）、`wallGrading`（默认 1，壁面法向 y/z 对称 simpleGrading 比值）、`blockMeshDict`（可选完整文本逃生口）、`name`（默认 `"duct"`）
- 执行：mm→m 唯一一次显式换算 → 生成 blockMeshDict → `blockMesh` → `checkMesh`
- 回执：`{ caseDir, blockMeshDictPath, boundsM: {min, max}, cells, maxNonOrthogonalityDeg, maxAspectRatio, checksPassed, checkMeshLogPath, logTail }`
- `checksPassed=false` 是域结果不是错误：模型读指标后自行决定加密或改用逃生口

### cae_cfd_steady

- 参数：`caseDir`（必填，cfd_mesh 回执的 caseDir）、`inletVelocityMS`（必填 [u,v,w]，m/s）、`kinematicViscosityM2S`（必填，m²/s）、`densityKgM3`（默认 1.0）、`iterations`（默认 2000，controlDict endTime）、`overrides`（可选 `{file, entry, dict}[]`，替换 case 内 dict 文件顶层条目；file 越界路径报错）、`case`（默认 `"run"`）
- 执行：写 `0/U`（入口 fixedValue、壁面 (0 0 0)、出口 zeroGradient）、`0/p`（出口 0、其余 zeroGradient）、`constant/transportProperties`（nu）→ 应用 overrides → `simpleFoam` → 解析日志收敛与残差 → `foamToVTK -latestTime`
- 回执：`{ caseDir, logPath, vtuPath: string | null, iterationsRun, converged, finalResiduals: {p, U}, wallMs, exitCode, logTail }`
- 不收敛是正常域结果（`converged:false` + 残差），供模型加迭代或经 overrides 改 fvSolution 的 SIMPLE 条目；只有基础设施失败（bashrc 探测失败、求解器缺失、超时）抛错

### cae_post_process 扩展

- 新字段：`velocity`（别名 `U`，速度模长标量，单位 m/s）、`pressure`（别名 `p`，单位 Pa）
- 新可选参数 `densityKgM3`（默认 1）：pressure 字段乘密度换算为 Pa，工具描述写明
- 绘图：structural 字段保持变形云图；velocity/pressure 出普通标量云图

## case 目录布局

```
<workdir>/cfd/<name>/
├── 0/{U, p}
├── constant/{transportProperties, turbulenceProperties(laminar), polyMesh/}
└── system/{blockMeshDict, fvSchemes, fvSolution, controlDict}
```

多算例靠 `name`/`case` 参数共存（与结构链同构）；`cae_cfd_steady` 的产物（log/VTK）写在同一 caseDir 内按 `case` 命名。

## 依赖自检

`deps.py` 增加 `--group structural|cfd`：structural 组查 build123d/gmsh/pyvista/ccx2paraview + ccx（现行为）；cfd 组查 bashrc 可 source 且 `blockMesh`/`simpleFoam`/`foamToVTK` 可用。TS 侧 cfd 工具调用 `ensureDeps('cfd')`，结构工具保持 `ensureDeps('structural')`，互不牵连。

## 测试与验收

- **验收算例**（方形截面层流管道，CFD 的悬臂梁）：Shah–London 精确常数 f·Re = 56.91。示例参数：20×20 mm 截面、L=1000 mm、水（ν=1e-6 m²/s、ρ=1000）、U=0.02 m/s → Re=400 层流。充分发展段理论 ΔP/L = 56.91·μ·U/D_h² ≈ 2.85 Pa/m（入口段 ≈ 0.05·Re·D_h = 0.4 m，取 x=0.5 与 x=0.9 m 两截面探针压差避开入口效应）
- **主断言**：ΔP/L 偏差 ≤5%；**副断言**：中心线 U_max/U_mean ≈ 2.10（方管表载值）≤10%
- pytest：`test_cfd_mesh.py`（生成、checkMesh 指标、mm→m 边界断言、坏 blockMeshDict 报错）、`test_cfd_steady.py`（粗网格收敛、overrides 机制、密度换算）、`test_cfd_pipeline.py`（Shah–London ±5% 验收）；缺 OpenFOAM 自动跳过
- TS：`tests/tools-cfd.test.ts`（两工具 schema/回执形状，fake stage 沿现有模式；deps 分组路由）；wiring 测试更新为 6 个工具
- 示例文档 `examples/duct-flow.md`：一句中文驱动全链

## CI

ubuntu-latest 从 dl.openfoam.org apt 仓库安装 OpenFOAM（包名实现时确定）；cfd pytest 缺 blockMesh 自动跳过——OpenFOAM 安装失败不拖垮结构链的绿。

## 布局增量与版本

```
python/dsh_cae/  + cfd_case.py（模板渲染共享：blockMeshDict 生成器 + case 骨架 + foam_run()）
                 + cfd_mesh.py / cfd_steady.py；deps.py(+--group)
src/             + tools/cfd-mesh.ts / cfd-steady.ts；config.ts(+openfoamBashrc)
pytest/          + test_cfd_{mesh,steady,pipeline}.py
tests/           + tools-cfd.test.ts
examples/        + duct-flow.md
README ×2        工具表加两行、单位段落补 CFD SI 约定、路线图调整
```

版本 0.1.0 → 0.2.0。Roadmap 移除 OpenFOAM 集成，新增 v1.2 候选：湍流 kOmegaSST+y+、snappyHexMesh+STL 任意几何、圆管 O-grid 模板、potentialFoam 初始化。

## 风险登记

| 风险 | 缓解 |
|---|---|
| OpenFOAM 版本差异（Foundation 13 vs ESI vNNN） | 只用长期稳定工具（blockMesh/simpleFoam/foamToVTK/checkMesh）与基础 dict 语法；cfd pytest 无环境自动跳过 |
| overrides 的 dict 条目替换实现脆弱 | 仅支持顶层条目精确替换：未找到条目即报错，不做模糊匹配；文件路径白名单校验 |
| simpleFoam 运动压强被误当 Pa 读 | 回执与工具描述显式标注运动压强；post 的 Pa 换算仅在提供 densityKgM3 时发生 |
| checkMesh 输出格式跨版本漂移 | 解析失败时 checksPassed=null 并保留原始 checkMeshLogPath，不猜 |
| CI 的 OpenFOAM apt 源变动 | cfd 门控跳过保证结构链独立绿；文档记录安装源 |
## 实测修正（2026-08-24，OpenFOAM 13 本机验证）

规划期探测本机 /opt/openfoam13 得出以下修正，实施以此为准：

1. Foundation OpenFOAM 13 移除了独立 `simpleFoam` 二进制：求解器为 `foamRun`，
   由 controlDict 的 `solver incompressibleFluid;` 选定（链路等价 simpleFoam）。
2. 物性文件是 `constant/physicalProperties`（`viscosityModel constant; nu ...;`）与
   `constant/momentumTransport`（层流 `simulationType laminar;`）——不是旧教程的
   transportProperties/turbulenceProperties。
3. OF13 的 `foamToVTK` 只输出 legacy `.vtk`（无 vtu 选项）：steady 回执字段为 `vtkPath`。
4. dict 的 `FoamFile` 头必须用教程式多行 banner；单行压缩形式会让 OF13 误报
   "Cannot find file"。
5. controlDict 令 `writeInterval = endTime`，保证最终迭代被写出供
   `foamToVTK -latestTime` 转换。
6. `cae_cfd_steady` 在回执中回显 `densityKgM3`（提示模型把同值传给 post 做 Pa 换算）。
7. `cae_post_process` 探针参数更名 `pointMm`→`point`，CFD 场的位置键为 `atM`（米）。

8. 验收理论值修正（实施期发现，Task 7）：Shah–London 56.91 是 Darcy 摩阻因子，
   ΔP/L = (f·Re)·μU/(2·Dh²) ≈ **1.42 Pa/m**，正文"≈ 2.85 Pa/m"漏了 Darcy 定义中的
   ½（截面加密与独立 Poisson 解均证实 1.42）。实测 1.360 Pa/m（−4.4%，±5% 门通过），
   Umax/Umean = 1.953（−7.0%，±10% 门通过）。验收 residualControl 取 p 1e-3 / U 1e-3
   （smoothSolver 的 Uy/Uz 初始残差在 ~7e-4 触底，1e-4 永不触发收敛判定）。
