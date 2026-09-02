# 六阶段工作流对齐设计（dsh-cae v0.4.0）

日期：2026-09-02
状态：已与维护者逐节确认

## 背景与目标

对照标准 Fluent 六阶段 CFD 工作流（前处理 → 求解器设置 → 求解计算 → 后处理 → 结果验证 → 模型验证）审查现有 6 个工具：

| 阶段 | 现状 |
| --- | --- |
| 1 前处理 | ✅ 脚本生几何 + 网格；❌ 无外部 STEP 导入校验、无脏几何修复 |
| 2 求解器设置 | ⚠️ 与求解合并；物理模型写死稳态不可压层流 |
| 3 求解计算 | ✅ ccx / foamRun |
| 4 后处理 | ✅ cae_post_process |
| 5 结果验证 | ⚠️ 收敛数据有回传；❌ 网格无关性无自动化 |
| 6 模型验证 | ❌ 无，且**明确决定不做**（人为判断，插件只提供数据） |

本设计补齐阶段 1 的外部几何入口、阶段 2/3 的瞬态分支、阶段 5 的网格无关性自动化。工具从 6 个变 9 个：

```
结构: [cae_step_import →] cae_cad_build → cae_mesh_generate → cae_solve_static → cae_post_process
                                                          └──────────── cae_verify_mesh（阶段5，横跨）
CFD:  cae_cfd_mesh → cae_cfd_steady | cae_cfd_transient → cae_post_process
                              └──────────── cae_verify_mesh（阶段5，横跨）
```

## 已确认的决策

| 决策点 | 选择 |
| --- | --- |
| STEP 导入形态 | 独立工具 `cae_step_import`：校验 + 可选修复 + 面清单回传；mesh 工具保持纯消费 STEP |
| 外部几何的 BC 锚点 | 面清单 → AI 命名 → 二次调用传 `nameFaces` → 写出 cad.py 同格式 faces.json 指纹 sidecar；mesh.py/solve.py Python 零改动 |
| 瞬态形态 | 新工具 `cae_cfd_transient`，保留 `cae_cfd_steady` 不动；稳态/瞬态推荐语义写在两个工具描述里互指，代码不藏策略 |
| 网格无关性 | 纯 TS 宏工具 `cae_verify_mesh`，`chain: structural\|cfd` 双链覆盖；GCI 数学独立成 `src/gci.ts` 纯函数 |
| 模型验证 | 丢弃，README 写明边界（人为判断） |
| 依赖 | 零新依赖：OCP 随 build123d 已在镜像、GCI 是纯 TS、OpenFOAM 瞬态能力现有安装已有；Dockerfile 不动 |
| 版本 | v0.4.0 |

## F1 `cae_step_import`（前处理：外部几何入口）

**Python** `python/dsh_cae/step_import.py`，deps 组 `structural`（build123d/OCP）。

### 校验（不修复也全跑）

receipt 回传 `clean: true/false` + 问题清单，AI 自己决定要不要修。检查项：

- 实体数：0 实体 → **fail loud**（致命三例外之一）
- 每个 solid 过 `BRepCheck_Analyzer`，无效则列出
- 自由边（缝合缺口）、非流形边：计数 + 明细
- 小面：面积 < `sliverAreaRatio`（默认 1e-4）× 最大面面积 → 报 `{id, areaMm2}`
- 短边：长度 < `shortEdgeRatio`（默认 1e-3）× 包围盒对角线 → 报计数 + 最短长度
- 两个比例阈值是 python 内部默认，不在 TS 工具上暴露参数（YAGNI；需要时经后续版本加）

### 修复（`--repair`）

`ShapeFix_Shape`（缝合 + 面/壳/线修复）+ `ShapeUpgrade_UnifySameDomain`（合并共面碎块）。receipt 记录修了什么：缝合面数、合并面数、修复前后各检查项计数对比。

### 面清单与命名

