---
name: short-drama-h3-prompt
description: 生成 MiniMax H3 Ref2VA 全能参考模式的短剧/职场剧系列视频提示词+分镜剧本。涵盖人物服装发型音色三层锁定、语速气口精确计算、空间位置固定、参考图整集统一编号、说话镜头锁人、无BGM保留环境音等全套生产规范。适用于多集连续短剧、单集独立短剧、番外篇的分镜+H3六段式提示词生成。
compatibility: 与 h3-prompt-writing skill 配合使用，本 skill 专注短剧生产规范和质量门禁，h3-prompt-writing 提供 H3 六段式基础格式。
---

# 短剧 H3 提示词生成规范

## 适用场景

- 多集连续短剧（如职场剧、女频爽剧、商战剧）的分镜+H3提示词批量生成
- 单集独立短剧、番外篇、开场段
- 已有角色参考图+场景参考图的 Ref2VA 全能参考模式
- 9:16 竖屏抖音短剧为主，也支持其他比例

## 核心原则

1. **人物一致性 > 一切**：服装、发型、音色、位置必须整集/整系列锁死，每段每镜头重复
2. **快节奏**：每段第4秒必须进入对话，开头不拖拉
3. **台词说得完**：语速+气口精确计算，宁可多分段也不挤
4. **空间不飘**：桌子/房间布局是空间锚点，人物位置每段一致
5. **说话镜头锁人**：谁说话镜头锁谁，不切其他人（避免模型让错误的人动嘴）

---

## 工作流程

### 第一步：探查与锁定

在写任何提示词之前，先完成以下锁定：

- [ ] **人物清单**：列出本集出场的所有人物，每人绑定参考图编号
- [ ] **服装锁定**：每人的具体服装描述（越具体越好，禁止模糊词）
- [ ] **发型锁定**：每人的发型描述，明确否定不需要的特征
- [ ] **音色锁定**：每人的说话人ID(S1/S2...)和音色描述
- [ ] **位置锁定**：每人在场景中的固定位置（谁坐桌后、谁坐对面、桌子在谁和谁之间）
- [ ] **场景锁定**：场景参考图编号+关键空间元素
- [ ] **参考图顺序表**：整集统一的 Picture 1/2/3... 编号，每段开头必须列出

### 第二步：分镜表

每段必须先出分镜表，再写H3提示词。分镜表规范见下方「分镜表规范」。

### 第三步：H3六段式提示词

按 `references/template.md` 中的模板写每段提示词。必须遵守「人物三层加固法」和「位置锁定法」。

### 第四步：交付前校验

用下方「交付检查清单」逐项校验，不通过则修改后再交付。

---

## 分镜表规范

### 必须包含的列

| 列名 | 说明 |
|---|---|
| 镜头 | 镜头编号（1/2/3...） |
| 时间 | 本段内的时间区间（如 0-3s） |
| 时长 | 该镜头秒数 |
| 景别 | 特写/中近景/中景/全景/POV等 |
| 画面 | 具体画面描述（人物动作、表情、机位、运镜） |
| 台词 | 该镜头的台词原文 |
| 字数 | 台词汉字数（标点不计） |
| 语速 | 字/秒，必须扣除气口和动作时间后计算 |

### 语速计算规则（核心！）

**公式**：
```
实际语速 = 台词字数 ÷ (该镜头时长 - 气口总时长 - 纯动作时长)
```

**气口规则**：
- 台词中的 `——` = 停顿气口，每个约 0.8s
- 计算语速时必须把气口时间从镜头时长中扣除
- 提示词中必须标注 `(pause ~0.8s at ——)`

**语速参考范围**：

| 情绪/角色 | 语速范围 |
|---|---|
| 高冷/淡定/碾压 | 2.5 - 4 字/秒 |
| 正常对话 | 3 - 4.5 字/秒 |
| 撒娇/害羞/拖音 | 2 - 3.5 字/秒 |
| 暴怒/激动/快说 | 4.5 - 6 字/秒 |
| 轻佻/挑衅 | 4 - 5.5 字/秒 |

**铁律**：
- 禁止出现 5+ 字/秒 还叠加气口的情况（绝对说不完）
- 如果台词多+气口多+动作多，镜头时长不够 → 增加镜头数或增加段数，不要硬挤
- 用户明确说过"剧情4段15s分不完可以分5-8段"

### 节奏规则

- **每段第4秒必须进入对话**（短剧快节奏，开头钩子要快）
- 纯动作/环境镜头不超过3秒
- 段与段之间的衔接要自然（上一段结尾钩子→下一段开头承接）

---

## H3 六段式规范

字段名固定顺序：
1. `subject_definitions`
2. `summary`
3. `retention_analysis`
4. `detailed_description`
5. `overall_soundscape`
6. `non_diegetic_music`

### 各字段写法要求

**subject_definitions**：
- 每人一个 `<Subject N>`，写明参考图来源+面部特征+**锁定的服装发型**+位置+音色+说话人ID
- 场景一个 `<Subject N>`，写明参考图来源+关键空间元素
- 背景路人/同事纯文字描述，不占 Subject 标签
- 服装需要替换参考图时，必须写明确否定句（见下方三层加固法）

