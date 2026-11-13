# 短剧 H3 提示词模板（带注释）

本文件提供可直接复制使用的分镜表模板和 H3 六段式提示词模板。方括号 `[ ]` 中的内容为需要替换的变量。

---

## 一、分镜表模板

### 第N段（[起始时间]-[结束时间]s）：[本段标题]

#### 参考图顺序

| 编号 | 人物/场景 |
|---|---|
| Picture 1 | [人物A名称+一句话特征] |
| Picture 2 | [人物B名称+一句话特征] |
| Picture 3 | [场景名称+一句话特征] |

#### 分镜表

| 镜头 | 时间 | 时长 | 景别 | 画面 | 台词 | 字数 | 语速 |
|---|---|---|---|---|---|---|---|
| 1 | 0-[X]s | [X]s | [景别] | [具体画面描述：人物动作、表情、机位、运镜。注意：谁说话镜头锁谁] | [台词原文，无则写—] | [X]字 | [X]字/秒 |
| 2 | [X]-[Y]s | [Y-X]s | [景别] | [画面描述] | [台词] | [X]字 | [X]字/秒 |
| ... | ... | ... | ... | ... | ... | ... | ... |

**时间校验**：各镜头时长合计 = [段时长]s ✅
**语速校验**：实际语速 = 字数 ÷ (镜头时长 - 气口时长 - 纯动作时长)，在合理范围内 ✅
**节奏校验**：第4秒前已进入对话 ✅

---

## 二、H3 六段式提示词模板

```text
subject_definitions:
<Subject 1> is [人物A名称] — FACE from <Picture 1> ([面部特征：发型、眼睛、妆容、配饰]). OUTFIT LOCKED as [具体服装描述，拆成部件：外套领型+袖长+扣型+裙子/裤子+袜子+鞋子]. EXPLICITLY NOT the [参考图中不需要的服装] from <Picture 1> — the reference image's [不需要的服装] must be FULLY IGNORED and REPLACED by the [锁定服装] above. Under no circumstances should [禁止出现的服装] appear. POSITION LOCKED: [具体位置：SEATED BEHIND the desk in black leather chair / stands near window / etc.]. [如果需要：She NEVER stands up, NEVER leaves her seat.] [音色描述，low magnetic female voice / clear young male voice / etc.]. (S1)
<Subject 2> is [人物B名称] — FACE from <Picture 2> ([面部特征]). HAIR LOCKED as [具体发型，如 oiled slicked-back / short neat black hair with full thickness on top, NOT balding]. OUTFIT LOCKED as [具体服装]. [配饰，如 gold wristwatch at cuff]. POSITION LOCKED: [具体位置]. [音色]. (S2)
<Subject 3> is the [场景名称] in <Picture 3>: [关键空间元素列表，注意写清桌子/椅子/门窗/光线的位置关系]. The [核心空间锚点，如 large dark wood desk] is the central spatial reference, separating [人物A] (behind/left) from [人物B] (in front/right). [时间光线：bright daytime natural light / warm evening light / etc.]
<Picture 1> ref <Subject 1>'s face. <Picture 2> ref <Subject 2>'s face. <Picture 3> ref <Subject 3>.
[如果有背景路人：Background colleagues are text-defined only, no reference image needed, do not occupy Subject or Picture labels.]

summary:
[reference generation] [段时长]s [本段标题]. [人物A] LOCKED: [服装简述]. NOT [参考图不需要的服装]. [人物B] LOCKED: [服装简述]+[发型简述]. [位置简述：The dark wood desk is always between them.] [按时间顺序概括每镜头：] [起始]-[结束]s: [镜头1核心动作+台词(字数, 语速)] [起始]-[结束]s: [镜头2...] ...

retention_analysis:
<Subject 1> (appears in [Shot X, Shot Y]): fully_preserved - face from <Picture 1>; OUTFIT FULLY PRESERVED as [服装简述]; [参考图不需要的服装] FULLY REPLACED; [发型/眼镜/配饰] fully preserved; POSITION FULLY PRESERVED as [位置简述]; [动作/情绪] new.
<Subject 2> (appears in [Shot X]): fully_preserved - face from <Picture 2>; [服装+发型] fully preserved; [位置] preserved.
<Subject 3> (all shots): fully_preserved - [场景简述], spatial layout consistent throughout.
<Picture 1-3>: fully_preserved.

detailed_description:
The target video is in [滤镜/风格名称] style. Visual characteristics: [具体视觉特征：soft diffused natural window light, low contrast with gentle highlight roll-off, slightly desaturated warm pale palette, subtle fine film grain, natural realistic skin, soft creamy bokeh, clean healing atmosphere / 或其他风格的具体特征].
[人物A] OUTFIT LOCKED THROUGHOUT: [服装简述]. EXPLICITLY NOT [不需要的服装]. [人物B] LOCKED: [服装+发型]. [位置锁定重申].
[Shot 1] [景别]. [具体画面描述，注意：<Subject 1> 的 [服装关键词] clearly visible, [眼镜/配饰] on. [动作描述]. [如果说话：<Subject 1> (S1) says, [语速]字/秒, <d>[Chinese] 台词原文。</d> [如果有气口：(pause ~0.8s at ——)]]
[Shot 2] At 00:0[X].000, [景别]. [画面描述，<Subject 2> 的 [服装关键词] clearly visible. [动作]. [台词].]
...
[最后一个镜头以画面收尾描述结束，不要写"segment ends"之外的多余内容]

overall_soundscape:
[环境音描述，按镜头顺序：soft office ambient hum throughout. Shot 1: [具体音效]. Shot 2: [具体音效]. ... 注意：无BGM，只写环境音和人物说话声]

non_diegetic_music:
N/A
```