- 全部面 `{id, areaMm2, centroidMm, normal}`；id = TopExp 遍历序，同文件同参数确定性可复现；单位 mm
- `--name-faces`（JSON `[{faceId, name}]`）：校验 id 存在、名字唯一，**从输出几何（修复后）算指纹**写出 `<stem>.faces.json` —— 与 cad.py 完全同格式（`{name: [{centroidMm, areaMm2, normal}]}`），mesh.py 的质心+面积指纹重建机制原样消费
- 描述写明推荐流程：先看清单 → 再命名；命名调用应带与首次检查相同的 repair 设置

### 致命错误（仅三种）

文件不存在/不可读、无实体、`nameFaces` 引用不存在的 id。其余问题一律"报告不拦截"。

**TS** `src/tools/step-import.ts`：参数 `step`(必)、`repair`、`nameFaces`、`facesJson`（sidecar 出路）。

## F2 `cae_cfd_transient`（阶段 2/3：瞬态分支）

**Python** `python/dsh_cae/cfd_transient.py`（薄壳，镜像 cfd_steady.py 结构），`cfd_case.py` 新增：

- `FV_SCHEMES_TRANSIENT`：`ddtSchemes default Euler`（层流内流够用；`backward` 可经 overrides 换）
- `FV_SOLUTION_TRANSIENT`：PIMPLE 块（momentumPredictor yes、nCorrectors 2、nNonOrthogonalCorrectors 1），p/U 求解器沿用 steady 的 GAMG/smoothSolver
- `write_control_dict_transient(...)`：**真实物理时间** —— `endTime` 秒、`adjustTimeStep yes` + `maxCo` + `maxDeltaT`（内部默认 = writeIntervalS，不单独暴露参数）、`writeControl adjustableRunTime`、`writeInterval` 秒、`purgeWrite 0`（保历史供复查）

流程同 steady：定位 bashrc → 重写 0/U、0/p、nu → 写瞬态三件套 → `foamRun` → 解析日志（Time 行为真秒、`Courant Number` 行取 max）→ `foamToVTK` 最终时刻。

Receipt：`{caseDir, timeStepsRun, simTimeS, endTimeS, maxCourantSeen, finalResiduals, vtkPath, exitCode, logTail}`。

**TS** `src/tools/cfd-transient.ts`：`caseDir`(必，来自 cae_cfd_mesh)、`inletVelocityMS`、`kinematicViscosityM2S`、`endTimeS`、`maxCourant`（默认 0.5）、`deltaTS`（给了就固定步长、关自适应）、`writeIntervalS`（默认 endTimeS/10）、`densityKgM3`（回传给 post 换 Pa）、`overrides`（与 steady 同一白名单）。

**推荐语义**（"AI 可推荐、用户拍板"）落在两个工具描述互指：稳态 = 只关心充分发展后的平均量、便宜；瞬态 = 启动过程、旋涡脱落、时间历史重要。

## F3 `cae_verify_mesh`（阶段 5：网格无关性自动化）

**纯 TS 宏工具** `src/tools/verify-mesh.ts`；GCI 数学独立 `src/gci.ts` 纯函数（无求解器可单测）。无新 python stage，复用现有五个 stage。

### 参数

- `chain: structural | cfd`
- 结构链：`step`、`facesJson`、`material {youngMPa, poisson}`、`fixedGroups`、`loads [{group, forceN}]`、`elementSizesMm[]`、`metric: maxVonMises(默认) | maxDisplacement`
- CFD 链：duct 四参 + `wallGrading`、`cellSizesMm[]`、`inletVelocityMS`、`kinematicViscosityM2S`、`metric: maxVelocityMS(默认) | pressureDropPa`（进出口中心 probe p 相减 × 密度）、`densityKgM3`
- 公共：`gciThresholdPercent`（默认 3）
- 尺寸数组 **≥3 档强制**（GCI 需要），fail loud