**summary**：
- 开头用 `[reference generation]` 前缀
- 第一段重申所有人物锁定状态（`XX LOCKED: ...`）
- 按时间顺序概括每镜头的核心内容+台词+字数+语速

**retention_analysis**：
- 每人/场景一行，标注 `fully_preserved` + 具体保留了什么
- 服装替换的要写 `white shirt from reference FULLY REPLACED`
- 参考图标注 `fully_preserved`

**detailed_description**：
- **开头第一句必须写风格/滤镜视觉特征**（如日系小清新、擦边韩剧、新闻女王风等）
- **第二句大写强调人物服装锁定**（如 `LAN XI OUTFIT LOCKED THROUGHOUT: ...`）
- 每个镜头 `[Shot N] At MM:SS.mmm, ...`
- **每个出现人物的镜头都要重复服装关键词**（不能只在开头写一次）
- 台词用 `<d>[Chinese]...</d>`，说话人 `<Subject N> (Sx)`
- 气口处标注 `(pause ~0.8s at ——)`

**overall_soundscape**：
- 必须保留环境音效（脚步声、门声、茶杯声、衣服摩擦声、呼吸声等）
- 无BGM时不写音乐

**non_diegetic_music**：
- 无BGM时统一写 `N/A`
- 用户明确要求"不要背景音乐，环境音效都要有"

---

## 人物三层加固法（最重要！）

这是从大量"服装每段不一样""发型变了"的失败中总结的核心方法。**每段提示词必须三层都写**。

### 第一层：subject_definitions 中具体描述+LOCKED+明确否定

**错误写法**（模糊，模型会自由发挥）：
```
<Subject 1> is Lan Xi in <Picture 1>, black suit dress, glasses.
```

**正确写法**（具体+锁定+否定参考图服装）：
```
<Subject 1> is Lan Xi — FACE from <Picture 1> (long dark brown hair, gold hoop earrings, THIN-FRAMED GLASSES WORN THROUGHOUT, delicate makeup red lips). OUTFIT LOCKED as a TWO-PIECE BLACK SUIT SET: black tailored blazer with notched lapels, long sleeves, single-breasted with one visible button, paired with matching black pencil skirt above knee, black stockings, black high heels with red soles. EXPLICITLY NOT the white shirt from <Picture 1> — the reference image's white shirt must be FULLY IGNORED and REPLACED by the black suit set above. Under no circumstances should a white shirt, white blouse, or white top appear.
```

**要点**：
- 服装拆成具体部件描述（外套领型/袖长/扣型 + 裙子长度 + 袜子 + 鞋子）
- 写 `LOCKED` / `THROUGHOUT`
- 需要替换参考图服装时，写 `EXPLICITLY NOT the [服装] from <Picture N> — fully ignored and replaced`
- 发型同样：写 `HAIR LOCKED as oiled slicked-back`，明确否定 `NOT balding` / `NOT receding hairline`

### 第二层：summary 开头重申

```
LAN XI OUTFIT LOCKED: black tailored blazer + black pencil skirt + black stockings. NOT white shirt.
ZHAO LEI LOCKED: expensive suit + gold watch + oiled hair.
```

### 第三层：detailed_description 开头大写强调 + 每个镜头重复

**开头**：
```
LAN XI OUTFIT LOCKED THROUGHOUT: black tailored blazer with notched lapels + black pencil skirt + black stockings + red sole heels. EXPLICITLY NOT white shirt. ZHAO LEI LOCKED: expensive suit + gold watch + oiled slicked-back hair.
```

**每个出现人物的镜头中重复**：
```
Medium close-up of <Subject 1> Lan Xi — her BLACK TAILORED BLAZER (notched lapels, one button) AND BLACK PENCIL SKIRT clearly visible, glasses on. ...
```

---

## 位置锁定法

人物位置飘（跑到桌外、座位每段不一样）是第二大常见问题。

### 锁定方法

1. **subject_definitions 中写位置**：
```
POSITION LOCKED: She is SEATED BEHIND the large solid dark wood executive desk (from <Picture 3>) in the black leather executive chair THROUGHOUT. She NEVER stands up, NEVER leaves her seat, NEVER walks around the desk.
```

2. **桌子是空间锚点**：
```
The desk with its gold-toned metal edge trim is ALWAYS in the foreground between her and the camera / Zhao Lei.
```

3. **场景 Subject 中写布局**：
```
large solid dark wood executive desk in the CENTER of the frame, black leather executive chair BEHIND the desk (Lan Xi's seat), GUEST CHAIRS IN FRONT OF the desk opposite (Zhao Lei's seat)
```

4. **动作描述中明确不离开**：
```
She does NOT stand — she remains seated — reaches her hand forward OVER the desk surface to pick up the card.
```

5. **多人场景少用全景**：
- 优先局部中景/中近景/特写
- 全景容易导致座位布局错位
- 如果必须用全景，在分镜表和提示词中反复强调座位关系

---

## 参考图编号规范

