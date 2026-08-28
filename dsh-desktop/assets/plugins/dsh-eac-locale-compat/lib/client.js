window.__ModuleLoader__.load({
  id: 'dsh-eac-locale-compat',
  factory: () => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const ORIGINAL_TEXT = Symbol('dshEacOriginalText')
    const TRANSLATED_TEXT = Symbol('dshEacTranslatedText')
    const ORIGINAL_ATTRIBUTES = Symbol('dshEacOriginalAttributes')
    const TRANSLATED_ATTRIBUTES = Symbol('dshEacTranslatedAttributes')
    const TRANSLATABLE_ATTRIBUTES = ['aria-label', 'aria-description', 'placeholder', 'title']
    const EXCLUDED_SELECTOR = [
      'code', 'pre', 'kbd', 'samp', 'textarea', '[contenteditable="true"]',
      '[data-language]', '[data-code-block]', '.cm-editor', '.xterm',
      '[data-chat-flow-kind]', '[data-message-id]', '[data-role="message"]',
      '.dss-msg', '.dss-chip',
    ].join(',')

    // Longest phrases win. Short entries at the end also cover status text that
    // combines a fixed label with a runtime value supplied by an older plugin.
    const ENGLISH_PHRASES = Object.freeze([
      ['本轮费用按 token 用量估算；未读取到 DeepSeek API Key，无法显示余额', 'Turn cost is estimated from token usage. Balance is unavailable because no DeepSeek API key was found.'],
      ['（UTC+8）为高峰价，其余为空闲价（半价）。可在设置 pricing.peakWindows 调整。', '(UTC+8) uses peak pricing; all other hours use half-price off-peak rates. Adjust this under pricing.peakWindows.'],
      ['自定义价格覆盖官方默认档（仅影响本机费用估算显示，单位：¥/百万 token）。', 'Custom prices override official defaults for local cost estimates only (CNY per million tokens).'],
      ['价格设置桥接不可用（请确认已更新到最新版 DSH Desktop）', 'Pricing settings bridge unavailable. Update to the latest DSH Desktop.'],
      ['价格必须是 0~1000 的数字', 'Price must be a number from 0 to 1000.'],
      ['已保存，费用估算已更新', 'Saved. Cost estimates were updated.'],
      ['已恢复默认价格', 'Default prices restored.'],
      ['正在加载模型列表…', 'Loading model list...'],
      ['本轮 ¥', 'Turn CNY '],
      ['余额 ¥', 'Balance CNY '],
      ['高峰时段 ', 'Peak hours '],
      ['未命中缓存', 'Cache miss'],
      ['命中缓存', 'Cache hit'],
      ['高峰价', 'Peak rate'],
      ['空闲价', 'Off-peak rate'],
      ['价格设置', 'Pricing settings'],
      ['恢复默认', 'Restore defaults'],
      ['处理中…', 'Processing...'],
      ['读取失败', 'Read failed'],
      ['恢复失败', 'Restore failed'],
      ['本会话中 agent 用 write/edit 等文件工具修改过的文件会显示在这里（支持还原）；通过代码执行类工具（run_code/pwsh/bash）改的文件无法生成 diff，不会出现在此。', 'Files changed by agent file tools such as write/edit appear here and can be restored. Changes made through run_code, pwsh, or bash cannot produce a diff and are not listed.'],
      ['文件已被后续修改，无法自动还原（可手工处理）。', 'The file changed again and cannot be restored automatically. Resolve it manually.'],
      ['也可以切到「全部文件」浏览项目目录。', 'Switch to All files to browse the project directory.'],
      ['当前会话没有项目目录。', 'The current session has no project directory.'],
      ['暂无文件更改记录', 'No file changes recorded'],
      ['站内预览此文件', 'Preview this file in the app'],
      ['还原此文件的全部变更', 'Restore all changes to this file'],
      ['本机回环监听端口（点击预览）', 'Local loopback port (select to preview)'],
      ['回到项目根目录', 'Return to project root'],
      ['重新探测端口', 'Detect ports again'],
      ['本会话修改过', 'Changed in this session'],
      ['本会话修改', 'Session changes'],
      ['全部文件', 'All files'],
      ['站内预览', 'In-app preview'],
      ['文件已删除', 'File deleted'],
      ['已还原', 'Restored'],
      ['还原失败：', 'Restore failed: '],
      ['还原', 'Restore'],
      ['新建', 'Created'],
      ['修改', 'Modified'],
      ['预览', 'Preview'],
      ['拖动调整宽度', 'Drag to resize'],
      ['后退', 'Back'],
      ['前进', 'Forward'],
      ['在外部打开', 'Open externally'],
      ['关闭预览', 'Close preview'],
      ['未加载', 'Not loaded'],
      ['在线 · HTTP ', 'Online · HTTP '],
      ['离线 · ', 'Offline · '],
      ['连接失败', 'Connection failed'],
      ['已加载 · ', 'Loaded · '],
      ['上级目录', 'Parent directory'],
      ['（已截断）', '(truncated)'],
      ['投影诊断: ', 'Projection diagnostics: '],
      ['undefined（投影未返回）', 'undefined (projection returned no value)'],
      ['文件', 'Files'],
      ['大肥鱼桌面伴侣', 'Dafeiyu desktop companion'],
      ['入口和状态属于 DSH，鱼始终显示在 Windows 桌面最上层。', 'DSH owns the controls and status. The companion stays above the Windows desktop.'],
      ['大肥鱼设置尚未连接到 DSH Host。', 'Dafeiyu settings are not connected to the DSH host.'],
      ['关闭后立即退出；重新开启无需单独启动程序。', 'The companion exits immediately when disabled and starts automatically when enabled again.'],
      ['控制空闲时微动作的出现频率。', 'Controls how often idle animations occur.'],
      ['减少走动、循环帧和程序化晃动。', 'Reduce walking, looping frames, and procedural movement.'],
      ['默认只跟随顶层任务，避免状态过度跳动。', 'Follow top-level tasks only by default to avoid excessive status changes.'],
      ['启用大肥鱼', 'Enable Dafeiyu'],
      ['角色大小', 'Character size'],
      ['活跃程度', 'Activity level'],
      ['安静', 'Quiet'],
      ['标准', 'Standard'],
      ['活泼', 'Lively'],
      ['减少动态效果', 'Reduce motion'],
      ['响应子 Agent', 'React to subagents'],
      ['正在读取设置…', 'Reading settings...'],
      ['正在保存…', 'Saving...'],
      ['默认关闭；开启后写入插件配置，重启应用生效。可随时在此或「插件 → 管理」停用。', 'Disabled by default. Enabling writes the plugin configuration and takes effect after an app restart. Disable it here or under Plugins > Manage.'],
      ['DSH 界面右下角的 DeepSeek 余额挂件：余额 / 今日已用 / 每轮对话消耗统计（依赖 DEEPSEEK_API_KEY 凭据）。', 'DeepSeek balance widget at the lower right of DSH: balance, daily usage, and per-turn cost (requires DEEPSEEK_API_KEY).'],
      ['把一个会话变成「队长 + 子代理成员 + 依赖感知任务 DAG + 成员直发消息」的协作团队；启用后在对话里使用 /agent-teams。', 'Turn a session into a team with a lead, subagents, a dependency-aware task DAG, and direct member messages. Use /agent-teams after enabling.'],
      ['开启并重启后，小鲸鱼余额挂件固定显示在会话页面右下角（图标+余额/今日已用）；随时可回本分区或「插件 → 管理」停用。', 'After enabling and restarting, the balance widget appears at the lower right of sessions. Disable it here or under Plugins > Manage.'],
      ['启用并重启后，在对话输入框输入 /agent-teams 打开团队面板：安排子代理成员、分配依赖感知的任务 DAG、成员之间直发消息；不需要时同样可以在此停用。', 'After enabling and restarting, enter /agent-teams in the composer to open the team panel, arrange subagents, assign dependency-aware tasks, and message members directly.'],
      ['插件管理桥不可用（请在 Tauri 桌面壳中使用）', 'Plugin management bridge unavailable. Use the Tauri desktop app.'],
      ['读取状态失败: ', 'Could not read status: '],
      ['已启用：重启应用后生效', 'Enabled. Restart the app to apply.'],
      ['已停用：重启应用后生效', 'Disabled. Restart the app to apply.'],
      ['重启 Web 服务立即生效', 'Restart the web service to apply now'],
      ['余额小鲸鱼', 'Balance widget'],
      ['AgentTeams 多智能体团队', 'AgentTeams multi-agent team'],
      ['多智能体协作团队', 'Multi-agent team'],
      ['正在读取状态…', 'Reading status...'],
      ['余额', 'Balance'],
      ['该模型不在 V4 Flash/Pro 调价表内，高峰时段价格仍可能偏高。', 'This model is not in the V4 Flash/Pro rate table. Peak-hour pricing may still be higher.'],
      ['当前模型非 DeepSeek 平台，价格不受峰谷定价影响。', 'The current model is not on the DeepSeek platform, so peak/off-peak pricing does not apply.'],
      ['关闭（不发送，消息保留在输入框）', 'Close without sending; keep the message in the composer'],
      ['建议定时到 18:00 后或 0:00–8:00 执行，价格减半。', 'Schedule after 18:00 or between 00:00 and 08:00 for half-price rates.'],
      ['该模型不在 V4 Flash/Pro 调价表内，高峰时段价格仍可能偏高。', 'This model is not in the V4 Flash/Pro rate table. Peak-hour pricing may still be higher.'],
      ['本条命令已被拦截，尚未发送。', 'This request was blocked and has not been sent.'],
      ['无法确定当前会话，定时失败', 'Could not identify the current session. Scheduling failed.'],
      ['⚡ 高峰时段 · 已拦截发送', 'Peak hours · Send blocked'],
      ['⚡ 高峰时段 · 价格提醒', 'Peak hours · Pricing notice'],
      ['输入（缓存未命中）', 'Input (cache miss)'],
      ['输入（缓存命中）', 'Input (cache hit)'],
      ['当前模型：', 'Current model: '],
      ['现在为北京时间 ', 'Beijing time is '],
      ['，处于高峰时段（', ', currently within peak hours ('],
      ['），价格较高。', '), when rates are higher.'],
      ['本条命令：', 'Request: '],
      ['继续执行', 'Continue now'],
      ['定时执行', 'Schedule'],
      ['今日不再提醒', 'Do not remind me again today'],
      ['确认定时', 'Confirm schedule'],
      ['无可选时间', 'No available time'],
      ['✓ 已定时：', 'Scheduled: '],
      [' 自动执行', ' automatic execution'],
      ['定时失败：', 'Scheduling failed: '],
      ['计费项', 'Billing item'],
      ['闲时价', 'Off-peak rate'],
      ['/百万', '/million'],
      ['小时', 'Hours'],
      ['分钟', 'Minutes'],
      ['返回', 'Back'],
      ['（空）', '(empty)'],
      ['未知', 'Unknown'],
      ['微信 ClawBot / 网关 → DSH 会话桥接', 'WeChat ClawBot / gateway to DSH session bridge'],
      ['形如 provider/model（如 deepseek-official/deepseek-v4-pro）；留空 = 使用 DSH 默认模型', 'Use provider/model, for example deepseek-official/deepseek-v4-pro. Leave blank to use the DSH default model.'],
      ['留空保存 = 保持现状（回环地址访问无需 Token）', 'Save blank to keep the current value. Loopback access does not require a token.'],
      ['绝对路径，如 C:\\Users\\you\\Desktop\\work；留空 = 隔离的桥接工作区', 'Absolute path, such as C:\\Users\\you\\Desktop\\work. Leave blank for an isolated bridge workspace.'],
      ['逗号分隔的微信用户 id（xxx@im.wechat）；留空 = 允许所有发消息的人', 'Comma-separated WeChat user IDs (xxx@im.wechat). Leave blank to allow anyone who sends a message.'],
      ['填了它就改用这个端点（如 https://api.siliconflow.cn/v1）；留空 = 用上面的接收模型', 'Set this to use another endpoint, such as https://api.siliconflow.cn/v1. Leave blank to use the receiving model above.'],
      ['请用微信扫码绑定（ClawBot 插件里点绑定，扫这个码）：', 'Scan this QR code in WeChat to bind ClawBot:'],
      ['微信已扫码，请输入微信上显示的配对码：', 'QR code scanned. Enter the pairing code shown in WeChat:'],
      ['剩余约 X 小时（每 24h 需重扫）', 'About X hours remaining (scan again every 24 hours)'],
      ['微信工作目录（远程办公）', 'WeChat working directory (remote work)'],
      ['微信用户白名单', 'WeChat user allowlist'],
      ['第三方模型端点（OpenAI 兼容）', 'Third-party model endpoint (OpenAI compatible)'],
      ['该端点上的模型 id（如 deepseek-ai/DeepSeek-V3）', 'Model ID on this endpoint, such as deepseek-ai/DeepSeek-V3'],
      ['接入端点（OpenAI 兼容）：', 'Access endpoint (OpenAI compatible): '],
      ['微信连接（iLink 直连，不经 OpenClaw）', 'WeChat connection (direct iLink, without OpenClaw)'],
      ['会话已过期，请重新扫码', 'Session expired. Scan the QR code again.'],
      ['也可以点开链接绑定：', 'You can also open the link to bind: '],
      ['接收模型', 'Receiving model'],
      ['桥接 Token', 'Bridge token'],
      ['模型名', 'Model name'],
      ['未连接', 'Not connected'],
      ['正在生成二维码…', 'Generating QR code...'],
      ['已连接', 'Connected'],
      ['连接微信', 'Connect WeChat'],
      ['断开', 'Disconnect'],
      ['提交配对码', 'Submit pairing code'],
      ['数字配对码', 'Numeric pairing code'],
      ['（留空保持现状）', '(leave blank to keep current value)'],
      ['留空 = 隔离工作区', 'Blank = isolated workspace'],
      ['页面桌宠', 'In-app desktop pet'],
      ['显示在应用窗口内的桌宠；大小与位置在桌宠上的齿轮面板里调整。', 'A pet shown inside the app window. Adjust its size and position from its settings button.'],
      ['停用后窗口内不再显示；重启应用后生效。', 'When disabled, it no longer appears in the window. Restart the app to apply.'],
      ['始终显示在 Windows 桌面最上层，右键可隐藏、减少动态。', 'Always stays above the Windows desktop. Right-click to hide it or reduce motion.'],
      ['大肥鱼当前未启用。请在“插件 → 管理”启用 dsh-dafeiyu 后重启应用。', 'Dafeiyu is disabled. Enable dsh-dafeiyu under Plugins > Manage, then restart the app.'],
      ['启用页面桌宠', 'Enable in-app desktop pet'],
      ['空闲微动作频率', 'Idle animation frequency'],
      ['减少动态', 'Reduce motion'],
      ['右下角', 'Bottom right'],
      ['左下角', 'Bottom left'],
      ['右上角', 'Top right'],
      ['左上角', 'Top left'],
      ['自由位置（拖拽）', 'Free position (drag)'],
      ['搜索插件、点击分类标签过滤；配套/其他插件可一键关闭，「移除」为卸载语义（不再随启动同步），完全退出并重启 DSH Desktop 后生效。', 'Search plugins or filter by category. Companion and other plugins can be disabled. Remove uninstalls a plugin and stops startup synchronization; fully restart DSH Desktop to apply.'],
      ['移除后不再随启动同步（下次启动不还原）', 'Stop synchronizing this plugin at startup; it will not be restored next time.'],
      ['插件管理桥接不可用（请确认已更新到最新版 DSH Desktop）', 'Plugin management bridge unavailable. Update to the latest DSH Desktop.'],
      ['（清单来自本地文件，实时注册表暂不可用）', '(list loaded from local files; live registry unavailable)'],
      ['搜索插件（名称 / id / 描述）…', 'Search plugins (name / ID / description)...'],
      ['插件清单加载失败：', 'Could not load plugin list: '],
      ['没有匹配的插件', 'No matching plugins'],
      ['核心组件', 'Core components'],
      ['配套插件', 'Companion plugins'],
      ['其他插件', 'Other plugins'],
      ['不可关闭', 'Cannot be disabled'],
      ['可开关', 'Can be toggled'],
      ['（无描述）', '(no description)'],
      ['已关闭', 'Disabled'],
      ['已移除', 'Removed'],
      ['重启后生效', 'Applies after restart'],
      ['挂载失败', 'Mount failed'],
      ['加载中', 'Loading'],
      ['简洁', 'Compact'],
      ['全部', 'All'],
      ['管理', 'Manage'],
      ['自定义提示词', 'Custom prompt'],
      ['修改官方内核注入的系统提示词（应用到 standard 完整 Agent 基准预设）', 'Modify the system prompt injected by the official core for the standard full Agent baseline preset.'],
      ['关闭后回落为官方默认提示词', 'Use the official default prompt when disabled.'],
      ['替换整体（覆盖默认人设）', 'Replace all (override the default persona)'],
      ['追加到末尾（保留默认人设，在其后追加）', 'Append (keep the default persona and add content after it)'],
      ['按原样注入；可用 {{model}} 等占位符。建议包含对你的全面要求与项目约定。', 'Injected verbatim. Placeholders such as {{model}} are supported. Include your complete requirements and project conventions.'],
      ['渲染后的官方默认 system prompt（不含自定义节），供对照编辑。', 'Rendered official default system prompt without the custom section, for reference while editing.'],
      ['启用自定义提示词', 'Enable custom prompt'],
      ['注入方式', 'Injection mode'],
      ['提示词内容', 'Prompt content'],
      ['预览官方提示词', 'Preview official prompt'],
      ['预览加载失败', 'Could not load preview'],
      ['归档对话管理', 'Archived session management'],
      ['管理已归档的对话：可恢复（回到原工作区与顺序）或彻底删除（会话日志与附件一并移除，不可恢复）。删除运行中的会话会被拒绝。', 'Manage archived sessions. Restore them to their original workspace and order, or permanently delete their logs and attachments. Running sessions cannot be deleted.'],
      ['确定要彻底删除这个对话吗？会话日志与附件将一并移除，此操作不可恢复。', 'Permanently delete this session? Its logs and attachments will also be removed. This cannot be undone.'],
      ['该对话正在运行，无法删除：请先停止它再删除', 'This session is running. Stop it before deleting it.'],
      ['彻底删除该对话及其日志（不可恢复）', 'Permanently delete this session and its logs'],
      ['把该对话恢复到归档前的位置', 'Restore this session to its position before archiving'],
      ['暂无已归档的对话', 'No archived sessions'],
      ['设置不可用（需要在本机浏览器中打开）', 'Settings unavailable. Open this page in a local browser.'],
      ['删除对话', 'Delete session'],
      ['未知会话', 'Unknown session'],
      ['更新时间', 'Updated'],
      ['项目', 'Project'],
      ['已操作', 'Completed'],
      ['语言', 'Language'],
      ['权限', 'Permissions'],
      ['开发者', 'Developer'],
      ['实验', 'Experimental'],
      ['高级选项', 'Advanced options'],
      ['高级', 'Advanced'],
      ['模型', 'Models'],
      ['视觉', 'Vision'],
      ['迁移', 'Migration'],
      ['夺舍', 'Persona migration'],
      ['压缩', 'Compaction'],
      ['审核', 'Review'],
      ['快照', 'Snapshots'],
      ['提示词', 'Prompts'],
      ['思考强度', 'Reasoning effort'],
      ['归档', 'Archive'],
      ['当前会话没有项目目录，无法启动终端。', 'The current session has no project directory, so the terminal cannot start.'],
      ['无法建立连接：宿主路由 /dsh-files/term/events 无响应（session: ', 'Could not connect: host route /dsh-files/term/events did not respond (session: '],
      ['）。 可点右上「重启」重试，或重启桌面端后重试。', '). Select Restart at the upper right, or restart the desktop app.'],
      ['正在获取项目目录…', 'Getting project directory...'],
      ['运行中', 'Running'],
      ['已退出', 'Exited'],
      ['重连中…', 'Reconnecting...'],
      ['连接失败（点重启重试）', 'Connection failed (select Restart to retry)'],
      ['连接中…', 'Connecting...'],
      ['清屏', 'Clear'],
      ['重启终端', 'Restart terminal'],
      ['输入命令，回车执行（PowerShell 语法；非 PTY：vim 等全屏程序不支持）', 'Enter a command and press Enter (PowerShell syntax; full-screen programs such as vim require a PTY and are unsupported)'],
      ['回车重启终端…', 'Press Enter to restart the terminal...'],
      ['终端', 'Terminal'],
      ['请先输入要优化的提示词', 'Enter a prompt to optimize first.'],
      ['请先选择模型', 'Select a model first.'],
      ['正在调用模型…', 'Calling model...'],
      ['优化请求失败（HTTP ', 'Optimization request failed (HTTP '],
      ['正在优化 · 已生成 ', 'Optimizing · generated '],
      ['已完成 · 已生成 /goal', 'Done · generated /goal'],
      ['已完成 · 已附加浏览器验证', 'Done · appended browser verification'],
      ['响应流意外结束', 'Response stream ended unexpectedly'],
      ['已停止优化', 'Optimization stopped'],
      ['第 ', 'Round '],
      [' 轮 · 正在生成 ', ' · generating '],
      [' 个候选…', ' candidates...'],
      ['正在生成候选 ', 'Generating candidate '],
      ['自动优化提示词', 'Optimize prompt automatically'],
      ['提示词优化面板', 'Prompt optimization panel'],
      ['优化提示词', 'Optimize prompt'],
      [' 优化当前草稿', ' to optimize the current draft'],
      ['多轮优化', 'Multi-round optimization'],
      ['设定目标提示词', 'Set target prompt'],
      ['设定目标', 'Set target'],
      ['使用 AI 浏览器验证', 'Validate with AI browser'],
      ['浏览器验证', 'Browser validation'],
      ['点击生成多个候选', 'Select to generate multiple candidates'],
      ['点击用当前模型优化', 'Select to optimize with the current model'],
      ['多轮优化候选', 'Multi-round candidates'],
      ['点选任意候选即可写入对话框，再点优化进入下一轮；顶部「原话」始终保留你最初写的内容。', 'Select any candidate to put it in the composer, then optimize again for the next round. Original always keeps your initial text.'],
      ['原话', 'Original'],
      ['候选 ', 'Candidate '],
      ['均衡优化', 'Balanced'],
      ['精简高效', 'Concise'],
      ['详尽具体', 'Detailed'],
      ['已完成', 'Done'],
      ['无响应流', 'No response stream'],
      ['优化失败', 'Optimization failed'],
      ['失败：', 'Failed: '],
      ['未选模型', 'No model selected'],
      ['会话上下文', 'Session context'],
      ['向当前会话上下文提问，答案仅存在于此临时会话，不污染主会话。', 'Ask about the current session context. Answers stay in this temporary session and do not affect the main session.'],
      ['浮窗可自由拖动/缩放；左下角侧栏图标或 Ctrl+Shift+S 唤起。', 'Drag or resize the floating window. Open it from the lower-left sidebar icon or with Ctrl+Shift+S.'],
      ['三模式互斥、持久化、即时切换，无需重启 DSH。', 'The three exclusive modes persist and switch immediately without restarting DSH.'],
      ['选择档位后点「确定」生效（控制临时会话能看到的对话条数与文件上限）。', 'Choose a level and select Confirm to control how many messages and files the temporary session can see.'],
      ['选择档位后点「确定」生效（0ms = 关闭动画）。', 'Choose a duration and select Confirm (0 ms disables animation).'],
      ['使用 DSH 全局凭据（DEEPSEEK_API_KEY 环境变量或 ~/.dsh/.credentials.yaml）。', 'Use global DSH credentials from DEEPSEEK_API_KEY or ~/.dsh/.credentials.yaml.'],
      ['已保存插件自带 Key；重新输入会替换旧值。', 'The plugin key is saved. Enter a new value to replace it.'],
      ['输入后回车 / 失焦即保存（Key 仅存储在本机 settings.yaml，界面不回显明文）。', 'Press Enter or leave the field to save. The key stays in local settings.yaml and is never shown in plain text.'],
      ['走服务端 ctx.llm.stream，不读任何 key。需宿主 LLM 服务可用。', 'Use server-side ctx.llm.stream without reading any key. The host LLM service must be available.'],
      ['回答引擎模式', 'Answer engine mode'],
      ['1 · 复用 DSH 全局 Key', '1 · Reuse global DSH key'],
      ['2 · 插件自带 Key', '2 · Plugin key'],
      ['3 · 宿主 LLM（ctx.llm）', '3 · Host LLM (ctx.llm)'],
      ['上下文长度', 'Context length'],
      ['1 · 标准（120 条 / 40K 字符，省 token）', '1 · Standard (120 messages / 40K characters, saves tokens)'],
      ['2 · 加长（600 条 / 200K 字符，推荐）', '2 · Extended (600 messages / 200K characters, recommended)'],
      ['3 · 完整（5000 条 / 2M 字符，最接近通读全文，token 消耗大）', '3 · Full (5,000 messages / 2M characters, high token use)'],
      ['应用并保存', 'Apply and save'],
      ['弹出动画时长', 'Open animation duration'],
      ['关闭（0ms）', 'Off (0 ms)'],
      ['快速（300ms）', 'Fast (300 ms)'],
      ['标准（500ms，默认）', 'Standard (500 ms, default)'],
      ['舒缓（800ms）', 'Relaxed (800 ms)'],
      ['缓慢（1200ms）', 'Slow (1200 ms)'],
      ['●●●●（已保存，输入可替换）', '●●●● (saved; enter a replacement)'],
      ['API 基址', 'API base URL'],
      ['基于上下文提问', 'Ask about the context'],
      ['回答中…', 'Answering...'],
      ['发送', 'Send'],
      ['正在加载上下文…', 'Loading context...'],
      ['未检测到会话', 'No session detected'],
      ['(未知会话)', '(unknown session)'],
      [' · 对话 ', ' · messages '],
      [' 条 · 文件 ', ' · files '],
      [' · 已截断', ' · truncated'],
      ['会话：', 'Session: '],
      ['拖动移动浮窗', 'Drag floating window'],
      ['临时会话', 'Temporary session'],
      ['隐藏浮窗', 'Hide floating window'],
      ['清空临时会话', 'Clear temporary session'],
      ['拖拽缩放', 'Drag to resize'],
      ['侧边临时会话', 'Side temporary session'],
      ['唤起浮窗', 'Open floating window'],
      ['[进程已退出', '[Process exited'],
      ['，回车或点「重启」开启新会话]', '. Press Enter or select Restart to start a new session]'],
      ['[未连接：命令未发送]', '[Not connected: command was not sent]'],
      ['，目录: ', ', directory: '],
      [' 可点右上「重启」重试，或重启桌面端后重试。', '. Select Restart at the upper right, or restart the desktop app.'],
      ['探测 fetch 失败: ', 'Probe fetch failed: '],
      ['探测 fetch: HTTP ', 'Probe fetch: HTTP '],
      ['重启', 'Restart'],
      ['http://127.0.0.1:3000 或项目 HTML 文件', 'http://127.0.0.1:3000 or a project HTML file'],
      ['共 ', 'Total '],
      [' 次变更 · ', ' changes · '],
      [' 次变更', ' changes'],
      ['端口', 'Port'],
      ['将于 ', 'Scheduled for '],
      [' 执行（闲时半价）', ' (half-price off-peak execution)'],
      [' 时', ':00'],
      ['输出', 'Output'],
      [' · 剩 ', ' · remaining '],
      ['插件管理桥不可用', 'Plugin management bridge unavailable'],
      ['读取桌宠状态失败: ', 'Could not read desktop pet status: '],
      ['已启用，重启应用后生效', 'Enabled. Restart the app to apply.'],
      ['已停用，重启应用后生效', 'Disabled. Restart the app to apply.'],
      ['留空保存 = 保持现状', 'Save blank to keep the current value'],
      ['恢复', 'Restore'],
      ['设', 'S'],
      ['从这条消息之前分叉出新会话，并以编辑后的内容重新发送；原会话保留不动。', 'Fork a new session before this message and resend the edited content. The original session is preserved.'],
      ['首条消息不支持回退（前面没有完整回合），请新建会话后重新发送。', 'The first message cannot be rewound because no complete turn precedes it. Start a new session and resend it.'],
      ['新会话输入框未能就绪，编辑后的内容已复制到剪贴板，请粘贴发送。', 'The new session composer was not ready. The edited content was copied to the clipboard; paste it to send.'],
      ['开启后隐藏大量工具调用、工具结果与思考过程，只显示每一轮的最终总结输出。', 'Hide tool calls, tool results, and reasoning while keeping the final summary of each turn.'],
      ['在模型请求前按真实 Token 压力压缩；溢出恢复会先复检实测上下文，防供应商误报误压；瞬态 400 自动重试一次。', 'Compact before model requests based on measured token pressure. Overflow recovery verifies the context first, and transient 400 errors retry once.'],
      ['关闭后不执行请求前压缩或溢出恢复；手动压缩仍可用。', 'Disable pre-request compaction and overflow recovery. Manual compaction remains available.'],
      ['收到 CONTEXT_WINDOW_EXCEEDED 且实测 tokens 接近上下文窗口时才压缩并重试；远低于窗口的误报会原样透传 400。', 'Compact and retry only when measured tokens are close to the context window. False overflow reports pass through unchanged.'],
      ['非溢出的 400（如免费服务商偶发）且本会话此前已有成功回答时，自动原样重试一次，免去「无故 400、继续说一句才好」；彻底失败才提示。', 'Retry a non-overflow 400 once when this session already has a successful response. Report it only after the retry fails.'],
      ['JSON 数组；每项至少包含 provider 和 model，可覆盖 enabled、thresholdRatio、retainRatio、recoverOnOverflow、maxOverflowRetries。', 'JSON array. Each item needs provider and model and may override enabled, thresholdRatio, retainRatio, recoverOnOverflow, and maxOverflowRetries.'],
      ['技能按目录扫描：~/.dsh/skills 与 ~/.agents/skills 下的 <名称>/SKILL.md 或平铺 <名称>.md。项目级技能在 <项目>/.dsh/skills。修改即时生效（文件监听）。', 'Skills are scanned by directory: <name>/SKILL.md or <name>.md under ~/.dsh/skills and ~/.agents/skills. Project skills live in <project>/.dsh/skills. Changes are watched live.'],
      ['MCP 服务通过 profile 的 cordis.patch.yml 中 @deepseek-ai/dsh-mcp-client 行配置。保存后需重启 Web 服务生效。', 'MCP servers are configured by the @deepseek-ai/dsh-mcp-client row in the profile cordis.patch.yml. Restart the web service after saving.'],
      ['发现本机 Claude Code（~/.claude.json）与 Codex（~/.codex/config.toml）中的 MCP 服务器如下，勾选后导入（同名覆盖现有行）：', 'The following MCP servers were found in Claude Code (~/.claude.json) and Codex (~/.codex/config.toml). Select entries to import; matching names are replaced:'],
      ['未在本机找到 Claude Code / Codex 的 MCP 配置（~/.claude.json、~/.codex/config.toml）。', 'No Claude Code or Codex MCP configuration was found (~/.claude.json or ~/.codex/config.toml).'],
      ['还没有 MCP 服务。点击「新增服务」添加。', 'No MCP servers yet. Select Add server to create one.'],
      ['已保存。重启 Web 服务后生效。', 'Saved. Restart the web service to apply.'],
      ['参数不是合法的 JSON 数组，已按空格拆分', 'Arguments are not a valid JSON array and were split on spaces.'],
      ['当前回合仍在进行，等它结束后再回退。', 'The current turn is still running. Wait for it to finish before rewinding.'],
      ['当前没有可安全压缩的旧历史。', 'There is no older history that can be compacted safely.'],
      ['模型策略必须是 JSON 数组', 'Model policies must be a JSON array.'],
      ['为防止循环，只允许 0 或 1。', 'Only 0 or 1 is allowed to prevent retry loops.'],
      ['必须低于触发阈值。', 'Must be lower than the trigger threshold.'],
      ['此功能需要 Deepseek Harness EAC 桌面端运行', 'This feature requires the Deepseek Harness EAC desktop app.'],
      ['插件包不会被卸载', 'Plugin packages are not uninstalled.'],
      ['修改会立即生效', 'Changes apply immediately.'],
      ['需要重启 Web 服务后生效', 'Restart the web service to apply.'],
      ['弹出到独立窗口（分屏）', 'Open in a separate window (split view)'],
      ['弹出到独立窗口', 'Open in a separate window'],
      ['立即压缩当前对话', 'Compact current session now'],
      ['正在压缩…', 'Compacting...'],
      ['压缩已完成并持久化。', 'Compaction completed and saved.'],
      ['请先打开一个对话。', 'Open a session first.'],
      ['上下文自动压缩', 'Automatic context compaction'],
      ['启用自动压缩', 'Enable automatic compaction'],
      ['触发阈值', 'Trigger threshold'],
      ['保留近期上下文', 'Keep recent context'],
      ['溢出自动恢复', 'Automatic overflow recovery'],
      ['溢出重试次数', 'Overflow retry count'],
      ['瞬态错误自动重试', 'Retry transient errors'],
      ['保存模型策略', 'Save model policies'],
      ['专属策略', 'specific policy'],
      ['当前 preset 未启用', 'Current preset is disabled'],
      ['未选择会话', 'No session selected'],
      ['Host 不可用', 'Host unavailable'],
      ['隐藏对话输出', 'Hide conversation output'],
      ['显示全部', 'Show all'],
      ['已隐藏', 'Hidden'],
      ['编辑并回退', 'Edit and rewind'],
      ['回退并重发', 'Rewind and resend'],
      ['正在分叉会话…', 'Forking session...'],
      ['回退失败', 'Rewind failed'],
      ['已回退并重新发送', 'Rewound and resent'],
      ['将随消息重新附加', 'Will reattach with the message: '],
      ['张图片', ' image(s)'],
      ['Skills 与 MCP', 'Skills & MCP'],
      ['MCP 服务', 'MCP servers'],
      ['新增服务', 'Add server'],
      ['服务名（英文/数字/下划线/中划线）', 'Server name (letters, digits, underscores, or hyphens)'],
      ['参数（JSON 数组或空格分隔）', 'Arguments (JSON array or space-separated)'],
      ['环境变量（每行 KEY=VALUE）', 'Environment variables (one KEY=VALUE per line)'],
      ['请求头（每行 KEY: VALUE）', 'Headers (one KEY: VALUE per line)'],
      ['从 Claude / Codex 导入', 'Import from Claude / Codex'],
      ['导入选中项', 'Import selected'],
      ['立即重启生效', 'Restart now'],
      ['重启中…', 'Restarting...'],
      ['加载中…', 'Loading...'],
      ['保存中…', 'Saving...'],
      ['已保存', 'Saved'],
      ['保存失败', 'Save failed'],
      ['打开目录', 'Open folder'],
      ['刷新', 'Refresh'],
      ['启动命令', 'Command'],
      ['同名将覆盖', 'Matching names will be replaced'],
      ['取消全选', 'Clear selection'],
      ['全选', 'Select all'],
      ['默认停用', 'Disabled by default'],
      ['桌宠设置', 'Desktop pet settings'],
      ['点击召唤桌宠', 'Click to summon desktop pet'],
      ['召唤桌宠', 'Summon desktop pet'],
      ['关闭桌宠', 'Close desktop pet'],
      ['桌宠', 'Desktop pet'],
      ['互动（点击回应 / 随机动作）', 'Interactions (click responses / random actions)'],
      ['自动挂边隐藏（空闲折叠）', 'Auto-hide at edge when idle'],
      ['插件管理', 'Plugin management'],
      ['插件市场', 'Plugin marketplace'],
      ['增强功能', 'Enhancements'],
      ['创建配置快照', 'Create configuration snapshot'],
      ['恢复最后快照', 'Restore latest snapshot'],
      ['安全模式', 'Safe mode'],
      ['解除隔离', 'Unquarantine'],
      ['隔离', 'Quarantine'],
      ['最近错误', 'Latest error'],
      ['安装失败', 'Installation failed'],
      ['更新失败', 'Update failed'],
      ['操作失败', 'Operation failed'],
      ['未知错误', 'Unknown error'],
      ['连接手机', 'Connect phone'],
      ['语音识别', 'Speech recognition'],
      ['提示词优化', 'Prompt optimization'],
      ['自动优化提示词', 'Optimize prompt'],
      ['停止优化', 'Stop optimization'],
      ['重新生成', 'Regenerate'],
      ['应用结果', 'Apply result'],
      ['文件更改', 'File changes'],
      ['查看文件', 'View file'],
      ['恢复文件', 'Restore file'],
      ['删除对话', 'Delete session'],
      ['归档对话', 'Archive session'],
      ['已归档', 'Archived'],
      ['会话管理', 'Session management'],
      ['峰谷价格', 'Peak/off-peak pricing'],
      ['继续发送', 'Send anyway'],
      ['定时发送', 'Schedule send'],
      ['取消定时', 'Cancel schedule'],
      ['启用', 'Enable'],
      ['已启用', 'Enabled'],
      ['停用', 'Disable'],
      ['已停用', 'Disabled'],
      ['关闭', 'Close'],
      ['打开', 'Open'],
      ['重试', 'Retry'],
      ['取消', 'Cancel'],
      ['确定', 'Confirm'],
      ['删除', 'Delete'],
      ['移除', 'Remove'],
      ['编辑', 'Edit'],
      ['保存', 'Save'],
      ['新增', 'Add'],
      ['导入', 'Import'],
      ['导出', 'Export'],
      ['名称', 'Name'],
      ['类型', 'Type'],
      ['详情', 'Details'],
      ['状态', 'Status'],
      ['来源', 'Source'],
      ['操作', 'Actions'],
      ['大小', 'Size'],
      ['位置', 'Position'],
      ['设置', 'Settings'],
      ['插件', 'Plugins'],
      ['外观', 'Appearance'],
      ['推荐', 'Recommended'],
      ['可选', 'Optional'],
      ['用户', 'User'],
      ['内置', 'Built-in'],
      ['读取中', 'Loading'],
      ['失败', 'Failed'],
      ['成功', 'Succeeded'],
      ['用 ', 'Use '],
      [' 字', ' characters'],
      [' 轮', ' rounds'],
      ['无', 'None'],
      ['个', ''],
    ].sort((left, right) => right[0].length - left[0].length))

    function hasChinese(value) {
      return /[\u3400-\u9fff]/u.test(value)
    }

    function translateText(value) {
      if (!hasChinese(value)) return value
      let translated = value
      for (const [source, target] of ENGLISH_PHRASES) translated = translated.split(source).join(target)
      translated = translated.replace(/ {2,}/g, ' ')
      // Never expose a half-translated sentence. Older plugins are added to the
      // compatibility dictionary as complete UI phrases; unknown text is safer
      // left intact until its owning plugin supplies a reviewed translation.
      return hasChinese(translated) ? value : translated
    }

    function isExcluded(node) {
      const parent = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement
      if (!parent || typeof parent.closest !== 'function') return false
      return parent.closest(EXCLUDED_SELECTOR) !== null
    }

    function translateNode(node) {
      if (node.nodeType === Node.TEXT_NODE) {
        if (isExcluded(node)) return
        const value = node.nodeValue || ''
        if (node[ORIGINAL_TEXT] !== undefined && value !== node[TRANSLATED_TEXT]) {
          if (hasChinese(value)) node[ORIGINAL_TEXT] = value
          else {
            delete node[ORIGINAL_TEXT]
            delete node[TRANSLATED_TEXT]
            return
          }
        } else if (node[ORIGINAL_TEXT] === undefined && hasChinese(value)) {
          node[ORIGINAL_TEXT] = value
        }
        if (node[ORIGINAL_TEXT] === undefined) return
        const translated = translateText(node[ORIGINAL_TEXT])
        node[TRANSLATED_TEXT] = translated
        if (value !== translated) node.nodeValue = translated
        return
      }
      if (node.nodeType !== Node.ELEMENT_NODE || isExcluded(node)) return
      const original = node[ORIGINAL_ATTRIBUTES] || (node[ORIGINAL_ATTRIBUTES] = Object.create(null))
      const rendered = node[TRANSLATED_ATTRIBUTES] || (node[TRANSLATED_ATTRIBUTES] = Object.create(null))
      for (const name of TRANSLATABLE_ATTRIBUTES) {
        const value = node.getAttribute(name)
        if (original[name] !== undefined && value !== rendered[name]) {
          if (value !== null && hasChinese(value)) original[name] = value
          else {
            delete original[name]
            delete rendered[name]
            continue
          }
        } else if (original[name] === undefined && value !== null && hasChinese(value)) {
          original[name] = value
        }
        if (original[name] === undefined) continue
        const translated = translateText(original[name])
        rendered[name] = translated
        if (value !== translated) node.setAttribute(name, translated)
      }
      for (const child of node.childNodes) translateNode(child)
    }

    function restoreNode(node) {
      if (node.nodeType === Node.TEXT_NODE) {
        if (node[ORIGINAL_TEXT] !== undefined && node.nodeValue === node[TRANSLATED_TEXT]) {
          node.nodeValue = node[ORIGINAL_TEXT]
        }
        delete node[ORIGINAL_TEXT]
        delete node[TRANSLATED_TEXT]
        return
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return
      const original = node[ORIGINAL_ATTRIBUTES]
      const rendered = node[TRANSLATED_ATTRIBUTES]
      if (original) for (const name of TRANSLATABLE_ATTRIBUTES) {
        if (original[name] !== undefined && node.getAttribute(name) === rendered?.[name]) {
          node.setAttribute(name, original[name])
        }
      }
      delete node[ORIGINAL_ATTRIBUTES]
      delete node[TRANSLATED_ATTRIBUTES]
      for (const child of node.childNodes) restoreNode(child)
    }

    function createCompatibilityRuntime(root, locale) {
      let english = locale.getLocale().active === 'en'
      let queued = false
      const sync = () => {
        queued = false
        if (english) translateNode(root)
        else restoreNode(root)
      }
      const queueSync = () => {
        if (queued) return
        queued = true
        queueMicrotask(sync)
      }
      const observer = new MutationObserver(queueSync)
      observer.observe(root, { attributes: true, attributeFilter: TRANSLATABLE_ATTRIBUTES, characterData: true, childList: true, subtree: true })
      const unsubscribe = locale.subscribe(() => {
        english = locale.getLocale().active === 'en'
        queueSync()
      })
      sync()
      return () => {
        observer.disconnect()
        unsubscribe()
        restoreNode(root)
      }
    }

    const inject = ['locale']
    function apply(ctx) {
      if (typeof document === 'undefined' || !document.body) return
      ctx.effect(() => createCompatibilityRuntime(document.body, ctx.locale), 'eac locale compatibility')
    }

    exports.apply = apply
    exports.inject = inject
    exports.__internals = { hasChinese, translateText, translateNode, restoreNode, createCompatibilityRuntime }
    return module.exports
  },
})
