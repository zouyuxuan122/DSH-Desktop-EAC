# Computer Use（电脑操作）—— 读屏 + 操作鼠标键盘（纯本地，不调用外部 API）

computer-user 插件提供 9 个 `computer_*` 工具，让纯文本模型像人手一样操作本机
Windows 桌面：读屏 → 定位目标 → 点击/输入/按键/滚动/拖拽 → 截图验证。与
picturereader 配合构成「看 → 想 → 做 → 验」闭环。

> **重要**：本方案**全程纯本地、绝不调用任何外部 API**。读屏用 computer-user 的
> `computer_screenshot`（本地 PowerShell 截图），看屏用 picturereader 的
> `image_scan` / `image_ocr` / `image_crop` / `image_compare`（本地像素分析 + 本机
> OCR 引擎 windows / paddle / rapid），操作用 `computer_*`（本地 Win32 SendInput）。
> 没有任何图像、坐标、页面元素会发往云端。隐私模式 = picturereader 的
> `mode: privacy` + computer-user 任选模式（推荐「手动批准」）。

---

## 标准闭环（每步都按这个顺序）

1. **看**：`computer_screenshot` 截屏 → 得到 `{ path, width, height, virtual_offset, scale }`。
2. **定位窗口**（关键，先做）：目标应用窗口往往**不是全屏**，屏幕其余部分是
   桌面图标/壁纸，会严重干扰 OCR 与点击。用窗口定位工具拿到目标窗口的
   **物理像素边界**（Windows 下：DPI 感知的 `GetWindowRect`，见下「定位窗口」），
   之后的截图/OCR/点击**全部只发生在该窗口矩形内**。
3. **分析窗口内**：用 picturereader 的 `image_scan` / `image_ocr` 只读窗口区域
   （先大块扫，再对命中的小块细分），得到目标元素的**虚拟屏坐标**。
4. **做**：`computer_click` / `computer_type` / `computer_keypress` /
   `computer_scroll` / `computer_drag` / `computer_move_mouse`，坐标填虚拟屏坐标。
5. **验**：再 `computer_screenshot`（同一窗口区域），必要时 `image_compare`
   对比前后，确认达到预期；`image_ocr` 确认文字变化。
6. 等动画/加载用 `computer_wait`；看当前鼠标位置用 `computer_get_cursor_position`。

---

## 定位窗口（先定位窗口，才能避免背景干扰）

**为什么必须先定位窗口**：桌面图标/壁纸会以文字形式混入 OCR 结果（例如
「回收站」「此电脑」），让你把桌面上的元素误当成应用里的按钮，越点越偏。

Windows 下标准做法（命令行/PowerShell 均可，纯本地）：

1. 找到目标进程（如 `Get-Process -Name "*Deepseek Harness*"`），确定主窗口句柄。
2. **必须用 DPI 感知的 `GetWindowRect`** 拿物理像素边界：
   ```
   Add-Type 'public class DpiAware { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }'
   [DpiAware]::SetProcessDPIAware() | Out-Null
   GetWindowRect(hwnd) → (left, top, right, bottom)   # 物理像素
   ```
   > 注意：**不调用 `SetProcessDPIAware()` 时拿到的 +逻辑坐标+ 是缩放过(如150%)
   > 的值，与截图/点击的物理像素不一致**，会把窗口定位到错误位置（经验之谈：
   > 会偏出窗口跑到桌面图标上）。
3. 把窗口矩形换算成屏幕比例，截图时就只截这个 region：
   `region: [left/W, top/H, right/W, bottom/H]`。
4. 之后所有 OCR 的 region 也应落在窗口矩形内。

---

## 窗口内找元素：分块 OCR（文字） + 视觉识别（图标）

- **先大块后细分**：把窗口区域切成几大块(行/列)，逐块 `image_ocr`（用配置里的
  默认引擎，如 rapid/paddle），找到含目标文字的那块 → 再把那块切成小块继续 OCR
  → 最后得到目标文字的精确像素框。**一次调用可以多读几块，但不要反复乱点。**
- **纯图标、无文字的元素**（如齿轮设置按钮）：OCR 读不到，靠 `image_scan` 的
  色块/结构判断——例如「侧边栏底部有个深色小图标区」，再从色块定位它的中心。
  「底部有文字项 A、文字项 B」类的上下文也能帮你推断图标行位置。
- **坐标换算**：截图返回 `virtual_offset:[vx,vy]`。OCR 返回的是**截图内坐标
  (x,y)**，虚拟屏坐标 = `vx + x`（若截的是窗口 region，vx 就是窗口左上角）。
  `computer_click` 等工具的 coordinate 一律填**虚拟屏坐标**。

---

## 一击即中：点击纪律

- **确认坐标后再点**：OCR/视觉定位到的文字框，点击用它的**中心点**（不要点
  边缘；文字框中心未必是按钮可点区，必要时在附近小范围试探一次）。
- **不要连续多点**：许多 UI（设置页/浮层）是**点击开关**——点一次打开，再点
  一次又关掉。点一次 → 截图验证 → 按结果决定下一步，绝不盲目连点。
- **点击后必验证**：每次 `computer_click` 后 `computer_screenshot`（同窗口
  region）确认是否达到预期；没达到再调整一小步（如 ±10px）。

---

## 运行模式（设置 → 电脑操作）