---

## 三、气口与语速计算示例

### 错误示例

```
台词："所以你在这干了八年都没做成的事，一个新人七天做成了。赵磊——废物到哪都一样。"
字数：34字
镜头时长：8s
错误语速：34 ÷ 8 = 4.25字/秒 ← 错！没扣气口
```

### 正确示例

```
台词："所以你在这干了八年都没做成的事，一个新人七天做成了。赵磊——废物到哪都一样。"
字数：34字
气口："——" 处停顿约0.8s
纯动作：0s（说话时无大动作）
实际说话时间：8 - 0.8 = 7.2s
正确语速：34 ÷ 7.2 = 4.7字/秒 ✅
提示词中标注：4.7字/秒 with pause at "——", (pause ~0.8s at ——, letting "赵磊" hang like verdict, then delivers...)
```

### 多气口示例

```
台词："你这个人——郑总说了，只要你愿意谈，什么条件都好说。"
字数：22字
气口：1个"——" = 0.8s
镜头时长：5s
实际说话时间：5 - 0.8 = 4.2s
语速：22 ÷ 4.2 = 5.2字/秒 ✅（轻佻语气可接受）
```

---

## 四、人物锁定描述速查

### 女社长（高冷气场型）

```
FACE from <Picture 1> (long dark brown hair, gold hoop earrings, THIN-FRAMED GLASSES WORN THROUGHOUT, delicate makeup red lips)
OUTFIT LOCKED: black tailored blazer with notched lapels, long sleeves, single-breasted with one visible button, paired with matching black pencil skirt above knee, black stockings, black high heels with red soles
VOICE: low magnetic female voice, deep resonant, 2.5-4字/秒 calm
POSITION: SEATED BEHIND large solid dark wood executive desk in black leather chair, NEVER stands (unless剧情要求)
```

### 年轻男主（清瘦型）

```
FACE from <Picture 2> (short neat black hair, clean eyebrows, bright eyes, lean build)
OUTFIT LOCKED: brand-new but cheap dark suit, white shirt, stitching at cuffs visibly uneven
VOICE: clear bright young male voice
```

### 中年反派（油滑型）

```
FACE from <Picture 3> (35-40yo, thick eyebrows)
HAIR LOCKED: short neat black hair, SLICKED/OILED BACK, full thickness on top, NOT balding
OUTFIT LOCKED: expensive new designer suit (premium fabric), gold wristwatch visible at cuff, polished leather shoes
VOICE: smug then furious, 4-6字/秒
```

### 秘书（干练型）

```
FACE from <Picture 4> (brown bob hair with air bangs, bright eyes, warm smile)
OUTFIT LOCKED: light beige blazer over white shirt
VOICE: crisp efficient female voice
```

---

## 五、滤镜风格速查

### 日系真人小清新

```
soft diffused natural window light, low contrast with gentle highlight roll-off, slightly desaturated warm pale palette (cream, light wood, soft beige, muted greens), subtle fine film grain, natural realistic skin with translucency (not over-smoothed), soft creamy bokeh, clean healing atmosphere, slight backlight halo around hair
```

### 擦边韩剧

```
warm golden-hour indoor lighting, high contrast with deep shadows, saturated warm tones (amber, burgundy, deep brown), glossy skin with subtle highlight, sharp focus on subject with creamy bokeh background, sensual intimate atmosphere, slight film grain, moody and glamorous
```

### 新闻女王2（职场商战）

```
cool-toned professional lighting, high contrast with sharp shadows, desaturated blue-gray palette with warm accent lighting, clean sharp focus, realistic skin texture, modern corporate atmosphere, crisp and polished, slight cinematic teal-orange grade
```

---

## 六、POV 第一人称模板要点

如果是第一人称POV（男友视角/员工视角）：

1. **subject_definitions 中加 POV 说明**：
```
<Subject N> is the POV camera perspective — the camera IS the [角色]'s eyes/face. [角色]'s hand may enter the frame to interact. The camera has subtle handheld breathing shake.
```

2. **detailed_description 开头写**：
```
The target video is a first-person POV ([角色]'s perspective) vertical 9:16 short video, with SUBTLE HANDHELD BREATHING CAMERA SHAKE throughout — natural organic micro-movements, slight up-down breathing rhythm, never perfectly locked-off.
```

3. **互动描写**：
```
The boyfriend's MALE HAND enters the frame from the bottom — reaches forward — grabs her ankle — thumb strokes her instep.
```

4. **被互动时镜头反应**：
```
The camera SHAKES slightly from her movement / the kick / the hug.
```

5. **女主直视镜头**：
```
She looks DIRECTLY into the lens — into the boyfriend's eyes.
```
