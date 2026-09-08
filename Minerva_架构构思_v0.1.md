# Minerva 教学助理 Agent 架构构思 v0.1

## 0. 核心定位

Minerva 是一个基于 pi agent harness 改造的教师专用 AI 助理。

核心目标不是单纯“会讲题”或“会生成教学内容”，而是：

- 帮助教师掌握大量学生的信息；
- 处理重复性教学工作；
- 持续从作业、测验等数据中更新对学生的认识；
- 从大量数据中筛选真正值得教师关注的信息；
- 辅助教师做出更有依据的教学决策。

一句话概括：

> 让教师教得更轻松，也让教师更充分地掌握学生。

---

# 1. Minerva 的总体架构思想

Minerva 不应该被设计成：

> 一个巨大 System Prompt + 一堆规则。

更合理的拆分是：

```text
Minerva
│
├── System Prompt
│   └── 身份、目标、长期稳定原则
│
├── APPEND_SYSTEM
│   └── 后续持续追加的 Minerva 通用教育原则
│
├── Skills
│   └── 具体教学任务 SOP
│
├── Tools
│   └── 真正读写数据和执行操作
│
├── Extensions / Hooks
│   └── 自动触发、生命周期控制
│
└── Data / Memory
    ├── 作业详细记录
    ├── Evidence Buffer
    ├── Student Profile
    └── Alerts
```

原则：

> Skill = 教 Minerva 怎么做  
> Tool = 给 Minerva 真正执行事情的能力  
> Extension = 保证某些机制稳定、自动发生  
> Database = 保存事实  
> LLM = 理解事实、产生判断

---

# 2. System Prompt 的改造策略

不建议使用 `SYSTEM.md` 完全覆盖 pi 原系统提示词。

更合适的路线：

1. Fork pi；
2. 直接在源码中的默认 System Prompt 做极小范围修改；
3. 只把“coding assistant”身份替换为 Minerva；
4. 尽量保留 pi 原来的 Tool、文件、上下文、执行机制；
5. 后续容易变化的教育规则放入 `APPEND_SYSTEM.md`。

理念：

> Fork Pi，但尽可能不破坏 Pi。

---

# 3. Minerva System Prompt 开头草案

参考 Codex 的系统提示词开头风格：

```text
You are Minerva, an AI teaching assistant for teachers, operating inside pi, an agent harness.

You help teachers understand students, manage teaching-related information, reduce repetitive work, and make better-informed teaching decisions using the context and capabilities available to you.

You should be:
- Accurate
- Evidence-grounded
- Safe
- Helpful

Your capabilities include:
- Receiving user input and other context provided by the harness, such as files in the workspace.
- Communicating with the user through clear and useful responses.
- Reading, creating, and updating files.
- Calling tools to perform actions and retrieve information.
- Using available skills and contextual resources when relevant.
- Depending on the current runtime configuration, some actions may require user approval before execution.
```

设计思想：

System Prompt 开头只负责：

```text
身份
↓
目标
↓
基本行为品质
↓
Harness 能力
```

不要在这里写死：

- JSON 结构；
- 数据库实现；
- Evidence Buffer 算法；
- 作业批改工作流；
- Profile 更新阈值；
- PPT 生成方法。

这些应该交给后面的模块。

---

# 4. Minerva v0.1 当前最重要的范围

第一阶段暂时不重点做：

- PPT；
- 教案生成；
- 学生直接问答；
- 大量外部插件。

先把一个闭环做稳定：

```text
学生作业
↓
Minerva 批改
↓
结构化记录
↓
数据库
↓
分析
↓
教师报告
↓
学生信息迭代更新
```

如果这个闭环跑通，Minerva 的核心价值已经成立。

---

# 5. 作业数据的基本原则

每次作业批改之后，详细信息以结构化 JSON 形式保存到数据库。

数据库保存的是：

> 发生了什么。

而不是：

> 这个学生是怎样的人。

例如：

