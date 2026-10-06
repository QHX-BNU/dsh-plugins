/**
 * dsh-pwsh-guard — 破坏性操作识别（自动修复的安全边界）
 *
 * 原则：**自动修复不得成为破坏性操作的执行路径**。
 * 这里只识别"高危"——不可逆、影响系统或用户级数据的操作；
 * 项目目录内的普通递归删除不算高危，不拦。
 */

const REASONS = {
  recursiveDelete: {
    zh: "对根路径 / 盘符 / 用户目录 / 系统目录做递归或强制删除",
    en: "Recursive or forced delete against a root, drive, user, or system path",
  },
  disk: {
    zh: "磁盘或分区级操作（格式化、清盘、建分区、diskpart）",
    en: "Disk or volume-level operation (format, clear, partition, diskpart)",
  },
  execPolicy: {
    zh: "修改执行策略（且不是 -Scope Process）",
    en: "Changing the execution policy outside -Scope Process",
  },
  persistence: {
    zh: "系统/用户级持久化写入（setx、环境变量、Run 注册表项、计划任务、服务）",
    en: "System/user-level persistence (setx, environment, Run keys, scheduled tasks, services)",
  },
  power: {
    zh: "关机 / 重启等系统电源操作",
    en: "System power operation (shutdown / restart)",
  },
};

/** 危险目标：独立根、盘符根、用户主目录、系统目录、以及指向它们的变量。 */
const ROOTISH = [
  /(^|[\s"'=(])\/(?=\s|$|["'])/,
  /(^|[\s"'=(])[A-Za-z]:[\\/](?=\s|$|["']|\*)/,
  /(^|[\s"'=(])[A-Za-z]:[\\/]\*/,
  /(^|[\s"'=(])~(?:[\\/])?(?=\s|$|["'])/,
  /\$(?:env:)?(?:USERPROFILE|HOME|SystemRoot|windir|ProgramFiles|ProgramData|LOCALAPPDATA|APPDATA)\b/i,
  /%(?:USERPROFILE|SystemRoot|windir|ProgramFiles|ProgramData|LOCALAPPDATA|APPDATA)%/i,
  /(^|[\s"'=(])(?:C:\\Users|C:\\Windows|C:\\Program Files|C:\\ProgramData)(?:\\?(?=\s|$|["'])|\\\*)/i,
  /(^|[\s"'=(])[A-Za-z]:\\Users(?:\\?(?=\s|$|["'])|\\\*)/i,
  /(?:C:\\Windows\\(?:System32|SysWOW64|WinSxS|Fonts)|C:\\Program Files(?: \(x86\))?)(?:[\\/]|$)/i,
];

function recursiveDeleteAgainstRoot(text) {
  if (!/\b(Remove-Item|rm|rd|rmdir|del)\b/i.test(text)) return false;
  const recursive = /-(?:Recurse|r|rf|fr)\b/i.test(text) || /\/s\b/i.test(text);
  const forced = /-(?:Force|f)\b/i.test(text) || /\/q\b/i.test(text);
  if (!recursive && !forced) return false;
  return ROOTISH.some((pattern) => pattern.test(text));
}

function diskOperation(text) {
  if (/\b(?:Format-Volume|Clear-Disk|Initialize-Disk|New-Partition|Remove-Partition)\b/i.test(text)) return true;
  if (/\bdiskpart(?:\.exe)?\b/i.test(text)) return true;
  return /\bformat(?:\.com)?\s+[A-Za-z]:/i.test(text);
}

function executionPolicy(text) {
  if (!/\bSet-ExecutionPolicy\b/i.test(text)) return false;
  return !/Set-ExecutionPolicy[^\r\n;]*-Scope\s+Process/i.test(text);
}

function persistence(text) {
  if (/\bsetx(?:\.exe)?\b/i.test(text)) return true;
  if (/\[(?:System\.)?Environment\]\s*::\s*Set(?:Environment)?Variable/i.test(text)) return true;
  if (/\breg(?:\.exe)?\s+add\b/i.test(text) && /\\Run(?:Once)?\b/i.test(text)) return true;
  if (/\bNew-ItemProperty\b/i.test(text) && /\\Run(?:Once)?\b/i.test(text)) return true;
  if (/\bRegister-ScheduledTask\b/i.test(text)) return true;
  return /\bNew-Service\b/i.test(text);
}

/**
 * 评估一段 PowerShell 文本的危险级别。
 * @param {string} script
 * @returns {{ dangerous: boolean, reasons: Array<{ id: string, zh: string, en: string }> }}
 */
export function assessDanger(script) {
  const text = typeof script === "string" ? script : "";
  const hits = new Set();
  if (recursiveDeleteAgainstRoot(text)) hits.add("recursiveDelete");
  if (diskOperation(text)) hits.add("disk");
  if (executionPolicy(text)) hits.add("execPolicy");
  if (persistence(text)) hits.add("persistence");
  if (/\b(?:Stop-Computer|Restart-Computer)\b/i.test(text)) hits.add("power");
  const reasons = [...hits].map((id) => ({ id, ...REASONS[id] }));
  return { dangerous: reasons.length > 0, reasons };
}

/** 渲染危险原因。 */
export function formatDanger(reasons, lang = "zh") {
  const zh = lang !== "en";
  return reasons.map((reason) => "  - [" + reason.id + "] " + reason[zh ? "zh" : "en"]).join("\n");
}