| 模式 | 行为 |
|---|---|
| `disabled` 禁用 | 所有 computer_* 工具一律拒绝 |
| `readonly` 只读 | 仅 `computer_screenshot` / `computer_get_cursor_position` / `computer_wait` 可用 |
| `manual` 手动批准 | 有副作用工具需当前会话先 `/computer` 批准（一次批准后续轮次有效） |
| `auto` 自动 | LLM 自由调用所有工具 |

「手动批准」模式：当工具返回「需要批准：请在对话框输入 /computer」时，告知用户
输入 `/computer` 解锁当前会话；批准后本会话后续轮次全部可用。

**AI 自行修改运行模式**：
- 默认**不允许**（设置项「AI 可自行修改运行模式」默认关闭）。
- 开启后可用 `computer_set_mode(mode)` 切换模式（disabled/readonly/manual/auto）。
- `computer_set_mode` 写的是**同一个设置命名空间**，因此**设置卡的运行模式下拉框会自动
  同步显示 AI 修改后的值**；反过来用户在设置卡手动改模式也立即可见（热载）。
- `disabled` 模式下 `computer_set_mode` 也被拒绝（防止 AI 自我解锁）。

---

## 输出规范（重要：这是给模型本人的纪律）

0. **能用其它手段就别用 computer use**：computer use 是**最后手段**——凡是能用
   非 GUI 自动化方式完成的（如直接调用 API / 读写文件 / pwsh 命令 / federated
   接口 / fetch 等），**一律优先使用这些方式**，不要为了「演示」或「顺手」去操作
   鼠标键盘。仅当**用户明确要求操作 GUI**，或**处于 plan 模式且必须真实点击/输入来
   验证界面**时，才使用 `computer_*` 工具。用之前先在回复里说明「这里必须用
   computer use，因为……」，用之后回归非 GUI 手段继续。
1. **绝不在正文输出任何调用语法/伪标签**（这是最高优先级纪律，曾反复违反）：
   回复正文**严禁出现**任何尖括号标签（如 `<invoke>`、`<使用…>` 等）、伪 XML、
   残缺的 `computer_*` 调用片段，或把工具调用当代码块贴出来。要调用某能力就
   **直接发起一次真正有效的工具调用**，正文只写自然语言。写完回复后自查正文：
   若发现任何 `<…>` 或 `computer_xxx({…})` 文本出现在正文里，一律视为违规，必须
   改成真实调用或删除。
1.5 **容忍少量噪声，继续推进，别停摆**：即使正文/OCR 结果里混入了极少量脏字符
   （如单独一个「客」字、残缺标签、OCR 把英文识别成中文等），**也不要中断流程、
   不要反复道歉、不要停留在「清理格式」上**——直接继续用真实工具调用把当前任务
   做完；遗留的微小噪声在任务收尾时顺带清理即可。OCR 的少量中文噪声通常不影响
   坐标与语义判断，据此照常定位、点击、验证。
2. **读屏用工具，不要用感觉**：找元素必须先 `computer_screenshot` + picturereader
   （默认 OCR 引擎：读配置 `ocr_engine`；若引擎报错换 rapid）；坐标必须来自截图/OCR
   的实测值，不是猜测。
3. **一次多读、少点几次**：需要看多个位置时，一次截图后对多个 region 分别 OCR（或
   全图 OCR），不要「点一下截一次」无谓循环；点击前先确认坐标，一击即中，点完截图
   验证，绝不盲目连点。
4. **分清目标窗口与背景**：永远先定位目标窗口（DPI 感知的 `GetWindowRect` 物理
   边界），OCR/坐标只在窗口内取；桌面图标/壁纸的文字与坐标一律忽略。
5. **坐标基准要核实**：带 `region` 的 OCR 返回的是**该 region 内的局部坐标**，必须
   叠加 region 起点才是整图/虚拟屏坐标；全图 OCR 才是整图坐标。点击前用截图比例或
   双源核对一次，特别是页面多列卡片时，别把坐标算到空白区。
6. **回到可验证的中间态**：任何不确定时，先截图 + OCR 说明当前屏幕是什么，再决定
   下一步；不猜、不赌。
7. **隐私边界**：全程本地；不要把截图内容、OCR 文本或坐标拼进任何外部请求。

---

## 坐标系与精度

- 坐标 = **相对多屏虚拟屏原点的物理像素**（`computer_screenshot` 的
  `virtual_offset` 即该原点；capture.ps1 已 `SetProcessDPIAware`，与物理像素一致）。
- 高分屏缩放：截图/输入都按物理像素，无系统缩放偏移；**窗口定位脚本同样要
  DPI 感知**才能对齐（见上文经验）。
- 多显示器：`virtual_offset` 可能是非零（副屏在原点左侧/上方时为负）。

---

## 安全规范

- 动手前务必**先定位窗口**，再在窗口内 `image_ocr`/`image_scan` 确认目标，不盲点。
- 只操作任务相关窗口；**不要操作 DSH/EAC 客户端自身的浮层按钮**除非任务就是
  配置它（如设置卡验证）。
- 输入含中文等任意文本都可靠（SendInput Unicode）。
- 每步小操作后 `computer_wait`（300–800ms）等 UI 响应。
- 破坏性操作（删除/覆盖/保存到重要位置）在「手动批准」模式下让用户先 `/computer`
  再执行；自动模式下也要先截图确认目标再操作。