### 流程

每档循环：mesh（或 cfd_mesh）→ solve（或 cfd_steady）→ post 提指标 → 收集 `{size, count, metricValue}`。任一档失败 → fail loud（带档位编号 + logTail，不留半截结论）。各档产物落 `<workdir>/verify/<i>/`（CFD case 落 `cfd/verify-<i>/`），不污染主链工件。

### 数学（Celik 2008 标准流程）

- 细化比 r 用**单元数立方根**（两链通用：结构 tet 网格、CFD hex 网格统一按 count^(1/3)）
- 迭代解观察阶数 p
- 细网 `GCI_fine = 1.25·|φ1−φ2| / (|φ1|·(r21^p−1)) × 100%`
- φ 不单调（振荡收敛）→ `convergenceState: oscillatory`，GCI 不可靠，`meshIndependent: false` 并解释

### Receipt

`levels[]` 表格（size、count、metricValue）、`observedOrder`、`gciFinePercent`、`gciCoarsePercent`、`convergenceState`、`meshIndependent`（≤阈值）、`thresholdPercent`、`recommendation`（人话：哪档已够、再细是浪费）。

描述明示：**这是最贵的工具**，跑 N 档完整网格+求解。

## 模型验证（阶段 6）：明确丢弃

README/README.zh 工作流表加一行：阶段 6 是人为判断，插件提供数据（receipt 数字 + 云图），不做自动对比。

## 测试

- `pytest/test_step_import.py`：干净 STEP → `clean: true`；脏 STEP（build123d 造共面碎缝几何）→ 检出 + 修复 + 计数变化；nameFaces → sidecar 被 mesh.py 指纹端到端消费（import→name→mesh→物理组出现）；坏 id / 无实体 / 文件不存在 → fail loud
- `pytest/test_cfd_transient.py`：沿用 OpenFOAM 缺失自跳过模式；小 duct 跑 0.05s，断言 `timeStepsRun > 0`、`simTimeS ≈ endTimeS`、vtk 存在；Courant/时间解析做纯函数单测（喂日志文本）
- `tests/verify-mesh.test.ts`：mock runStage（照 tools-cfd.test.ts 模式）验证循环次序/每档参数/失败传播；`src/gci.ts` 纯单测 —— 造 `φ = φ_exact + C·h^p` 解析序列验证 p 与 GCI 收回、振荡序列判别
- 三个新工具照搬现有 receipt 契约测试模式

## 文档与发布

- README/README.zh：工具表 + 六阶段映射表更新（含"阶段 6 人工"说明）
- Dockerfile 不动；v0.4.0 tag 重出镜像（CI 门禁层自动跑全套 pytest）

## 落地修订 (2026-09-02)

实现与终审阶段相对本设计稿的收窄与增补，记录在案：

1. **F1 自由边/非流形检查简化**：以布尔 `freeEdges` 回传（无逐边明细、无独立的非流形边检查项）——修复决策只需要"有没有"，布尔足够。
2. **F1 `repairedDelta` 收窄**：只回传 `facesBefore/facesAfter/mergeableFacesRemaining` 三项，而非修复前后全部检查项计数对比。
3. **F2 新增校验**：`endTimeS / writeIntervalS` 必须整除（TS 工具层 fail loud）——foamRun 对非整除的 endTime 会过冲且永不写出最终时刻，后处理会拿到偏早的状态。
4. **F3 新增校验**：按链限制 metric（structural 只允许 maxVonMises/maxDisplacement，cfd 只允许 maxVelocityMS/pressureDropPa），且 `pressureDropPa` 强制要求 `densityKgM3`——否则运动压力差静默错 ρ 倍。
5. **GCI 发散防护**：单调但发散的序列（观察阶数 p ≤ 0，如应力奇异的 von Mises）按不可信处理，与振荡收敛同路返回，绝不让负 GCI 通过独立性判定。