```json
{
  "assignment_id": "math_20260902_01",
  "student_id": "S001",
  "assignment_date": "2026-09-02",
  "submitted_at": "2026-09-02T17:50:00+08:00",
  "graded_at": "2026-09-02T18:30:00+08:00",

  "score": 72,
  "max_score": 100,

  "questions": [
    {
      "question_id": "Q2",
      "score": 4,
      "max_score": 10,
      "knowledge_points": ["函数定义域"],
      "result": "incorrect",
      "error_type": "conceptual_error",
      "feedback": "没有正确判断根式与分母对定义域的限制。"
    }
  ],

  "knowledge_performance": [
    {
      "knowledge_point": "函数定义域",
      "correct": 1,
      "incorrect": 2
    }
  ],

  "overall_feedback": "基础题完成较好，但函数定义域仍存在明显问题。"
}
```

---

# 6. 为什么一定要保存详细记录

不要只保存：

```text
张三：72 分
```

应该能够知道：

```text
张三
├── 总分：72
├── Q1：集合 ✓
├── Q2：函数定义域 ✕
├── Q3：函数定义域 ✕
├── Q4：二次函数 ✓
├── 概念错误 × 2
├── 计算错误 × 1
└── Feedback
```

因为以后 Minerva 要回答的真正有价值的问题是：

- 张三为什么最近下降？
- 哪个知识点长期薄弱？
- 这个错误是不是重复出现？
- 哪道题全班错误率异常？
- 某知识点是不是出现班级性问题？

---

# 7. 时间特征

每条记录需要显式保存时间。

至少建议区分：

```text
assignment_date
submitted_at
graded_at
```

以后还可以扩展：

```text
semester
week
unit
lesson
```

时间是 Minerva 判断：

```text
偶然错误
vs
近期下降
vs
长期薄弱
```

的基础。

---

# 8. 三层学生信息体系

Minerva 的学生信息不应该只有一个 Profile。

建议分成三层：

```text
事实层
Raw Records
发生了什么
        ↓
观察层
Evidence Buffer
这可能意味着什么
        ↓
认知层
Student Profile
我们目前相对稳定地认为怎样
```

---

# 9. 第一层：Raw Records

保存全部详细事实。

例如：

```text
9 月 2 日
数学作业
72 分
Q2 定义域错误
Q4 定义域错误
```

原则：

> 尽量完整记录事实，不急于形成长期结论。

---

# 10. 第二层：Evidence Buffer

这是 Minerva 最关键的“缓冲记忆层”。

作用：

> 保存那些已经出现一定意义，但证据还不足以改变学生长期画像的信息。

例如：

```json
{
  "student_id": "S001",
  "topic": "函数定义域",

  "hypothesis": "函数定义域掌握可能不稳定",

  "status": "observing",

  "evidence": [
    {
      "assignment_id": "A0902",
      "date": "2026-09-02",
      "type": "concept_error",
      "description": "两道相关题目出现错误"
    }
  ],

  "confidence": 0.42
}
```

Minerva 此时不是说：

> 张三函数定义域很差。

而是：

> 出现一个值得继续观察的信号。

---

# 11. Evidence Buffer 应该允许积累

例如：

```text
9/2
定义域错误
confidence = 0.42

9/5
再次错误
confidence = 0.63

9/8
不同题型继续暴露相同问题
confidence = 0.81
```

达到足够确定性之后，才允许进入 Student Profile。

---

# 12. 不建议简单使用“出现三次”

不同证据的权重不同。

可以考虑：

```text
置信度 ≈
重复次数
× 时间跨度
× 题型多样性
× 证据一致性
× 题目有效性
```

例如：

同一天三道非常类似的题全部错：

```text
证据强度有限
```

而过去两周不同作业、不同题型都出现相同概念问题：

```text
证据明显更强
```

MVP 可以先用简单规则，后续再改进。

---

# 13. Evidence Buffer 必须支持反证

假设：

```text
Hypothesis:
函数定义域掌握不稳定

confidence = 0.71
```

后来：

```text
连续 4 次全部正确
```

应该产生：

```text
counter evidence
```

置信度：

```text
0.71 → 0.46 → 0.31 → 0.17
```

最终这个观察可以被清除。

因此 Evidence Buffer 保存的不是：

> 错误列表

而是：

> 待验证假设 + 支持证据 + 反对证据。

---

# 14. Evidence Buffer 不应该只有负面信息

同样可以观察优势：

```text
Hypothesis:
几何证明可能是该生优势
```

例如：

```text
连续多次不同几何证明题表现良好
```

