# Docker 打包设计（dsh-cae v0.3.0）

日期：2026-08-26
状态：已与维护者逐节确认

## 背景与目标

当前安装要求用户跨三个依赖生态手工装环境：pip/conda 四件套（build123d、gmsh、pyvista、ccx2paraview）、CalculiX（apt 或 conda）、OpenFOAM（官方仓），另有无头渲染（osmesa）、libexpat 遮蔽等暗坑。2026-08-25 的 PDC 钻头真实案例中，环境问题消耗了整个 session 的主要精力。

**首要目标：新用户 5 分钟跑通**——预构建镜像发布到 GHCR，装好插件后配置一行即可运行，不再接触 conda/apt/OpenFOAM 安装。

## 已确认的决策

| 决策点 | 选择 |
| --- | --- |
| 首要目标 | 新用户 5 分钟跑通（预构建镜像 + 一行配置） |
| 镜像内容 | 单一大镜像：结构力学链路 + OpenFOAM CFD 链路（约 3–4GB） |
| 分发渠道 | GHCR（`ghcr.io/daiyuhangsustc/dsh-cae`，GitHub Actions 自动构建；GHCR 要求小写） |
| 配置接入 | 显式 `python: docker://<image-ref>` 值，复用现有字段，不加新配置项；`auto` 探测链保持 conda → python3 不变 |

## 架构：方案 A，只有 Python 阶段进程进容器

```
宿主机                                    容器 ghcr.io/daiyuhangsustc/dsh-cae
┌─────────────────────┐                  ┌──────────────────────────────┐
│ dsh harness          │                  │ build123d gmsh pyvista(osmesa)│
│  └ dsh-cae 插件(TS)  │──docker run ───▶ │ ccx  OpenFOAM 13             │
│     workdir/cae ◀────┼──同路径挂载──────▶│ python -m dsh_cae.<stage>    │
└─────────────────────┘                  └──────────────────────────────┘
```

harness 与插件 TS 层留在宿主机；仅 `runStage` spawn 的 Python 阶段进程运行在容器中。备选方案（整个 harness 进容器的 dev container、只发环境镜像不动代码）已评估并否决：前者与 `dsh plugin add` 安装生态冲突，后者达不到 5 分钟目标。

## 配置语义

`python` 字段新增合法值 `docker://<image-ref>`：

```yaml
python: docker://ghcr.io/daiyuhangsustc/dsh-cae:latest
```

`interpreter.ts` 新增 `parseRuntime(python: string)`：

- `{ kind: 'local', command: string }` —— 现状，任何非 `docker://` 值透传，行为一字不变
- `{ kind: 'docker', image: string }` —— `docker://` 后的完整 image ref；为空或非法时在使用处 throw，报错附配置示例

`auto` 不包含 docker，两条路线互不干扰。运行时解析按 config 对象记忆化（沿用 `pythonFor` 模式）。

## 执行路径

docker 运行时的 spawn 形态：

```
docker run --rm --init
  -v <abs-workdir>:<abs-workdir>              # 同路径挂载
  -v <插件根>/python:/opt/dsh-cae/python:ro    # dsh_cae 包随插件版本走
  -w <abs-workdir>
  -u <uid>:<gid>
  -e HOME=/tmp
  IMAGE python -m dsh_cae.<stage> <args...>
```

关键决策与理由：

1. **同路径挂载 workdir**：回执中的 `mshPath`/`vtuPath` 等在宿主与容器是同一字符串，工具层与 agent 零路径翻译。
2. **`python/dsh_cae` 只读挂载，不进镜像**：镜像只含第三方依赖；插件升级不需要重建镜像，两个发布节奏解耦。
3. **环境变量白名单**：docker 分支仅传 `PYTHONPATH=/opt/dsh-cae/python`（无头渲染等其余环境由镜像 `ENV` 固化），**不继承宿主 `LD_LIBRARY_PATH`**——宿主环境污染到不了容器（案例教训制度化）。
4. **deps 自检零改动**：deps 本身是一个 Python 阶段，自动在容器内运行；`ccxPath` 等诊断照常回报。
5. **超时/kill 复用**：现有进程组 SIGTERM 杀 docker CLI，`--rm` 负责 daemon 侧清理，`--init` 保证信号转发与僵尸回收。
6. **`-u $(id -u):$(id -g)` + `HOME=/tmp`**：工件归当前用户所有（避免 root-owned 文件）；gmsh/vtk 缓存有可写 HOME。

