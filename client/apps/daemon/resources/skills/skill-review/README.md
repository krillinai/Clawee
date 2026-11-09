# Skill 审核规则来源与维护说明

本目录的 [SKILL.md](./SKILL.md) 定义上传 Skill 的基础安全与结构静态审核规则。本文件供维护者追溯参考来源，不属于审核指令；按 [P9 方案](../../../../../../docs/v1/P9-Skill%20AI审批工作流方案设计.md) 的加载约定，Worker 仅显式读取可信的 `SKILL.md`。

调研与版本核对日期：2026-10-21。审核规则 `1.1.0` 已根据下列来源加强安全、结构、证据覆盖及误报判断；实际检查范围以 `SKILL.md` 为准，未引入上游扫描器或工具执行能力。

2026-10-23，规则 `1.3.0` 根据 `moka-helper-codex` 单文件包的静态审核补充本地案例校准：按工作目录区分包内资源与外部配套项目依赖；区分本地存储、浏览器操作与模型处理，核对“全部本地”等隐私承诺；检查快路径、结构化输入交接和已有验收方法是否覆盖声明输出。明确私有环境依赖、未知模型部署、仅有关键词验收均不自动构成阻断，仍按具体证据和既有门槛判断。未读取该配套项目源码或执行被审内容，未引入新的上游材料。

## 公开参考来源

源码与许可证链接均固定到已核对的上游 commit，避免默认分支后续变动影响追溯。安装量来自首轮 skills.sh 调研，Stars 来自来源仓库的 GitHub 快照，均为使用情况背景，不是安全保证或采纳依据。

