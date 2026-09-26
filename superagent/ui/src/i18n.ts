/**
 * UI language: Chinese or English. Follows the browser (zh-* → Chinese) unless the user
 * picked one (sidebar toggle, stored per device). Keys are the English text, so a missing
 * translation falls back to English instead of showing a key. `{name}` placeholders.
 * Fixed server texts (health titles, cleanup items, presets, states) are translated here
 * too; free text from agents and the model is shown as it comes.
 */
export type Lang = 'zh' | 'en'

export const lang: Lang = (() => {
  try {
    const s = localStorage.getItem('superagent-lang')
    if (s === 'zh' || s === 'en') return s
  } catch (noStorage) {
    void noStorage
  }
  return typeof navigator !== 'undefined' && /^zh/i.test(navigator.language) ? 'zh' : 'en'
})()

if (typeof document !== 'undefined') document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en'

export function setLang(l: Lang): void {
  try {
    localStorage.setItem('superagent-lang', l)
  } catch (noStorage) {
    void noStorage
  }
  location.reload()
}

export function t(en: string, vars?: Record<string, string | number | undefined>): string {
  const s = lang === 'zh' ? (ZH[en] ?? en) : en
  return vars ? s.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? '')) : s
}

/** Server texts with values in them ("Provider dgx unreachable"): pattern → template. */
export function tx(text: string): string {
  if (lang !== 'zh' || !text) return text
  if (ZH[text]) return ZH[text]
  for (const [re, zh] of PATTERNS) {
    const m = re.exec(text)
    if (m) return zh.replace(/\$(\d)/g, (_, i: string) => m[Number(i)] ?? '')
  }
  return text
}

const PATTERNS: Array<[RegExp, string]> = [
  [/^Project (.+): folder missing$/, '项目 $1：文件夹不存在'],
  [/^Project (.+): hidden tests missing for gate (.+)$/, '项目 $1：检查项 $2 的隐藏测试丢失'],
  [/^Project (.+): not a git repository$/, '项目 $1：不是 git 仓库'],
  [/^Project (.+): no test gate$/, '项目 $1：没有测试检查项'],
  [/^Project (.+)$/, '项目 $1'],
  [/^Provider (.+) unreachable$/, '模型服务器 $1 连不上'],
  [/^Provider (.+)$/, '模型服务器 $1'],
  [/^keeps the newest (\d+)$/, '保留最新的 $1 个'],
  [/^refs\/superagent\/\* of tasks finished more than (\d+) days ago \(or deleted\) in project repositories$/, '项目仓库里 $1 天前已完成（或已删除）任务的 refs/superagent/* 快照'],
  [/^state set aside by restores more than (\d+) days ago$/, '$1 天前恢复时替换下来的旧状态'],
  [/^SuperAgent gate\/verification temp folders in (.+) older than 1 hour$/, '$1 里超过 1 小时的检查/验证临时目录'],
  [/^attempt budget exhausted \((\d+)\/(\d+)\); last: (.*)$/s, '尝试次数用完（$1/$2）；最后一次：$3'],
  [/^required gates not passing: (.*)$/, '必需的检查没有通过：$1'],
  [/^all (\d+) required gates passed$/, '全部 $1 个必需检查都通过了'],
  [/^not ready: (.*)$/s, '还没准备好：$1'],
  [/^(.+) GB free$/, '剩余 $1 GB'],
  [/^listening on (.+); token required for every request$/, '监听 $1；每个请求都要令牌'],
  [/^(\d+) wake\(s\) could not be delivered$/, '$1 次唤醒没能送达'],
]

/** Task / goal / worker / candidate states. */
export const tState = (s: string): string => t(`state:${s}`) === `state:${s}` ? s : t(`state:${s}`)

