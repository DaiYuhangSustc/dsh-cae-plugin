# dsh-cae 设计规格

日期：2026-08-21 · 状态：已与发起人逐节确认

## 背景与定位

dsh-plugin 生态（GitHub topic，6,105 个仓库）中不存在任何 CAD 建模/网格划分/仿真/后处理插件；最接近的仅为 2D 设计类（open-design、openpencil）。dsh-cae 填补该空白：一个**树外 bundle**，让 DeepSeek Harness 的 agent 用自然语言驱动完整的工程仿真流程——CAD 建模 → 网格划分 → 求解 → 后处理。

不进 deepseek-harness 主仓库（领域插件不属于产品核心，且主仓库门禁按核心包设计）。

## 已确认决策

| # | 决策 | 结论 |
|---|---|---|
| 1 | 贡献形态 | 树外 bundle，独立仓库，`dsh plugin add` 安装 |
| 2 | 工具哲学 | 混合：阶段级工具，几何/物理特定部分以代码片段参数传入，外层（路径、超时、校验、报告）类型化 |
| 3 | 技术栈 | build123d + Gmsh + CalculiX + PyVista（结构静力学首发） |
| 4 | Python 桥接 | 一次性子进程 + 文件传状态（`python -m dsh_cae.<stage>`）；不用常驻边车、不用 e2b |

## 仓库布局

```
dsh-cae/
├── package.json            # dsh.bundle 清单；peerDep: cordis, dsh-tools
├── cordis.patch.yml        # 一行 insert：id: cae, name: dsh-cae
├── src/
│   ├── index.ts            # name / inject=['tools'] / Config / apply
│   ├── config.ts           # Schemastery 配置
│   ├── runner.ts           # 子进程执行器：进程组、超时、signal、日志落盘+截断
│   └── tools/              # cad.ts / mesh.ts / solve.ts / post.ts
├── python/dsh_cae/         # 插件自带 Python 包（源码直跑，无需安装）
│   ├── __init__.py
│   ├── cad.py  mesh.py  solve.py  post.py  deps.py
├── tests/                  # vitest（TS 侧）
├── pytest/                 # pytest（Python 侧，缺内核自动跳过）
└── README.md / README.zh.md
```

插件配置（无硬编码可调项）：

```ts
export const Config = Schema.object({
  python: Schema.string().default('python3')
    .description('装好 build123d/gmsh/pyvista/ccx2paraview 的解释器'),
  workdir: Schema.string().default('./cae'),
  stageTimeoutMs: Schema.number().default(600_000),
})
```

职责切分：TS 层只做工具 schema、子进程编排、输出契约（截断+落盘）、取消/超时；全部领域知识在 Python 侧。两层唯一耦合：命令行参数 + stdout 末行 `<<<DSH_CAE_JSON>>>` 分隔的 JSON 回执。

## 工具契约

### cae_cad_build

- 参数：`script: string`（build123d Python，须定义 `part`；可选 `NAMED_FACES = {"fixed": <面>, ...}`）、`name: string`（默认 `"part"`）
- 执行：受控 namespace 跑脚本 → 导出 `<name>.step`；对 NAMED_FACES 各面计算指纹（质心+法向+面积）写 `<name>.faces.json`
- 输出：`{ stepPath, volumeMm3, bboxMm: {min, max}, namedFaces: [{name, areaMm2, centroidMm}] }`
- 卡片：generic + `locations: [stepPath]`

### cae_mesh_generate

- 参数：`step: string`、`elementSizeMm: number`（默认 2.0）、`elementType: "tet4" | "tet10"`（默认 tet10）、`minSizeMm? / maxSizeMm?`
- 执行：Gmsh 导入 STEP → 按 sidecar 指纹匹配面、自动重建物理组 → 网格化 → `<name>.msh`
- 输出：`{ mshPath, nodeCount, elementCount, groupNames: string[], quality: {minJacobian} }`
- 卡片：generic + locations
- 可靠性依据：build123d 与 Gmsh 均为 OpenCASCADE 系内核，STEP 往返后同一面的质心/法向/面积在容差内不变；三元组组合在常规工程件上唯一性足够

### cae_solve_static