| 编号 | 来源与源码 | 固定 commit | 许可证 | 安装量 / 仓库 Stars |
| --- | --- | --- | --- | --- |
| R1 | Sentry：[skill-scanner](https://github.com/getsentry/skills/blob/f57ada2d0b640406ea7e25b11d636c530e77c58b/skills/skill-scanner/SKILL.md) | `f57ada2d0b640406ea7e25b11d636c530e77c58b` | [Apache-2.0](https://github.com/getsentry/skills/blob/f57ada2d0b640406ea7e25b11d636c530e77c58b/LICENSE) | [约 3,700](https://skills.sh/getsentry/skills/skill-scanner) / 1,073 |
| R2 | Superagent：[skill-security](https://github.com/superagent-ai/skills/blob/0da315b873ed141025fa601ed6e0ebe0c878d5af/skills/skill-security/SKILL.md) | `0da315b873ed141025fa601ed6e0ebe0c878d5af` | [MIT](https://github.com/superagent-ai/skills/blob/0da315b873ed141025fa601ed6e0ebe0c878d5af/LICENSE) | [约 7,800](https://skills.sh/superagent-ai/skills/skill-security) / 79 |
| R3 | UseAI-pro：[skill-vetter](https://github.com/UseAI-pro/openclaw-skills-security/blob/4645f2d047d63e0682b01745d9fc07720110d386/skills/skill-vetter/SKILL.md) | `4645f2d047d63e0682b01745d9fc07720110d386` | [MIT](https://github.com/UseAI-pro/openclaw-skills-security/blob/4645f2d047d63e0682b01745d9fc07720110d386/LICENSE) | [约 21,000](https://skills.sh/useai-pro/openclaw-skills-security/skill-vetter) / 73 |
| R4 | Softaworks：[skill-judge](https://github.com/softaworks/agent-toolkit/blob/3027f20f3181758385a1bb8c022d4041dfb4de84/skills/skill-judge/SKILL.md) | `3027f20f3181758385a1bb8c022d4041dfb4de84` | [MIT](https://github.com/softaworks/agent-toolkit/blob/3027f20f3181758385a1bb8c022d4041dfb4de84/LICENSE) | [约 4,200](https://skills.sh/softaworks/agent-toolkit/skill-judge) / 2,575 |
| R5 | daymade：[skill-reviewer](https://github.com/daymade/claude-code-skills/blob/b35230d429be9400880deb1d7b42509d1c5d288c/daymade-skill/skill-reviewer/SKILL.md) | `b35230d429be9400880deb1d7b42509d1c5d288c` | [MIT](https://github.com/daymade/claude-code-skills/blob/b35230d429be9400880deb1d7b42509d1c5d288c/LICENSE) | [约 1,400](https://skills.sh/daymade/claude-code-skills/skill-reviewer) / 1,483 |
| R6 | Anthropic：[skill-creator](https://github.com/anthropics/skills/blob/dbd4588f9e1033efb41dad4bef2f7947c8993d44/skills/skill-creator/SKILL.md) | `dbd4588f9e1033efb41dad4bef2f7947c8993d44` | [Apache-2.0，按该 Skill 目录核对](https://github.com/anthropics/skills/blob/dbd4588f9e1033efb41dad4bef2f7947c8993d44/skills/skill-creator/LICENSE.txt) | [约 411,000](https://skills.sh/anthropics/skills/skill-creator) / 182,514 |

## 已参考内容与取舍

### R1：Sentry skill-scanner

- 作为安全审核的主要参考：提示注入、危险脚本、权限必要性、凭据暴露、供应链、声明用途与实际行为的一致性。
- 补充配置与记忆投毒、Hooks、安装或测试阶段自动执行等检查线索；结合目标宿主的实际能力判断风险。
- 参考其误报处理方法：区分实施攻击的指令与用于教学、检测的攻击示例，按上下文和证据判断。
- 不直接接入其扫描脚本、命令执行流程或工具权限；本地审核继续遵守 P9 隔离边界。

### R2：Superagent skill-security

- 参考威胁分类与行为一致性判断：核对声明目的、敏感数据来源、外传去向、动态执行及持久化行为。
- 已查阅 [references/taxonomy.md](https://github.com/superagent-ai/skills/blob/0da315b873ed141025fa601ed6e0ebe0c878d5af/skills/skill-security/references/taxonomy.md)，补充审核操纵、隐藏指令、名称仿冒与供应链风险的具体检查项。
- 不直接引入其 AST、污点分析或 YARA 执行流程，也不声称本地模型审核具备这些确定性扫描能力；其 0–100 风险分不参与本地正式评分。
- [目录的 Snyk 审计](https://skills.sh/superagent-ai/skills/skill-security/security/snyk) 于 2026-06-12 提示读取第三方材料产生的间接提示注入风险。借鉴规则时保留可信指令与被审数据的隔离，不以目录标签代替源码判断。

### R3：UseAI-pro skill-vetter

- 参考安装前元数据检查、权限范围与必要性、名称仿冒检查清单；审核规则本身继续按 P9 固定版本与摘要。
- 上游将出现 `curl`、外部地址或编码内容等列为直接阻断项，规则较粗；本地需结合用途、数据流和执行上下文判断，不能仅凭关键词判恶意。
- 不将作者身份、版本字段或来源排名直接变成所有 Skill 的强制门禁，不采纳上游特定服务的信任排序和反馈流程。

### R4：Softaworks skill-judge

- 参考触发描述、渐进加载、引用文件的读取条件、流程可操作性、边界情况与失败处理。
- 其知识增量、风格偏好及 120 分质量评分属于另一套评估框架，不直接作为 P9 通过条件，不参与人工四维评分。
- 行数、写作风格和是否包含固定章节可作为改善建议，不单独构成安全或结构阻断依据。

### R5：daymade skill-reviewer

- 作为结构审核的主要参考：声明目标、输入输出、工作步骤、依赖权限、资源路径、引用完整性及失败处理是否一致。
- 已查阅 [references/evaluation_checklist.md](https://github.com/daymade/claude-code-skills/blob/b35230d429be9400880deb1d7b42509d1c5d288c/daymade-skill/skill-reviewer/references/evaluation_checklist.md)。参考其证据覆盖原则，区分静态质量、实际任务效果与宿主兼容性；审核器执行失败不能冒充被审 Skill 的质量问题。
- 不照搬 Claude Code 专属字段、英文措辞或第三人称等写作约束；不引入上游自动修改、提交 PR 或其他外部写入流程。

### R6：Anthropic skill-creator

- 参考官方示例中的 `SKILL.md`、Frontmatter、触发描述，以及 `scripts/`、`references/`、`assets/` 的资源组织方式。
- 已查阅 [scripts/quick_validate.py](https://github.com/anthropics/skills/blob/dbd4588f9e1033efb41dad4bef2f7947c8993d44/skills/skill-creator/scripts/quick_validate.py)，作为基础格式检查的参考；具体必填项、扩展字段和长度限制仍以本项目支持的协议为准。
- 该 Skill 主要用于创建、改进和评测 Skill，不是专门的安全扫描器；不引入其运行评测流程，不以静态检查结论声称已验证运行效果。

## 本地规则映射

| `SKILL.md` 章节 | 来源 | 本地采纳内容 |
| --- | --- | --- |
| 审阅方法与证据 | R1、R2、R5 | 覆盖提供的全部文本，核对声明与实际行为，沿数据来源与去向判断，明确缺失证据和覆盖限制，不复述真实凭据 |
| 基础安全检查 | R1、R2、R3 | 权限必要性、外传、动态执行、供应链、审核操纵、配置及记忆投毒、隐蔽执行入口、破坏性写入与路径越界；按宿主实际能力判断 |
| 结构审核检查 | R4、R5、R6 | 入口触发、输入输出、步骤与失败处理、资源引用、依赖权限及可移植性；不套用其他平台专属格式或写作偏好 |
| 误报识别与结论 | R1、R2、R4、R5 | 区分攻击与教学检测，区分必要凭据使用与窃取，关键证据缺失不能通过；结论映射到 P9 既有枚举，不引入外部评分 |
| 输出契约 | P9 本地契约 | 保持字段、大小、证据路径和人工评分边界，问题包含证据、影响与修改建议 |

## 本地维护边界

- 审核执行所需的规则完整保存在 `SKILL.md` 中，不依赖运行时访问本文件、上游链接或其他资源。
- 保持 P9 的静态分析、覆盖限制说明、中文 JSON 报告契约及人工评分边界；上游评分和报告格式不直接替换本地契约。
- 后续采纳具体检查项时，更新本文件，记录来源编号、对应本地章节、实际采纳内容及未采用原因；规则版本按 P9 约定维护。
- 更新参考来源时同时核对 commit、文件路径和许可证。若复制或改编上游正文、脚本或其他材料，按实际使用内容保留对应版权、许可证与必要声明。