证据足够后：

```text
Student Profile:
strength = 几何证明能力较强
```

---

# 15. 第三层：Student Learning Profile

学生描述建议正式定义成：

> Student Learning Profile

而不是泛泛的人物性格描述。

建议保存：

```json
{
  "student_id": "S001",

  "summary": "数学总体基础稳定，目前函数相关知识存在阶段性薄弱。",

  "strengths": [
    {
      "content": "几何证明能力较强",
      "confidence": 0.87,
      "evidence_ids": []
    }
  ],

  "weaknesses": [
    {
      "content": "函数定义域掌握不稳定",
      "confidence": 0.91,
      "first_observed": "2026-08-21",
      "last_observed": "2026-09-02",
      "evidence_ids": []
    }
  ],

  "patterns": [
    {
      "content": "复杂题中容易遗漏限制条件",
      "confidence": 0.73
    }
  ]
}
```

---

# 16. Profile 中每个判断最好可追溯

非常建议使用：

```text
evidence_ids
```

例如：

```json
{
  "content": "函数定义域掌握不稳定",
  "confidence": 0.91,
  "evidence_ids": [
    "grading_0821_q3",
    "grading_0826_q5",
    "grading_0902_q2"
  ]
}
```

教师以后可以问：

> 为什么你认为张三函数定义域薄弱？

Minerva 可以指出具体依据。

核心原则：

> 所有关于学生的长期判断尽量可追溯到证据。

---

# 17. Profile 更新不是只有 Add

学生会变化。

所以 Profile Evaluator 应该支持：

```text
ADD
UPDATE
RESOLVE
REMOVE
```

例如：

过去认为：

```text
函数定义域掌握不稳定
```

但之后：

```text
连续 8 次相关题目全部正确
```

可以：

```json
{
  "action": "resolve",
  "profile_item": "函数定义域掌握不稳定",
  "reason": "最近8次相关题目全部正确"
}
```

因此学生画像不是永久标签，而是动态状态。

---

# 18. Profile Evaluator 的核心问题

不要问 LLM：

> 根据这次作业重新总结一下这个学生。

而应该问：

> 这次新的证据，有没有改变我们对这个学生的认识？

Evaluator 输入：

```text
本次 Grading Record
+
Evidence Buffer
+
学生近期历史
+
Current Student Profile
```

输出：

```text
NO_UPDATE
OBSERVE
UPDATE
```

更完整时可以扩展成：

```text
OBSERVE
STRENGTHEN
WEAKEN
PROFILE_ADD
PROFILE_UPDATE
PROFILE_RESOLVE
PROFILE_REMOVE
```

---

# 19. “最近历史”就是缓冲层

我们之前讨论的“这个学生最近的历史”，现在正式定义成：

> Evidence Buffer / Recent Evidence

它不是简单地把过去 N 次作业全文塞给 LLM。

而是把近期有意义的待验证观察保存下来。

这样既减少 Token，也减少学生画像被偶然事件污染。

---

# 20. 报告与 Evaluator 应该共享同一个分析过程

Evaluator 不只是用来更新 Student Profile。

它本身已经回答：

> 这次作业意味着什么？

所以 Evaluator 的判断应该直接成为教师报告的重要信息源。

例如：

```json
{
  "student_id": "S001",

  "evidence_evaluation": [
    {
      "hypothesis": "函数定义域掌握不稳定",
      "decision": "strengthen_observation",
      "previous_confidence": 0.58,
      "new_confidence": 0.76,
      "reason": "本次再次出现两处相同概念性错误"
    }
  ],

  "profile_changes": [],

  "report_significance": {
    "include_in_teacher_report": true,
    "level": "medium",
    "message": "张三在函数定义域方面再次出现重复性错误，目前仍处于观察阶段。"
  }
}
```

---

# 21. “值得告诉教师”与“值得更新 Profile”不是同一个阈值

可以设想：

```text
Evidence confidence

0 ------------------------------ 1

       │                │
       │                │
Report Threshold    Profile Threshold
    0.55                0.80
```

例如：

```text
confidence = 0.63
```

可以：

> 提醒教师关注。

但：

```text
不更新长期 Student Profile
```

等到：

```text
confidence = 0.84
```

才正式成为长期画像。