## 镜像（`docker/Dockerfile`）

分层：

1. `FROM ubuntu:24.04`（OpenFOAM.org 官方 apt 仓支持）
2. OpenFOAM Foundation 13，官方 apt 仓，装于 `/opt/openfoam13`——Python 侧 bashrc 自动探测已有 `/opt/openfoam*` 规则，零改动
3. micromamba + conda env `dsh-cae`：`python=3.11 build123d gmsh pyvista ccx2paraview vtk(osmesa) calculix`——CalculiX 选 conda 源，与开发机同源
4. `ENV PATH=…/envs/dsh-cae/bin:…`、`PYVISTA_OFF_SCREEN=true`
5. **构建期验证层**：`RUN --mount=type=bind,source=python,target=/tmp/dsh-py …`（BuildKit bind mount，文件不进镜像层）临时挂入本仓库 `python/` 与 `pytest/` 跑全量 pytest；不绿则构建失败——依赖层损坏在 build 阶段即爆，且验证文件零残留（与"镜像不装 `dsh_cae`"一致）
6. 无 `CMD`/`ENTRYPOINT`：始终由 `runStage` 显式给命令

体积约 3–4GB（OpenFOAM 1.5–2GB + conda 环境 ~2GB），apt/conda 清理压层。已接受单一大镜像的取舍。仅 amd64。

## CI 发布（`.github/workflows/docker.yml`）

- 触发：push tag `v*` + `workflow_dispatch`（master 普通提交不触发，单次构建 20–40 分钟）
- `docker/build-push-action` → `ghcr.io/daiyuhangsustc/dsh-cae`，权限 `packages: write`，`GITHUB_TOKEN` 即可
- tag 策略：插件 `v0.3.0` → 镜像 `0.3.0`、`0.3`、`latest`；文档快速上手用 `:latest`，生产钉版本
- 首版与本批改动对齐为 `v0.3.0`

## 错误处理

docker 运行时首次使用前 `dockerPreflight()`（按 config 对象记忆化，每进程一次），按失败类型给精确指引：

| 检查 | 失败时报错 |
| --- | --- |
| `docker` CLI 存在 | Docker 未安装，指向 docs.docker.com |
| `docker info` | daemon 未运行，给 `sudo systemctl start docker` |
| `docker image inspect IMAGE` | **自动 `docker pull`**（独立执行、不占 `stageTimeoutMs` 预算、不设超时上限）；失败时报错附手动 pull 命令 |

自动 pull 是 5 分钟上手的关键一环。其余故障沿用现有机制：容器内依赖损坏走 deps 回执诊断；非 POSIX 平台明确报 POSIX only（插件既有约束）。

## 测试策略

| 层 | 内容 | 触发 |
| --- | --- | --- |
| vitest 单元 | `parseRuntime`：docker:// 提取、非法 ref 报错、本地值透传；preflight 错误文案 | 每次必跑 |
| vitest e2e（opt-in） | 开发者先 `docker build -t dsh-cae-e2e:dev docker/`；设 `DSH_CAE_DOCKER_E2E=1` 时，docker 运行时跑 deps + fake_stage 断言回执 | 沿用 `DSH_COMPOSITION=1` 先例，CI 默认跳过 |
| 构建期 pytest | Dockerfile 验证层全量跑结构 + CFD 链路 | 每次镜像构建 |
| 既有测试 | 30 vitest + 50 pytest 全走本地路径，零影响 | 每次必跑 |

## 文档改动

- README 安装段重写为两条路线：路线 1（推荐，Docker）：装 Docker → `dsh plugin add` → 配 `python: docker://ghcr.io/daiyuhangsustc/dsh-cae:latest` → 直接使用（首跑自动拉镜像）；路线 2：现有本地 conda 内容原样保留。中英双语。
- config 表补 `docker://` 语义；故障排查段补 docker 条目（daemon 未运行、镜像过期 → `docker pull`）。

## 明确不做（YAGNI）

- arm64 多架构构建（无 arm 机器需求；以后加一行 platform 即可）
- `auto` 探测链纳入 docker（隐式接管违背显式配置原则）
- `--network=none` 运行隔离（当前阶段无收益）
- 整个 harness 进容器（与插件安装生态冲突）
- 镜像内预装 `dsh_cae` 包（破坏插件/镜像解耦）
