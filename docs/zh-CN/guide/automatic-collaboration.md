---
title: 自动多模型协作
description: 从输入框底栏选择执行模型和审查模型。
---

# 自动多模型协作

[英文原文](/guide/automatic-collaboration)

在本 fork 的智能体模式中，点击输入框底部、权限模式旁的“协作：关闭”，
选择“智能”或“始终”，设置主开发模型、协作模型、并发上限后保存。
设置只对当前会话的下一轮智能体任务生效，重启后保留，其他会话不受影响，无需输入触发词。
选择“关闭”并保存即可恢复普通工作流。

Claude 负责实现、pro GPT 负责审查时，主开发模型选择相应渠道的 Claude，
协作模型选择名称后带有 **pro** 的 GPT。渠道名用来区分不同账户。
两个模型都需要在模型设置中启用“可用于子代理”。模型被移除、禁用或凭据无法
解析时会提示配置问题，不会自动换到另一个渠道。

- **智能**：当前主模型每轮自行判断。问答、查找、小改动和局部测试通常直接完成；
  大范围排查、前后端分工、需要独立审查的复杂改动或明确协作请求才启动子代理。
  判断本身不会启动额外 agent。
- **始终**：开发和审查任务使用协作，简单问答仍直接回答。默认最多 8 个并发，
  可调为 1～10；这是上限，不会为每个小问题硬开 8 个。
- **子代理位置**：在当前对话的 Task 分组内展开查看角色、模型和结果，不产生侧栏聊天。
- **审查**：启动协作后，内置文件修改或命令执行会触发独立源码审查。发现问题可修复再审，
  每轮最多三次。源码审查和实际运行测试会分别报告。
- **停止**：停止当前轮及其子代理，包括自动审查。

协作开关不会改变权限模式。任务运行中、非本地智能体模式下不能调整。
并发越多可能消耗越多，也受渠道自身速率限制。审查不能保证代码无错；
插件/MCP 的修改、外部修改及运行时重启后的工作不在内置审查门控范围内。

智能模式下，工作流只在决定协作时使用。独立处理使用当前对话模型和原权限，
不会自动派出审查或测试 agent。启动协作后，本轮保留原有审查、测试和失败拦截；
下一条用户消息重新判断。“只读审查”预设始终禁止主模型写文件或运行命令。
需要每次开发都跑完整流程时选“始终”。旧“自动/深度”对应“智能/始终”，模型渠道不变。

## 工作流与代码分工

同一协作菜单中的“自动选择”让当前主模型根据本轮任务选择快速修复、标准开发、
深度开发或只读审查，并在工作流结果记录简短原因，不额外启动判断 agent。
手动选择具体工作流即锁定，直到切回自动选择；灵活协作仍是手动选项。
自动决定只影响本轮，不覆盖保存值。“智能”模式仍先判断是否需要协作。

“自动分工”让规划者把明确文件范围的任务交给主开发或协作开发模型。
Claude 和 pro GPT 都可以写前端或后端，按任务和依赖安排，不硬凑人数。
仍可选择主模型独立开发、固定前后端分工。规划、源码审查和测试继续使用新的
协作模型上下文；即使 GPT 也写了代码，开发上下文也不能给自己验收。

每个会话分别保存完整协作配置，切换会话互不影响，重启后保留。主机通过
`session.workflow.get/set` 存入已有 KV 的 `session-workflow-v1` 命名空间，
不改写对话或数据库结构。旧会话首次读取时复制原全局选择，保留明确的只读审查
和主模型独立开发限制；新草稿默认自动选择与自动分工，但保留上述限制。
仅调整草稿不创建会话，发送时才一并保存。对话分支复制设置，删除仅清理自身。
运行中、等待计划审批及计划执行排队或运行时不能更改；保存作用于本会话下一轮。
界面支持加载失败重试，并丢弃切换会话后的迟到响应。插件单次补全和语音分类
不加载会话工作流，也不触发协作。

标准流程是：规划 → 按依赖开发 → 独立审查和实际测试 → 必要时修复 → 重新检查 →
交付。深度开发增加方案审查、回归审查和边界测试。快速修复最多规划三个开发
任务，标准开发八个，深度开发十六个；同时运行数量仍受菜单中的并发上限控制。
没有依赖、文件不重叠的任务可以并行；同一文件的开发和协助必须先后执行。
计划中的循环依赖、未知依赖、未排序的文件冲突会在写入前被拒绝。