因此：

```text
弱信号
→ Evidence Buffer

中等信号
→ 教师报告

强信号
→ Student Profile
```

---

# 22. 作业报告

一批作业批改完成后：

```text
N × GradingRecord
↓
Assignment Analyzer / Evaluator
↓
Teacher Report
```

报告主要包含：

1. 表格
2. 文字总结
3. 学生异常
4. 班级异常
5. 新观察
6. 被强化/削弱的观察
7. Student Profile 更新

---

# 23. 教师表格示例

| 学生 | 成绩 | 主要错误 | 薄弱知识点 | 状态 |
|---|---:|---|---|---|
| 张三 | 72 | 概念错误×2 | 函数定义域 | ⚠️观察 |
| 李四 | 91 | 计算错误×1 | 无明显 | 正常 |
| 王五 | 63 | 概念错误×3 | 定义域、单调性 | ⚠️异常 |
| 赵六 | 87 | 审题错误×1 | 无明显 | 正常 |

---

# 24. 教师文字报告示例

```text
本次作业 · 2026-09-02

整体表现：
平均分 78.4，整体与近期水平接近。

值得关注：

张三
函数定义域再次出现重复性错误。
该问题此前已有类似迹象，
当前观察置信度由 0.58 提升至 0.76。
尚未更新长期学生画像，建议继续观察。

王五
本次成绩较个人近期平均水平明显下降。
属于异常表现，但目前缺乏重复证据，
暂不修改长期学生画像。

班级层面：
函数单调性相关题目错误率明显高于近期水平，
已进入班级观察。

学生画像变化：
李四 —— 新增“几何证明表现稳定较强”。
依据：最近多次相关题目均表现良好。
```

---

# 25. Individual Anomaly

学生级异常，例如：

```text
近期平均 88
本次 61
```

或者：

```text
某知识点连续多次出现同类错误
```

或者：

```text
近期正确率持续下降
```

注意：

一次异常可以值得提醒教师，但未必值得更新长期画像。

---

# 26. Class Anomaly

班级整体也要判断异常。

例如：

```text
Q6 错误率 = 68%
```

或：

```text
函数单调性错误率
近期平均 19%
本次 43%
```

Minerva 应该提醒：

> 这可能不只是学生个体问题，也可能需要关注题目设计、教学覆盖或知识点共性理解情况。

---

# 27. Class Evidence Buffer

未来可以进一步设计：

```text
Class Evidence Buffer
```

例如：

```text
Hypothesis:
班级对函数单调性存在共性理解问题
```

第一次：

```text
confidence = 0.52
```

第二次类似异常：

```text
confidence = 0.74
```

连续出现后：

```text
confidence = 0.88
```

这时可以建议教师：

> 考虑针对该知识点进行集中复习。

未来甚至可以形成：

```text
Class Learning Profile
```

---

# 28. 每日总结机制

数据库每条数据都有日期后，可以进一步做：

```text
当天作业
↓
学生级 Daily Summary
↓
班级级 Daily Review
```

建议不要把全班所有原始作业一次性直接塞给 LLM。

更合理：

```text
原始作业
↓
Grading Record
↓
按学生聚合
↓
Student Daily Summary
↓
Class Daily Summary
```

Daily Summary 是中间总结，不等同于长期 Student Profile。

---

# 29. 时间窗口

未来分析可以显式使用：

```text
Today
7 Days
30 Days
Semester
```

例如：

```text
张三 / 函数定义域

Today      2 / 5 错误
7 Days     5 / 13 错误
30 Days    7 / 42 错误
Semester   9 / 96 错误
```

这样 Minerva 才能区分：

```text
一次偶然错误
近期阶段性下降
长期知识薄弱
已经改善的问题
```

---

# 30. LLM 与规则引擎的分工

不建议所有异常都交给 LLM 自由判断。

规则更适合：

```text
成绩下降 > X%
连续 N 次低于个人均值
同知识点连续错误 ≥ N
连续 N 次未交
正确率持续下降
班级某题错误率明显异常
```

规则首先产生：

```text
Candidate Anomaly
```

然后 LLM 结合：

```text
历史
+
Profile
+
Evidence Buffer
+
本次上下文
```

判断这个异常是否具有实际教育意义。