const ZH: Record<string, string> = {
  // states
  'state:executing': '进行中', 'state:verifying': '检查中', 'state:retrying': '重试中', 'state:passed': '已通过', 'state:failed': '失败',
  'state:human_gate': '等你决定', 'state:stopped': '已停止', 'state:pending': '等待中', 'state:queued': '排队中', 'state:planned': '已规划',
  'state:active': '进行中', 'state:complete': '已完成', 'state:blocked': '已暂停', 'state:paused': '已暂停', 'state:running': '运行中',
  'state:exited': '已结束', 'state:crashed': '崩溃', 'state:killed': '已终止', 'state:candidate': '候选', 'state:promoted': '已采用',
  'state:rejected': '已拒绝', 'state:evaluating': '评估中', 'state:approved': '已批准', 'state:open': '待处理', 'state:resolved': '已处理',
  'state:PASS': '通过', 'state:FAIL': '失败',

  // app shell
  'Overview': '概览', 'Chief': 'Chief', 'Files': '文件', 'Terminal': '终端', 'Workers': 'Worker', 'Architecture': '架构', 'Learning': '学习',
  'Policy': '模型策略', 'Events': '事件', 'More': '更多', 'Appearance': '外观', 'System': '系统',
  'System health: {h}': '系统健康：{h}', 'green': '正常', 'yellow': '有警告', 'red': '有问题',
  'no goal': '没有目标', ' · {n} decision(s)': ' · {n} 项待决定', '＋ Add project': '＋ 添加项目', 'Add or select a project.': '添加或选择一个项目。',
  'Language': '语言',

  // ask
  'What do you want?': '你想做什么？',
  'Describe the change in plain words, e.g. “the signup form should reject emails without an @”': '用大白话描述要做的改动，例如“注册表单要拒绝没有 @ 的邮箱”',
  'also have a reviewer check the change': '另外让 Reviewer 审查改动', 'Models for this request only': '只对这次需求生效的模型',
  'models: current': '模型：当前设置', 'this time: {name}': '这次用：{name}', 'checks: ': '检查：', ' (hidden)': '（隐藏）',
  'none — add a test gate': '无——请添加测试检查项', 'Planning…': '规划中…', 'Go': '开始', 'Open Health': '打开健康检查', 'Run anyway': '仍然运行',
  'Activity': '动态',

  // overview
  'Needs your decision': '需要你决定', 'Goal': '目标', 'queued': '排队中', 'asked: {r}': '原始需求：{r}', 'Running…': '运行中…',
  'Start / continue': '开始 / 继续', 'No goal yet.': '还没有目标。', 'New goal objective': '新目标', 'Create goal': '创建目标', 'Tasks': '任务',
  'Task': '任务', 'State': '状态', 'Attempts': '尝试次数', 'Worker model': 'Worker 模型', 'Last verdict': '最近结论', 'Task title': '任务标题',
  'Instructions for the Worker': '给 Worker 的说明', 'Add task': '添加任务', 'Chief report': 'Chief 报告',
  'model (provider/model, default local)': '模型（服务器/模型，默认本地）', 'reviewed after checks pass': '检查通过后会被审查', 'review': '审查',
  'steer: {s}': '引导：{s}', 'reviewer: {c}': 'Reviewer：{c}', 'Set': '设置', 'Stop': '停止', 'steer next attempt': '给下一次尝试的引导',
  'Steer': '引导', '{n} action(s) blocked before execution — approving allows exactly these': '{n} 个操作在执行前被拦下——批准只放行这些操作',
  'decision note / direction': '决定备注 / 方向', 'Approve': '批准', 'Reject': '拒绝',
  'repeated-failure': '多次失败', 'review-disagreement': '审查不通过', 'dangerous-action': '危险操作', 'integrity': '完整性问题',
  'Workers / Loop': 'Worker / 循环', '— tap a Worker to see exactly what it did': '——点一个 Worker 查看它具体做了什么', 'Worker': 'Worker', 'Attempt': '尝试',
  'Status': '状态', 'Model': '模型', 'Last report': '最近汇报', 'Modules': '模块', 'claim {c}': '自称 {c}', 'Live events': '实时事件',

  // system
  'Health': '健康', 'Models': '模型', 'Backup': '备份', 'Update': '更新', 'Cleanup': '清理',
  'All good': '一切正常', 'Works, with warnings': '可以用，有警告', 'Not ready': '还没准备好', 'Checking…': '检查中…', 'Check again': '重新检查',
  'Sends one tiny request to each configured model': '给每个已配置的模型发一个极小的请求', 'Test models (uses a few tokens)': '测试模型（消耗少量 token）',
  'Open Cleanup': '打开清理', 'Open Models': '打开模型',
  'runtime': '运行环境', 'dsh': 'DSH', 'storage': '存储', 'models': '模型', 'agents': 'Agent', 'projects': '项目', 'access': '访问',
  'Presets': '预设', '— one click switches Chief, Planner, Workers, Reviewer and Escalation': '——一键切换 Chief、规划、Worker、Reviewer 和升级模型',
  'active': '使用中', 'In use': '使用中', 'Use': '使用', 'Edit presets': '编辑预设', 'Model servers': '模型服务器', 'local default': '本地默认',
  'key saved': '已存 Key', 'no key': '无 Key', 'Remove {name}?': '删除 {name}？', 'Remove': '删除',
  'No model server yet. Add your DGX\'s OpenAI-compatible server (vLLM, SGLang, Ollama, LM Studio…) or an API provider.': '还没有模型服务器。添加 DGX 上兼容 OpenAI 的服务（vLLM、SGLang、Ollama、llama.cpp、LM Studio…）或一个 API 服务商。',
  '＋ Add model server': '＋ 添加模型服务器', 'Name': '名称', 'Protocol': '协议', 'OpenAI-compatible': '兼容 OpenAI', 'Anthropic-compatible': '兼容 Anthropic',
  'Base URL': '地址（Base URL）', 'API key': 'API Key', '(none for most local servers)': '（大多数本地服务器不需要）', 'Connecting…': '连接中…', 'Connect': '连接',
  'Models to use': '要用的模型', 'Test (1 token)': '测一下（1 个 token）', 'Make it the <local default> (used by the “All local” preset)': '设为<本地默认>（“全本地”预设会用它）',
  'Cancel': '取消', 'Save': '保存', 'Role': '角色', 'Save presets': '保存预设',
  'chief': 'Chief', 'planner': '规划', 'worker': 'Worker', 'reviewer': 'Reviewer', 'escalation': '升级模型',
  'All local': '全本地', 'Budget': '省钱', 'Default': '默认', 'Max performance': '高性能',
  'Everything on your own model server (no API cost).': '全部用你自己的模型服务器（不花 API 费用）。',
  'Cheap API models for Workers; local where possible.': 'Worker 用便宜的 API 模型，能本地就本地。',
  'Balanced: capable Chief/Reviewer, efficient Workers.': '均衡：Chief/Reviewer 用强模型，Worker 用高效模型。',
  'Strongest models everywhere.': '所有角色都用最强的模型。',
  'not set up yet — choose a model for each role': '还没设置——给每个角色选一个模型',
  'label (optional)': '标签（可选）', 'Working…': '处理中…', 'Back up now': '立即备份',
  'include secrets (API keys, agent token) — keep that file private': '包含密钥（API Key、agent 令牌）——这个文件要妥善保管',
  'include DSH sessions (Chief/Worker history; can be large)': '包含 DSH 会话（Chief/Worker 历史，可能很大）', 'Restore from a file…': '从文件恢复…',
  ' · with secrets': ' · 含密钥', 'Download': '下载', 'Restore': '恢复', 'Delete': '删除', 'Delete this backup?': '删除这个备份？',
  'Restore “{label}” from {at}? Your current state is backed up first.': '恢复 {at} 的“{label}”？恢复前会先备份当前状态。',
  'Restored. The previous state was saved as {id}.': '已恢复。之前的状态已保存为 {id}。',
  'Loading…': '加载中…', 'Restarting… the page reconnects in a few seconds.': '正在重启……页面几秒后会重新连接。',
  'Running': '正在运行', 'unknown commit': '未知提交', ' · release ': ' · 版本目录 ', 'Check for updates': '检查更新', 'Go back to {v}?': '回滚到 {v}？',
  'Roll back to {v}': '回滚到 {v}', 'Restart SuperAgent': '重启 SuperAgent', 'installed — restarting': '已安装——正在重启',
  'installed — restart SuperAgent to use it': '已安装——重启 SuperAgent 后生效', 'failed: {e}': '失败：{e}', 'new': '新',
  'Update to {ref}? It is built next to the running version, your state is backed up, and it switches back automatically if the new version fails its start-up check.': '更新到 {ref}？新版本会在旁边单独构建，更新前自动备份状态；新版本启动自检不通过会自动切回。',
  'History': '历史', 'install': '安装', 'update': '更新', 'verified': '已验证', 'rollback': '回滚', 'rolled-back': '已回滚',
  'Nothing that running work, open tasks or pending learning still need is removed.': '正在运行的工作、未完成的任务和待评估的学习候选用到的东西都不会删。',
  'Cleaned: {list}': '已清理：{list}', 'nothing': '无', 'Clean selected': '清理所选',
  'Orphaned Workers': '孤儿 Worker', 'Stale task leases': '失效的任务锁', 'Old verification snapshots': '旧的验证快照', 'Old Worker logs': '旧的 Worker 日志',
  'Old command output': '旧的命令输出', 'Leftover temp folders': '残留临时目录', 'Old backups': '旧备份', 'Replaced state from restores': '恢复时替换下来的旧状态', 'Old releases': '旧版本',
  'installed versions other than the current and previous': '当前和上一个之外的已安装版本', 'locks left by processes that no longer exist': '已不存在的进程留下的锁',
  'output of ▷ Run / Terminal commands': '▷ 运行 / 终端命令的输出', 'prompts, DSH event logs and stderr of Workers that ended long ago (receipts are kept)': '早已结束的 Worker 的提示词、DSH 事件日志和 stderr（验证记录会保留）',
  'Worker records still marked running without a process (their tasks resume from the last attempt)': '标记为运行中但进程已不在的 Worker 记录（任务会从上次尝试继续）',

  // health titles / fixes
  'Browser for E2E / browser Workers': '端到端测试 / 浏览器 Worker 用的浏览器', 'Chief profile': 'Chief 配置', 'Chief profile missing': '缺少 Chief 配置',
  'Chief wake queue': 'Chief 唤醒队列', 'Chief wakes failed': 'Chief 唤醒失败', 'DSH runtime': 'DSH 运行时', 'DSH runtime missing': '缺少 DSH 运行时',
  'DSH version mismatch': 'DSH 版本不匹配', 'Free disk space': '磁盘剩余空间', 'git missing': '缺少 git', 'Leftovers from interrupted runs': '中断运行留下的残留',
  'local-default → DSH built-in route': 'local-default → DSH 内置线路', 'local-default is not mapped to a model server': 'local-default 没有对应的模型服务器',
  'No browser found': '没找到浏览器', 'Node.js too old': 'Node.js 版本太旧', 'No model policy': '没有模型策略', 'Secrets permissions': '密钥权限',
  'Secrets readable by other users': '密钥能被其他用户读取', 'State directory not writable': '状态目录不可写', 'State directory writable': '状态目录可写',
  'SuperAgent DSH bundle built': 'SuperAgent DSH 插件包已构建', 'SuperAgent DSH bundle outdated': 'SuperAgent DSH 插件包过期', 'Web UI built': '网页界面已构建',
  'Web UI not built': '网页界面未构建', 'Worker profile': 'Worker 配置', 'Worker profile missing': '缺少 Worker 配置', 'Worker read isolation': 'Worker 读隔离',
  'Workers are not read-isolated': 'Worker 没有读隔离',
  'add a test command in the project settings': '在项目设置里添加一个测试命令', 'check the Chief model in Models': '到“模型”里检查 Chief 用的模型',
  'fix permissions of SUPERAGENT_HOME': '修复 SUPERAGENT_HOME 的权限', 'install git': '安装 git', 'install Node 22 LTS': '安装 Node 22 LTS',
  'Models → add a provider and mark it "local default"': '模型 → 添加一个模型服务器，并设为“本地默认”', 're-register the project with its new path': '用新路径重新登记这个项目',
  'System → Cleanup': '系统 → 清理',

  'Local access only': '仅本机访问', 'Remote access on': '已开启远程访问', 'listening on 127.0.0.1': '只监听 127.0.0.1',
  'set SUPERAGENT_HUMAN_TOKEN so the phone link survives restarts': '设置 SUPERAGENT_HUMAN_TOKEN，让手机链接重启后仍有效',
  'chat, planner, reviewer and auto-wake available': '聊天、规划、审查和自动唤醒都可用', 'E2E gates and browser Workers will fail': '端到端检查和浏览器 Worker 会失败',
  'no Chief chat, planning (falls back to one task), reviewer or auto-wake': '没有 Chief 聊天、规划（退回为单个任务）、审查和自动唤醒',
  'no failed deliveries': '没有投递失败', 'no orphaned Workers or stale leases': '没有孤儿 Worker 或失效的锁', 'owner-only': '仅所有者可读',
  'required for verification snapshots': '验证快照需要它', 'source is newer than the build': '源码比构建产物新', 'the API works, the UI does not': 'API 能用，界面不能用',
  'superagent-worker (SuperAgent guard + tools)': 'superagent-worker（SuperAgent 防护 + 工具）', 'tasks are only checked for architecture drift': '任务只检查了架构偏离（没有测试命令）',
  'using built-in defaults': '使用内置默认值', 'verification integrity needs git snapshots': '验证完整性需要 git 快照',
  'Workers would run without the SuperAgent pre-tool guard': 'Worker 会在没有 SuperAgent 执行前防护的情况下运行',
  'disabled (SUPERAGENT_SANDBOX=off)': '已关闭（SUPERAGENT_SANDBOX=off）',
  'bubblewrap hides secrets, held-out tests, backups and ~/.config/superagent from Workers': '已用 bubblewrap 对 Worker 隐藏密钥、隐藏测试、备份和 ~/.config/superagent',
  'bubblewrap (bwrap) not usable: Workers can read secrets and held-out tests as the server user': 'bubblewrap（bwrap）不可用：Worker 能以服务器用户身份读取密钥和隐藏测试',
  'sudo apt install bubblewrap (or run Workers as a separate OS user, NEXT_STEPS P0 #2)': 'sudo apt install bubblewrap（或让 Worker 以单独的系统用户运行）',
  'npx playwright install chromium (or set SUPERAGENT_CHROMIUM)': 'npx playwright install chromium（或设置 SUPERAGENT_CHROMIUM）',
  // panels
  'Model policy': '模型策略', 'Defaults ← global ← project ← task pin. Un-pinned tasks pick up changes on their next attempt — no model call needed.': '优先级：默认 ← 全局 ← 项目 ← 任务固定。没固定模型的任务下次尝试时自动用新设置，不需要调用模型。',
  'All projects': '所有项目', 'This project': '本项目', 'Global default': '全局默认', 'Project override': '项目覆盖', 'Effective here': '实际生效',
  'inherit': '继承', '= worker': '= worker', 'Save {scope} policy': '保存策略', 'Learning candidates': '学习候选',
  'Nothing becomes active knowledge without evidence (fresh replay) and/or a human.': '没有证据（全新重放）和/或人工批准，任何东西都不会变成生效的知识。',
  'Candidate': '候选', 'Evidence': '证据', 'needs {g}': '需要{g}', 'content': '内容', 'Replaying…': '重放中…', 'Evaluate (replay)': '评估（重放）',
  'No candidates yet — they appear after tasks pass.': '还没有候选——任务通过后会出现。', 'human decision': '人工决定', 'replay evidence': '重放证据', 'evidence + human': '证据 + 人工',
  'Chief wake: ': 'Chief 唤醒：', 'on · {n} pending': '开 · {n} 个待处理', ' · {n} failed': ' · {n} 个失败', 'off': '关', 'last wake: ': '上次唤醒：', 'never': '从未',
  'architecture: ': '架构：', '{m} modules · {e} drift error(s)': '{m} 个模块 · {e} 个偏离错误', ' · rescanning': ' · 重新扫描中', 'Recent Chief wakes': '最近的 Chief 唤醒',

  // wizard
  'Add a project': '添加项目', 'Folder on the server': '服务器上的文件夹', 'Scan': '扫描', '↑ up': '↑ 上一级', 'git': 'git',
  'Initialize git': '初始化 git', 'Found': '识别结果', 'no source files': '没有源代码文件', ' ({n} uncommitted)': '（{n} 个未提交）', ' · declared architecture': ' · 已声明架构',
  'Checks that decide “done”': '决定“完成”的检查项', ' (optional)': '（可选）', 'Back': '返回', 'Create project': '创建项目',

  // chat / files / terminal / transcript / run
  'Chat needs the Chief profile: run ': '聊天需要 Chief 配置：运行 ', ' and restart ': ' 然后重启 ',
  'Ask the Chief anything about this project — progress, why something failed, what to do next. It can also send you files.': '问 Chief 关于这个项目的任何事——进度、为什么失败、下一步做什么。它也能给你发文件。',
  'Chief is working…': 'Chief 正在处理…', 'Message the Chief (Ctrl/⌘+Enter to send)': '给 Chief 发消息（Ctrl/⌘+Enter 发送）', 'Chief chat unavailable': 'Chief 聊天不可用',
  'Send': '发送', 'Automatic wake · {time}': '自动唤醒 · {time}', 'Sent to you': '发给你的文件',
  'Nothing yet. Workers and the Chief can send you files (reports, screenshots, builds) — they show up here.': '还没有。Worker 和 Chief 可以给你发文件（报告、截图、构建产物），会显示在这里。',
  'from {r}': '来自 {r}', 'Preview': '预览', 'Project files': '项目文件', 'root': '根目录', 'Showing the first 1000 entries.': '只显示前 1000 项。', 'Open': '打开',
  'No inline preview for {m}{s}. Use Download or Open.': '{m}{s}无法直接预览，请用“下载”或“打开”。', 'this type': '这种类型', ' at this size': '（文件太大）',
  ' · flagged': ' · 已标记', 'Worker {id}': 'Worker {id}', 'attempt {n}': '第 {n} 次尝试', 'Prompt the Worker received': 'Worker 收到的提示词',
  'No DSH events recorded for this Worker (scripted or not started).': '这个 Worker 没有 DSH 事件记录（脚本模式或还没启动）。', 'Showing the last 2000 steps.': '只显示最后 2000 步。',
  'input / result': '输入 / 结果', 'Command': '命令', 'Run this command?': '运行这条命令？',
  'Runs with bash in the project directory on the server, as you. Review it — commands written by agents can be wrong or manipulated.': '会以你的身份在服务器的项目目录里用 bash 运行。请先检查——agent 写的命令可能有错或被操纵。',
  'Flagged: {c}': '已标记：{c}', '. I understand and want to run it anyway.': '。我明白风险，仍然要运行。', '▷ Run': '▷ 运行', 'running': '运行中', 'exit {n}': '退出码 {n}',
  '■ Stop': '■ 停止', '(no output)': '（无输出）', 'Run in the project on the server': '在服务器的项目里运行', 'Copy': '复制', 'Run': '运行',

  // appearance / architecture / background
  'Style': '风格', 'Clean': '简洁', 'Glass': '玻璃', 'Theme': '主题', 'Auto': '自动', 'Light': '浅色', 'Dark': '深色', 'Accent': '强调色', 'Background': '背景',
  'None': '无', 'Gradient': '渐变', 'Image / video': '图片 / 视频', 'Web page / Digital Human': '网页 / 数字人', '＋ Upload image or video': '＋ 上传图片或视频',
  'Interactive (clicks reach the page where the UI is transparent)': '可交互（在界面透明处的点击会传给背景网页）', 'Allow microphone / camera / autoplay (voice)': '允许麦克风 / 摄像头 / 自动播放（语音）',
  'Allow chat — the page may send what you say to the Chief (only for pages you trust)': '允许聊天——网页可以把你说的话发给 Chief（只对你信任的网页开启）',
  'The page receives live activity and Chief messages — protocol: docs/DIGITAL_HUMAN_BACKGROUND.md.': '背景网页会收到实时动态和 Chief 消息——协议见 docs/DIGITAL_HUMAN_BACKGROUND.md。',
  'Blur {n}px': '模糊 {n}px', 'Dim {n}%': '变暗 {n}%', 'Card opacity {n}%': '卡片不透明度 {n}%', 'Apply to': '应用到', 'All devices': '所有设备', 'This device only': '仅本设备',
  'The background page tried to talk to the Chief; enable “Allow chat” in Appearance to let it.': '背景网页想和 Chief 对话；如要允许，请在“外观”里打开“允许聊天”。',
  'Scanning architecture…': '正在扫描架构…', 'Rescan': '重新扫描', 'Change impact': '改动影响', 'Architecture drift': '架构偏离', 'Location': '位置', 'entry': '入口',
  'Depends on': '依赖', 'Used by': '被使用', 'Gates': '检查项', 'Tests': '测试', 'Drift': '偏离', 'none': '无',
  'Click a module to inspect location, dependencies, users, ADRs and tests.': '点一个模块，查看位置、依赖、使用方、ADR 和测试。',
}
