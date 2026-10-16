<h1 align="center">SentinelAudit_Coder</h1>

<p align="center">
  <sub>基于本地 Pi 的图形化代码审计与自动化漏洞验证控制台 · v0.1.0</sub>
</p>

> **项目定位**：SentinelAudit_Coder 是基于 [StrikeAgent_Coder-Flash](https://github.com/Yean-Sec/StrikeAgent_Coder-Flash)（原项目，夜安团队 SEC）的**二次开发版本**。
>
> 本仓库在保留原项目核心审计能力的基础上，针对 Pi 生命周期稳定性、靶机（env）搭建可靠性、验证闭环与结构化报告做了增强与修复。

---

## 项目来源 / Upstream

- **原项目**：[Yean-Sec / StrikeAgent_Coder-Flash](https://github.com/Yean-Sec/StrikeAgent_Coder-Flash)
- **原作者**：夜安团队 SEC
- **License**：AGPL-3.0-only（本二开项目同样遵循，详见 [License](#license)）

本项目的代码大量继承自原项目，在此对原项目及其作者致以诚挚感谢。

---

## 二开内容（相对 upstream）

在 `feature/security-report-platform` 分支上，本版本相对 upstream 基线（`5fb788e`）累计 13 个提交，主要包含两类工作：

**稳定性 / 生命周期增强**
- Pi 阶段生命周期增强（`piStageGuard` 门控逻辑：未闭合工具调用追踪、收尾推迟、hard 上限）。
- 修复 audit finalization 时 env 通道被误 SIGTERM 清理的问题（`forceSettleProject` 支持 `excludeChannels: ['env']`）。
- 修复 env 预搭建被过早终止、验证入队被 env 失败阻断未记账等问题。
- env Dockerfile 构建可靠性增强：Debian 系基础镜像强制替换国内 apt 镜像源，避免 `deb.debian.org` 网络抖动导致构建反复失败。
- 修复 SQLite busy 时事件落库崩溃、子智能体 JSON 落盘契约不严等问题。

**结构化报告基础设施**
- vulnerabilities 表与类型新增 `root_cause` / `endpoint` / `exploitation` / `payload` 四个结构化字段，并完成 DB / API / 前端（漏洞详情页、报告 HTML/Markdown）渲染。
- HTTP evidence / POC / exploit report / 验证记录归档能力（`_remote_verify` 产物、`exploit_report` 结构化报告、验证账本）。

---

## 核心架构概述

控制台调度审计与验证。全量审计是每语言 4 路专项 Pi 并发，由后端收口；去重、代码级验证、红队二次评级共用工人池。走完这些关卡后，在 Docker Compose 完整 HTTP 靶机上做单漏洞验证与组合链验证。验证可与审计并行预搭建靶机。

完整闭环：

```
代码审计 → env 靶机搭建 → verify 漏洞验证 → 结果归档（JSON / Markdown / POC / HTTP evidence / exploit report）
```

![SentinelAudit_Coder 架构](docs/assets/architecture.png)

---

## 安装要求

建议在 **Kali Linux** 上运行（远程验证需要调用本机 Docker）。其它 Debian / Ubuntu 也能启动控制台，但 Compose 靶机不一定齐全。

| 依赖 | 版本 / 说明 |
| --- | --- |
| 系统 | Kali / Debian 系，systemd，可 `sudo` |
| Node.js / npm | 18+ |
| Pi | `npm i -g --ignore-scripts @earendil-works/pi-coding-agent`，并配置 `DEEPSEEK_API_KEY` |
| Docker | 当前用户可执行 `docker ps`；远程验证拉取 Compose 完整 HTTP 靶机 |
| 端口 | 开发：5302 控制台 / 8787 API；生产：仅 8787 |
| 磁盘 | `backend/data/`、`backend/workspace/`、`backend/uploads/`（已 gitignore） |

系统包（Kali / Debian）：

```bash
sudo apt update
sudo apt install -y nodejs npm build-essential python3 curl git \
  docker.io docker-compose-plugin
```

安装 Pi：

```bash
sudo npm install -g --ignore-scripts @earendil-works/pi-coding-agent
pi --version
```

模型密钥使用环境变量，**不要写进仓库**：

| 变量 | 作用 |
| --- | --- |
| `DEEPSEEK_API_KEY` | 大模型密钥 |
| `ANTHROPIC_AUTH_TOKEN` | 密钥别名（有则自动填给 Pi） |
| `ANTHROPIC_API_KEY` | 同上 |

---

## 部署 / 运行方法

```bash
git clone <本仓库 URL>
cd SentinelAudit_Coder
npm run install:all
```

长期部署（推荐，崩溃 / 卡死会自动拉起）：

```bash
# 先 export DEEPSEEK_API_KEY=... 等密钥
sudo bash scripts/code-up.sh
```

浏览器打开 **http://127.0.0.1:5302/**（局域网其它机器用 `http://<kali-ip>:5302/`）。

无 systemd 时：`bash scripts/code-daemon.sh start`。

仅本地改代码调试（关终端即停）：

```bash
BIND_HOST=0.0.0.0 PORT=8787 BACKEND_PORT=8787 FRONTEND_PORT=5302 npm run dev
```

生产单端口（supervisor 托管 SPA）：

```bash
BIND_HOST=0.0.0.0 PORT=8787 npm run start:web
```

确认起来：

```bash
curl -sS http://127.0.0.1:8787/api/health   # 期望含 "ok": true
curl -sS http://127.0.0.1:8787/api/pi/health # 期望能解析到本机 pi
```

数据写入 `backend/data/`、`backend/workspace/`、`backend/uploads/`，均已 gitignore。

---

## 基本使用流程

1. 在控制台新建审计项目，上传/指定目标源码（或 clone 目标仓库）。
2. 后端按语言派发多路 Pi 子智能体并行审计，收口后去重、代码级验证、红队二次评级。
3. 审计期间（或审计后）自动搭建 Compose 靶机环境。
4. 对中高危漏洞执行远程验证，产出单漏洞结论与组合链结论。
5. 结果归档为 JSON / Markdown 漏洞报告 / POC / HTTP evidence / 结构化 exploit report，可在项目详情页与漏洞详情页查看。

---

## 当前版本

**v0.1.0** —— 第一阶段封版基线（发布整理中）。

---

## 研发测试 / 能力基线

本版本在开发与自测过程中，围绕以下方面进行了验证（不含任何第三方具体目标的测试细节）：

- **审计流程完整性**：从源码输入到多路子智能体审计、去重、代码级验证、红队二次评级，流程可完整走通。
- **Docker / env 环境构建稳定性**：Debian 系基础镜像在受限网络下仍可稳定完成靶机构建。
- **自动漏洞验证流程**：对中高危发现可自动进入远程验证，产出单漏洞结论与组合链结论。
- **HTTP 证据采集**：验证过程中采集 HTTP 请求 / 响应证据并归档。
- **结构化漏洞报告**：支持根因 / 入口 / 利用方式 / Payload 等结构化字段的落库与渲染。
- **audit → env → verify → report 完整闭环**：全流程可端到端跑通并产出归档结果。
- **验证流程效率与稳定性**：验证阶段在复用靶机、减少重复构建上做了优化。

> 上述能力基线仅用于说明本版本自身已具备的工程能力，不代表在漏洞发现能力上已经超越原项目。漏洞发现能力仍在持续优化中。

---

## 已知问题

1. **漏洞发现能力仍在持续优化**：当前版本的检出能力尚未达到理想水平，后续会继续调优审计与判定策略。
2. **verifier 对部分 authenticated / admin 场景的判定仍可能偏保守**，存在把部分真实风险判为设计行为而漏报的情况。
3. **部分结构化漏洞字段目前尚未完全自动填充**：`root_cause` / `endpoint` / `exploitation` / `payload` 已完成 schema / DB / UI 支持，但自动填充率仍有待提升。
4. **Security Skill / 专项 Agent / 更高级攻击链推理属于后续版本规划**，尚未实现。

---

## License

本项目基于原项目二次开发，遵循 **AGPL-3.0-only**（GNU Affero General Public License v3.0，仅第 3 版）。

- **个人 / 开源（免费）**：可复制、修改、分发；通过网络提供服务时，必须向用户提供完整对应源代码，并以 AGPL-3.0-only 再许可。
- **商业许可**：闭源修改、专有产品、SaaS，或无法 / 不愿履行 AGPL 源代码义务的部署，须向**原项目版权方（夜安团队 SEC）**取得单独商业许可。

原项目版权声明保留于 [NOTICE](NOTICE) 与 [LICENSE](LICENSE)。本项目不声称原项目代码为二次开发者原创。

---

## 安全 / 使用说明

本软件仅限在**已获明确授权**的环境中用于代码审计与安全测试。使用即表示你已获得目标环境的授权，并自行承担合规与后果。原项目作者、夜安团队 SEC 及本项目二次开发者均不对滥用、数据损坏或法律纠纷负责。