- 参数：`msh: string`、`material: {youngMPa, poisson}`、`constraints: [{groupName, kind: "fixed"}]`、`loads: [{groupName, vectorN: [fx,fy,fz]}]`、`case: string`（默认 `"case"`，决定产物文件名）、可选 `script: string`（追加 INP 片段：部分自由度约束、多工况逃生口）
- 执行：物理组 → `*NSET/*SURFACE` → `<case>.inp`（C3D10 + `*STATIC`）→ `ccx` → `.frd` 经 ccx2paraview 转 `.vtu`；完整日志落 `<case>.log`
- 输出：`{ inpPath, frdPath, vtuPath: string | null, exitCode, wallMs, logTail: string }`（logTail ≈ 末 40 行；vtu 转换失败时为 null，frd 仍可交 post 直接读）
- 卡片：terminal（title = ccx 命令行，raw = 日志）
- **非零退出/发散不是 isError**，而是携带 exitCode+logTail 的正常域结果，供模型诊断重试；仅基础设施失败（ccx 缺失、超时）throw

### cae_post_process

- 参数：`vtu: string`、`extracts: [{kind: "max" | "probe", field: "displacement" | "vonMises" | "stressXX" | …, pointMm?}]`、`plots: [{field, deformationScale?: "auto"}]`
- 执行：PyVista 读 VTU → 数值提取 + 变形云图 `<case>.png`
- 输出：`{ values: [{field, value, unit, atMm?}], plots: [{path, field}] }`
- 卡片：generic（数值表 + 图路径）

命名链路（悬臂梁验收场景）：

```
cae_cad_build     Box + NAMED_FACES={fixed:左端面, load:右端面}   → beam.step + beam.faces.json
cae_mesh_generate step=beam.step, elementSizeMm=2                → beam.msh (组: fixed, load)
cae_solve_static  E=210000/ν=0.3, fixed→fixed, load→(0,-100,0)   → case.inp→ccx→case.vtu
cae_post_process  max displacement / max vonMises + 云图          → 数值 + case.png
```

模型是编排者：产物路径显式传递，多案例靠 `name`/`case` 参数共存，无隐式状态。

## 错误处理与安全

- **依赖自检**：不在插件加载时启动子进程（非自包含，毁 profile 启动）；首次工具调用先快检（缓存结果），缺件 throw 并附精确安装命令（pip: build123d gmsh pyvista ccx2paraview；conda/apt: calculix）
- **超时/取消**：`stageTimeoutMs` 默认 10 min；进程组 + SIGTERM→SIGKILL；`exec.signal` 走同一回收路径
- **输出上限**：stdout/stderr 尾部截断（8 KB）进 canonical value；完整输出落 workdir `*.log` 并返回路径（对齐 dsh spill 哲学）
- **信任边界**：`script` 参数是模型生成代码在本机执行，信任级别等同 dsh 自带 bash 工具；README 明示，建议配合 profile 权限层（tools/pre-execute）治理；不在插件内做假安全

## 测试与验收

- **端到端验收**（需 DEEPSEEK_API_KEY）：悬臂梁自然语言会话驱动全部四工具，快照记录 transcript；工程可信度断言——仿真挠度对照理论解 δ=PL³/(3EI)，偏差 ≤5%
- **TS 单测**：runner（超时/取消/截断，fake python）、schema 校验、Config 默认值
- **Python pytest**：真实内核跑四阶段；ccx 缺失自动跳过（模仿 DEEPSEEK_API_KEY self-skip 模式）；指纹匹配稳定性
- **CI**：GitHub Actions，ubuntu-lts，pip 装四件套 + `apt install calculix-ccx`，全链路可跑

## 发布与路线图

- npm publish 预构建（tsdown + tsc types）；GitHub 安装路径写明 prepare + allowBuilds
- README 双语（生态惯例）：环境安装一行命令、信任边界、演示 GIF
- GitHub topics：`dsh-plugin` `deepseek-harness` `cae` `fea` `cad`；MIT License
- v1.1+：cae skill（教模型 build123d/INP 语法，渐进披露）、`ctx.jobs` 后台长算例、模态/热分析、OpenFOAM、多求解器 provider 化

## 风险登记

| 风险 | 缓解 |
|---|---|
| `@deepseek-ai/dsh-tools` 等包未发 npm | 开发期 link 本地 harness 检出（peerDep），发布期视官方发包情况调整 |
| Gmsh 面指纹匹配容差 | pytest 固定案例校准；失配时报出全部候选面指纹供模型改选 |
| PyVista 无头渲染需 EGL/OSMesa | README 指定 conda 安装路径（vtk 自带 osmesa）；pip 路径失败时报错说明 |
| CalculiX 安装差异 | 依赖自检探测 `ccx` 命令，缺失时按平台给出 apt/conda 命令 |
| FRD→VTU 转换器差异 | meshio 5.x 移除了 .frd 读取器，改用 ccx2paraview；转换失败时 frd 路径仍返回，post 会先把 frd 就地转成同名 .vtu 再读 |