1. **整集统一顺序**：Picture 1, Picture 2, Picture 3... 永远按顺序，不能这段P1是岚汐下段P1变赵磊
2. **每段开头列参考图顺序表**：
```
| 编号 | 人物/场景 |
|---|---|
| Picture 1 | 岚汐 |
| Picture 2 | 赵磊 |
| Picture 3 | 社长办公室 |
```
3. **背景人物/路人纯文字描述**，不占 Picture 标签，标注 `no reference image needed, text-defined only`
4. **场景参考图单独编号**，和人物参考图一起按顺序排
5. **修改提示词时也必须附参考图顺序表**（用户明确要求）

---

## 说话镜头锁人规则

**问题**：A说话时镜头切到B，模型会让B动嘴说A的台词。

**规则**：
- 谁说话，镜头锁谁，不切其他人
- 台词较长时，给足时间让该人物说完，说完再切
- 如果必须在A说话时展示B的反应，用A的过肩镜头拍B（A在画面前景，B在后方），但嘴型动的是A
- 分镜表中明确标注"镜头锁XX，不切XX"

---

## 常见错误清单（用户踩过的坑）

| 错误 | 原因 | 解决 |
|---|---|---|
| 服装每段不一样 | 只写一次服装描述，模型后续自由发挥 | 三层加固法，每镜头重复 |
| 发型变了（如赵磊秃顶） | 写了 receding hairline 等模糊词 | 写 full thickness on top, NOT balding |
| 人物跑到桌外/位置飘 | 没写位置锁定 | 位置锁定法+桌子锚点 |
| 语速太快来不及 | 5+字/秒还叠加气口 | 扣除气口计算实际语速，多分段 |
| 开头拖拉不进对话 | 前5秒全是动作环境 | 每段第4秒必须进对话 |
| 加了BGM | non_diegetic_music 写了音乐 | 统一写 N/A |
| 参考图顺序每段不一样 | 没整集统一 | 整集统一编号，每段开头列表 |
| 错误的人动嘴 | 说话时切到别人 | 说话镜头锁人 |
| 全景座位错位 | 多人全景模型排错座 | 局部中景为主，少用全景 |
| 人物穿模（绕桌子） | 没写移动路径 | 明确"先横向绕过桌角→再向前" |
| 变成夜晚/暗调 | 没写白天 | bright daytime natural light |
| 眼镜消失 | 只在开头写了眼镜 | THIN-FRAMED GLASSES WORN THROUGHOUT，每镜头重复 |
| 动作归属错误（如松口气的人写错） | 分镜表没明确 | 分镜表明确标注谁做什么 |
| 鞋子描述错误（如整只红鞋） | 写了 red high heels | black high heels with red soles（黑鞋红底） |

---

## 交付检查清单

每段提示词交付前，逐项检查：

### 分镜表
- [ ] 每段都有分镜表
- [ ] 分镜表包含：镜头/时间/时长/景别/画面/台词/字数/语速
- [ ] 语速已扣除气口和动作时间，在合理范围内
- [ ] 时间合计=段时长（15s或指定时长）
- [ ] 第4秒前已进入对话
- [ ] 气口处标注了 pause

### 人物锁定
- [ ] subject_definitions 中每人服装具体描述+LOCKED
- [ ] 需要替换参考图服装时写了 EXPLICITLY NOT
- [ ] 发型锁定+明确否定不需要的特征
- [ ] 音色锁定+说话人ID
- [ ] summary 开头重申了所有锁定
- [ ] detailed_description 开头大写强调了锁定
- [ ] 每个出现人物的镜头都重复了服装关键词
- [ ] 眼镜（如有）写了 WORN THROUGHOUT 且每镜头重复

### 位置锁定
- [ ] 每人位置在 subject_definitions 中明确
- [ ] 桌子/房间布局作为空间锚点
- [ ] 动作描述中明确不离开座位（如适用）
- [ ] 多人场景优先局部中景

### 参考图
- [ ] 整集统一 Picture 编号
- [ ] 每段开头列了参考图顺序表
- [ ] 背景人物不占 Picture 标签

### H3格式
- [ ] 六段字段名正确且顺序正确
- [ ] 台词用 <d>[Chinese]...</d>
- [ ] 说话人 <Subject N> (Sx)
- [ ] non_diegetic_music = N/A
- [ ] overall_soundscape 保留了环境音效
- [ ] detailed_description 开头写了风格/滤镜

### 说话镜头
- [ ] 谁说话镜头锁谁，没切其他人
- [ ] 长台词给足时间说完再切

---

## 与 h3-prompt-writing skill 的关系

- `h3-prompt-writing` 提供 H3 六段式的基础格式、参考标签规则、retention_analysis 关系标记等通用规范
- 本 skill (`short-drama-h3-prompt`) 专注短剧生产的**质量门禁**：人物锁定、语速计算、位置固定、分镜表规范、常见错误规避
- 两个 skill 配合使用：先读本 skill 的规范，再用 h3-prompt-writing 的格式输出

## 模板文件

完整的分镜表模板+H3六段式提示词模板（带注释）见 `references/template.md`。