源码审查必须有成功的 Read 记录，只列出文件名不能通过。审查判断源码问题，
执行命令由独立测试阶段负责；测试必须有真实 Bash 记录且退出码为零。
仅口头声称通过不能验收。失败后最多修复两轮，每次都重新检查；无法验证或
仍有问题会明确停止。只读请求和只读审查预设不会启动写代码或运行命令的角色。
停止会取消当前子任务并阻止后续阶段，重复调用同一轮工作流不会重复修改文件。

阶段、计划、命令和结果保存在当前对话的工具历史中，子代理仍位于当前对话，
不会创建侧栏聊天。内置 Write/Edit 会核对任务的文件归属，Bash 沿用现有操作权限，
不能视为按文件隔离的沙箱。重启后配置和历史保留，但中断的流程不会自动续跑；
需先检查已有改动再重新运行。当前不包含任意脚本导入、工作流编辑器或跨进程续跑。

验证角色使用读取和命令工具，流程不会自动安装浏览器工具。浏览器验收需要项目已有
的自动化测试环境，或明确交给操作者单独完成，并分别报告实际证据。

## macOS 安装与保留数据

使用 `pnpm --filter @pi-desktop/desktop pack` 构建本地安装版。Apple Silicon
应用位于 `apps/desktop/release/mac-arm64/PI-Desktop.app`，已经包含正式构建的
host-core 和 agent runtime，日常启动无需开发服务器或预览脚本。
未配置 Developer ID 证书的本地构建不属于经过 Apple 公证的正式发行版。

替换 `/Applications/PI-Desktop.app` 前先退出旧应用，备份应用、`~/.pi-desktop`
和 `~/Library/Application Support/PI-Desktop`，同时保留自定义存储目录及外部插件。
只替换应用本体，不要把开发或验收环境的数据覆盖到原数据上。应用标识、名称和
默认数据路径保持一致。

本 fork 的更新源和发行版链接指向 `cgl1307929582-prog/PI-Desktop`，避免官方更新
自动覆盖协作版。后续自动更新仍需要在这个 fork 发布兼容且满足签名要求的安装包；
推送源码本身不会发布应用更新。

安装后正常启动 PI，检查原项目、对话、模型服务和插件，再从协作菜单选择原来的
模型渠道。若升级发生数据迁移，需要回滚时先退出应用，并成对恢复旧应用及数据备份。


### Workflow recovery and verification boundaries

Each check returns structured evidence. Source review requires a successful Read
of current files against the original task. It does not invent a requirement for
a clean tree or a pre-change dirty-workspace snapshot; explicitly requested scope
audits remain required. An inconclusive source verdict gets one fresh clarification
per check, retaining the earlier report. Missing required evidence still blocks;
no verdict is changed to pass by matching report wording. Test owns command execution.

Test requires observed Bash results. A real nonzero exit is a failing check even
when the host marks the tool `TOOL_FAILED`; it can trigger at most two code-repair
rounds. Missing prerequisites stop without speculative code edits. All observed
commands are retained. A later successful run of the identical command can resolve
its earlier failure. Cross-runtime replacement is limited to unavailable launchers
(exit 126/127 or a recognized Go launcher version error), with the same cwd, test
runner, arguments and selectors. A real version-specific failure cannot be cleared
by another interpreter, a narrower test or an unrelated successful command.
Missing, denied or truncated evidence never passes. Verifiers reuse project runners
and environments without installing dependencies or modifying tests.

Deep plan review judges coverage before implementation, not whether planned fixes
already exist. A rejected plan gets at most two revisions and independent reviews
before any writer starts. Planning format corrections retain their separate bound.
Plans may use `tasks: []` when only verification remains; nonempty original acceptance
criteria and independent Review/Test evidence remain mandatory.

Independent coding refills free slots immediately when dependencies are satisfied.
A worker failure stops scheduling, aborts siblings and waits for every started child
to settle. Stop also covers worktree preparation; file ownership guards survive
until child tools and cancellation acknowledgement have completed. Direct Task
calls cannot bypass a structured workflow. Read-only requests/presets keep their
existing restrictions.

Ordinary repeated workflow calls return the settled result. After failed verification,
`retry: "verify"` with a concrete `retryReason` permits one fresh Review/Test attempt
in the same turn, without writers or more repair rounds. The original task, acceptance,
preset, model pins and read-only restrictions are frozen; replacement task text cannot
narrow them. Planning/coding failures and cancellation cannot use this shortcut.
A later user turn rechecks current files and may plan verification only. Error cards
distinguish plan rejection, verification blockers, failed checks and execution failure.