推荐：

```text
Database
↓
Rule Engine
↓
Candidate Anomaly
↓
LLM Evaluator
↓
Teacher Report / Alert
```

---

# 31. 第一版数据库核心对象

可以先设计：

```text
Student
Assignment
Submission
GradingRecord
QuestionResult
KnowledgeEvidence
EvidenceHypothesis
StudentProfile
ProfileChange
Alert
```

后续再逐步添加。

---

# 32. 第一版 Tool 构思

先不要增加大量 Tool。

MVP 可以围绕：

```text
get_student
get_student_profile
get_recent_evidence
record_grading_result
update_evidence_buffer
update_student_profile
create_alert
get_assignment_rubric
```

后续再加：

```text
get_class_statistics
get_student_history
create_intervention
export_student_report
generate_presentation
```

---

# 33. Skill 构思

例如：

```text
grade-assignment
```

负责：

```text
1. 获取 rubric
2. 读取学生答案
3. 批改
4. 生成结构化 Grading Record
5. 保存记录
6. 触发/执行 Evaluator
7. 更新 Evidence Buffer
8. 必要时更新 Profile
9. 输出本次报告信息
```

其他可以逐步增加：

```text
diagnose-student
improvement-plan
class-analysis
lesson-preparation
```

---

# 34. Extension / Hook

像下面这种关键机制：

> 每次作业批改完成后，一定进入记录与分析流程

不应该只依靠模型“想起来调用 Skill”。

以后可以通过 pi Extension / Hook 保证：

```text
grading finished
↓
persist record
↓
run evaluator
↓
update evidence
↓
generate report insight
```

---

# 35. 不建议直接把“学生性格”作为稳定字段

尽量避免：

```text
内向
懒惰
粗心
```

更适合保存：

```text
复杂题中经常遗漏限制条件
订正后二次正确率较高
开放题完成率低
图形类题目表现较稳定
```

核心原则：

> 优先记录可观察行为，不轻易形成永久人物标签。

---

# 36. Minerva 当前最核心的数据流

```text
                         Assignment
                              ↓
                           Grading
                              ↓
                       Grading Record
                              ↓
                           Database
                              ↓
                           Evaluator
                              │
           ┌──────────────────┼──────────────────┐
           ↓                  ↓                  ↓
   本次表现分析         Evidence Buffer       异常判断
                              │
                              ↓
                         Hypothesis
                              │
                     Confidence 变化
                              │
                 ┌────────────┴────────────┐
                 ↓                         ↓
             尚未确定                  足够确定
                 │                         │
             继续观察                 Profile Delta
                                           │
                                           ↓
                                    Student Profile

Evaluator 输出
      │
      ├── 学生异常
      ├── 班级异常
      ├── 新观察
      ├── 被强化的观察
      ├── 被削弱的观察
      └── Profile 更新
                    ↓
               Teacher Report
                    ↓
              表格 + 文字总结
```

---

# 37. Minerva v0.1 的核心产品价值

Minerva 不应该只是：

> 我帮老师批改了 100 份作业。

而应该是：

> 我看完并结构化记录了 100 份作业，
> 持续更新对学生的认识，
> 最后告诉教师今天真正值得关注的几件事情。

最终实现的信息压缩：

```text
几万条原始记录
↓
Evidence / Trends
↓
几十或上百份 Student Profile
↓
今天真正重要的少量 Alert / Report Insight
↓
Teacher Decision
```

---

# 38. 当前最值得继续设计的问题

下一阶段优先级：

## A. Grading JSON Schema
明确一份作业到底保存哪些字段。

## B. Evidence Buffer Schema
明确一个“待验证假设”应该保存什么。

## C. Profile Evaluator
定义：

```text
什么时候创建 Hypothesis？
什么时候强化？
什么时候削弱？
什么时候进入 Profile？
什么时候 Resolve？
```

## D. Teacher Report Schema
统一表格、文字总结、异常和画像变化的输出格式。

## E. 最小数据库设计
先用 SQLite 即可跑通 MVP。

---

# 39. 一句话定义当前 Minerva 核心

> Minerva 将每次教学活动留下的原始证据转化为对学生不断修正的、可追溯的认识，并把真正值得教师关注的信息从大量数据中筛选出来。

