/**
 * dsh-pwsh-guard — PowerShell 静态检查规则引擎（零依赖）
 *
 * 规则集融合自社区两个 MIT 项目（思路借鉴、实现重写）：
 *   - chaggle/dsh-powershell-check 的 R1–R19 坑位表（《PowerShell 实战踩坑大全》）
 *   - GuTianshuo/powershell-fix 的 Windows/PS 5.1 兼容思路
 * 并补充本机实测的 DSH 沙箱环境规则（R20–R22）。
 *
 * 设计取向：阻断级（blocking）只放几乎必然出错的规则（语法/环境硬错误），
 * 其余全部 advisory，避免误杀正常命令。可通过 config 关闭单条规则。
 *
 * 导出：RULES / check / formatHits
 */

const NL = "\n";

/** $env: 这类合法作用域前缀，不算 R2 的 $var: 解析陷阱。 */
const KNOWN_SCOPES = new Set([
  "env", "script", "global", "local", "private", "using", "function", "variable",
  "PSDefaultParameterValues", "PSScriptRoot", "PSCommandPath", "PSCmdlet", "PID",
  "true", "false", "null", "args", "input", "this", "_",
]);

function isWordChar(c) {
  return (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || (c >= "0" && c <= "9") || c === "_";
}

function hasWord(text, word) {
  const low = text.toLowerCase();
  const w = word.toLowerCase();
  let idx = 0;
  while ((idx = low.indexOf(w, idx)) >= 0) {
    const before = idx > 0 ? low[idx - 1] : "";
    const after = idx + w.length < low.length ? low[idx + w.length] : "";
    if (!isWordChar(before) && !isWordChar(after)) return true;
    idx += w.length;
  }
  return false;
}
/** 收集 $name / ${name} 出现位置。 */
function findVars(text) {
  const res = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "$") continue;
    if (text[i + 1] === "{") {
      let j = i + 2;
      while (j < text.length && (isWordChar(text[j]) || text[j] === ":")) j++;
      if (text[j] === "}") {
        res.push({ start: i, end: j + 1, braced: true, name: text.slice(i + 2, j), followedBy: text[j + 1] || "" });
        i = j;
      }
      continue;
    }
    if (!isWordChar(text[i + 1] || "")) continue;
    let j = i + 1;
    while (j < text.length && isWordChar(text[j])) j++;
    res.push({ start: i, end: j, braced: false, name: text.slice(i + 1, j), followedBy: text[j] || "" });
    i = j - 1;
  }
  return res;
}

/** 逐字符扫描引号外的文本（单引号转义为两个单引号，双引号转义为反引号）。 */
function eachOutsideQuotes(text, fn) {
  let i = 0;
  let quote = "";
  while (i < text.length) {
    const c = text[i];
    if (quote === "'") {
      if (c === "'") {
        if (text[i + 1] === "'") { i += 2; continue; }
        quote = "";
      }
      i++;
      continue;
    }
    if (quote === '"') {
      if (c === "`") { i += 2; continue; }
      if (c === '"') quote = "";
      i++;
      continue;
    }
    if (c === "'") { quote = "'"; i++; continue; }
    if (c === '"') { quote = '"'; i++; continue; }
    fn(i, c);
    i++;
  }
}

/** 去掉引号内的内容，便于条件表达式扫描。 */
function stripQuoted(text) {
  let out = "";
  let i = 0;
  let quote = "";
  while (i < text.length) {
    const c = text[i];
    if (quote === "'") {
      if (c === "'") { if (text[i + 1] === "'") { i += 2; continue; } quote = ""; }
      i++;
      continue;
    }
    if (quote === '"') {
      if (c === "`") { i += 2; continue; }
      if (c === '"') quote = "";
      i++;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; i++; continue; }
    out += c;
    i++;
  }
  return out;
}
/* ------------------------------------------------------------------ */
/* 检测函数（每条对应一个坑位）                                          */
/* ------------------------------------------------------------------ */

/** R1：涉及 wsl / DISM / Windows 特性时未固定代码页，中文输出易乱码。 */
/** 把 here-string 块替换为占位符（保留换行数），避免规则误报块内数据。 */
export function maskHereStrings(text) {
  const blocks = [];
  const re = /@(['"])\r?\n([\s\S]*?)\r?\n[ \t]*\1@/g;
  const masked = String(text).replace(re, (match) => {
    const index = blocks.length;
    blocks.push(match);
    const newlines = (match.match(/\n/g) || []).length;
    return "__DSH_GUARD_HERESTRING_" + index + "__" + "\n".repeat(newlines);
  });
  return { masked, blocks };
}

/** 还原 here-string 占位符。 */
export function restoreHereStrings(text, blocks) {
  return String(text).replace(/__DSH_GUARD_HERESTRING_(\d+)__/g, (match, i) => {
    const block = blocks[Number(i)];
    return typeof block === "string" ? block : match;
  });
}

/** 把引号内字符替换为空格（保留长度），用于只看代码区的规则。 */
export function blankQuoted(text) {
  let out = "";
  let i = 0;
  let quote = "";
  while (i < text.length) {
    const c = text[i];
    if (quote === "") {
      if (c === "'" || c === '"') { quote = c; out += " "; i++; continue; }
      out += c; i++; continue;
    }
    if (quote === "'") {
      if (c === "'" && text[i + 1] === "'") { out += "  "; i += 2; continue; }
      if (c === "'") quote = "";
      out += " ";
      i++;
      continue;
    }
    if (c === "`") { out += "  "; i += 2; continue; }
    if (c === '"') quote = "";
    out += " ";
    i++;
  }
  return out;
}

function r1Gbk(cmd) {

  const risky = hasWord(cmd, "wsl")
    || /Get-WindowsOptionalFeature|Enable-WindowsOptionalFeature|Disable-WindowsOptionalFeature|RestoreHealth|Cleanup-Image|dism(\.exe)?\b/i.test(cmd);
  if (!risky) return false;
  if (hasWord(cmd, "chcp") || /65001|OutputEncoding/i.test(cmd)) return false;
  return true;
}

/** R2：$var: 被解析成驱动器限定语法（需写 ${var}:）。 */
function r2VarColon(cmd) {
  return findVars(cmd).some((v) => !v.braced && v.followedBy === ":" && !KNOWN_SCOPES.has(v.name));
}

/** R3：PS 5.1 没有三元运算符 ) ? a : b。 */
function r3Ternary(cmd) {
  const code = blankQuoted(cmd);
  for (let i = 0; i < code.length - 1; i++) {
    if (code[i] !== ")") continue;
    let j = i + 1;
    while (j < code.length && (code[j] === " " || code[j] === "\t" || code[j] === "\n" || code[j] === "\r")) j++;
    if (code[j] === "?" && code[j + 1] !== "?") return true;
  }
  return false;
}

/** R4：双引号内 $NAME. 被当成属性访问，路径会解析成空。 */
function r4DoubleQuoteVarPath(cmd) {
  let i = 0;
  while (i < cmd.length) {
    if (cmd[i] !== '"') { i++; continue; }
    i++;
    while (i < cmd.length) {
      const c = cmd[i];
      if (c === "`") { i += 2; continue; }
      if (c === '"') { i++; break; }
      if (c === "$") {
        if (cmd[i + 1] === "{") {
          const close = cmd.indexOf("}", i + 2);
          i = close >= 0 ? close + 1 : cmd.length;
          continue;
        }
        let j = i + 1;
        while (j < cmd.length && isWordChar(cmd[j])) j++;
        if (j > i + 1 && cmd[j] === "." && !KNOWN_SCOPES.has(cmd.slice(i + 1, j))) return true;
        i = j;
        continue;
      }
      i++;
    }
  }
  return false;
}

/** R5：Start-Process 包裹外部命令——-ArgumentList 引号规则与沙箱行为都容易踩坑。 */
function r5StartProcess(cmd) {
  if (!/\bStart-Process\b/i.test(cmd)) return false;
  return /\b(node|npm|npx|pnpm|python|python3|git|curl|wsl|java|dotnet|ffmpeg|pwsh|powershell|cmd)(\.exe|\.cmd|\.bat)?\b/i.test(cmd);
}

/** R6：-FeatureName A, B 会被当作单个参数。 */
function r6FeatureNameArray(cmd) {
  return /-FeatureName\s+[^\s,;]+\s*,/i.test(cmd);
}

/** R7：DISM 没有 /Dismount-Image 动词（正确写法 /Unmount-Image）。 */
function r7Dismount(cmd) {
  return /\/Dismount-Image\b/i.test(cmd);
}

/** R8：RestoreHealth 带 /Source 时源版本必须不高于当前版本。 */
function r8RestoreHealthSource(cmd) {
  return /RestoreHealth/i.test(cmd) && /\/Source\b/i.test(cmd);
}

/** R9：curl -L 与 -C - 混用（续传语义冲突）。 */
function r9CurlResume(cmd) {
  if (!hasWord(cmd, "curl")) return false;
  return /(^|\s)-C\s+-/.test(cmd) && /(^|\s)-L\b/.test(cmd);
}

/** R10：裸 npm/npx/pnpm 在 PS 5.1 会命中 npm.ps1 执行策略而失败。 */
function r10BarePackageManager(cmd) {
  return /(^|[;&|(\s"'])(npm|npx|pnpm)(?![\w.-])/i.test(cmd);
}

/** R11：PS 5.1 没有 && / || 链式运算符（引号外的才算）。 */
function r11AndOrChain(cmd) {
  let found = false;
  eachOutsideQuotes(cmd, (i, c) => {
    if (found) return;
    if ((c === "&" && cmd[i + 1] === "&") || (c === "|" && cmd[i + 1] === "|")) found = true;
  });
  return found;
}
/** R12：ConvertTo-Json 默认 -Depth 2，嵌套数据会被截断。 */
function r12JsonDepth(cmd) {
  return /ConvertTo-Json/i.test(cmd) && !/-Depth\b/i.test(cmd);
}

/** R13：foreach ($x in ...) 的循环体里用 $_（$_ 只属于管道与 ForEach-Object）。 */
function r13ForeachUnderscore(cmd) {
  const re = /foreach\s*\(\s*\$\w+\s+in\b[^)]*\)\s*\{/gi;
  let m;
  while ((m = re.exec(cmd))) {
    let i = re.lastIndex;
    let depth = 1;
    let body = "";
    while (i < cmd.length && depth > 0) {
      const c = cmd[i];
      if (c === "{") depth++;
      else if (c === "}") { depth--; if (depth === 0) break; }
      body += c;
      i++;
    }
    if (/\$_/.test(body)) return true;
    re.lastIndex = i;
  }
  return false;
}

/** R14：if/while 条件里把 = 当比较（条件恒真）。 */
function r14SingleEqualsCondition(cmd) {
  const re = /\b(?:if|while)\s*\(/gi;
  let m;
  while ((m = re.exec(cmd))) {
    let i = m.index + m[0].length;
    let depth = 1;
    let inside = "";
    while (i < cmd.length && depth > 0) {
      const c = cmd[i];
      if (c === "(") depth++;
      else if (c === ")") { depth--; if (depth === 0) break; }
      inside += c;
      i++;
    }
    const clean = stripQuoted(inside);
    if (/(^|[^=<>!+\-*/%&|^:])=(?!=)/.test(clean)) return true;
    re.lastIndex = i;
  }
  return false;
}

/** R15：PS 7+ 才有的参数与运算符（5.1 上直接报错）。 */
function r15Ps7Only(cmd) {
  if (/-(AsHashtable|Parallel|AsByteStream)\b/i.test(cmd)) return true;
  return /\?\?|\?\./.test(cmd);
}

/** R16：cmd.exe 风格命令与 %VAR% 环境变量。 */
function r16CmdStyle(cmd) {
  if (/%[A-Za-z_][A-Za-z0-9_]*%/.test(cmd)) return true;
  return /(^|[;&|(\s])(copy|del|move|ren|rd|set|md)\s/i.test(cmd);
}

/** R17：Write-Host 只写控制台，管道捕获不到。 */
function r17WriteHost(cmd) {
  return /\bWrite-Host\b/i.test(cmd);
}

/** R18：文本里已带乱码痕迹（UTF-8 被当 ANSI/GBK 读过的迹象）。 */
function r18Mojibake(cmd) {
  return /锟斤拷|�|ï»¿|Â[\u0080-\u00bf]/.test(cmd);
}

/** R19：Remove-Item 直接吃 FileSystemInfo 对象（应传 .FullName 或 -Path）。 */
function r19RemoveItemObject(cmd) {
  if (!/\bRemove-Item\b/i.test(cmd)) return false;
  const re = /\bRemove-Item\b([^\r\n;|]*)/gi;
  let m;
  while ((m = re.exec(cmd))) {
    const tail = m[1];
    if (/-LiteralPath\b|-Path\b/i.test(tail)) continue;
    if (/\$[A-Za-z_]\w*(\.(FullName|PSPath))?/.test(tail)) return true;
  }
  return false;
}

/** R20（DSH 环境）：只读沙箱下 .NET 静态调用 / Add-Type / COM 会因 ConstrainedLanguage 失败。 */
function r20ConstrainedLanguage(cmd) {
  if (/\[System\.[A-Za-z.]+\]::/.test(cmd)) return true;
  if (/\bAdd-Type\b/i.test(cmd)) return true;
  if (/\bNew-Object\s+-ComObject\b/i.test(cmd)) return true;
  return /\[Reflection\.|\[math\]::/i.test(cmd);
}

/** R21：内联 -Command 下 $PSScriptRoot / $MyInvocation 为空。 */
function r21ScriptRoot(cmd) {
  return /\$PSScriptRoot\b|\$MyInvocation\b/.test(cmd);
}

/** R22（PS 5.1）：给原生程序传含引号的内联代码（参数会被吞掉且不报错）。 */
function r22NativeQuoting(cmd) {
  const inlineCode = /\b(node|python|python3|pip|perl|ruby)(\.exe)?\s+[^\r\n]*-(e|c)\s+/i.test(cmd);
  if (!inlineCode) return false;
  return /"/.test(cmd);
}
/* ------------------------------------------------------------------ */
/* 规则表                                                              */
/* ------------------------------------------------------------------ */

export const RULES = [
  { id: "R1", level: "advisory",
    title: { zh: "涉及 WSL/DISM 输出时未固定代码页（GBK 乱码）", en: "WSL/DISM output without a pinned code page (GBK mojibake)" },
    fix: { zh: "命令前加 `chcp 65001 | Out-Null`，或用 pwsh_run（已内置 UTF-8 前导）", en: "Prefix `chcp 65001 | Out-Null`, or use pwsh_run (UTF-8 prelude built in)" },
    test: r1Gbk },
  { id: "R2", level: "blocking",
    title: { zh: "$var: 被解析为驱动器限定语法", en: "$var: parsed as drive-qualified syntax" },
    fix: { zh: "写成 ${var}: 形式，例如 ${name}: 内容", en: "Write ${var}:, e.g. ${name}: text" },
    test: r2VarColon },
  { id: "R3", level: "blocking",
    title: { zh: "PS 5.1 没有三元运算符 ?:", en: "PS 5.1 has no ternary ?:" },
    fix: { zh: "改用 if/else 赋值；确实需要 PS 7 时用 pwsh_run 并先确认 pwsh 可用", en: "Use if/else assignment; for PS 7 install pwsh and run via pwsh_run" },
    test: r3Ternary },
  { id: "R4", level: "advisory",
    title: { zh: "双引号内 $NAME. 被当作属性访问", en: "$NAME. inside double quotes parses as property access" },
    fix: { zh: "改用单引号，或写成 ${NAME}. 表示字面量点号", en: "Use single quotes, or ${NAME}. for a literal dot" },
    test: r4DoubleQuoteVarPath },
  { id: "R5", level: "blocking",
    title: { zh: "Start-Process 包裹外部命令：引号与沙箱陷阱", en: "Start-Process wrapping an external command" },
    fix: { zh: "改为直接调用 & exe arg；需要后台或新窗口时再显式使用 -ArgumentList 数组", en: "Call & exe arg directly; only use Start-Process with an explicit -ArgumentList array" },
    test: r5StartProcess },
  { id: "R6", level: "blocking",
    title: { zh: "-FeatureName A, B 逗号数组形式无效", en: "-FeatureName A, B array form does not work" },
    fix: { zh: "用 foreach 逐个启用，每次只传一个特性名", en: "Loop with foreach, one feature name per call" },
    test: r6FeatureNameArray },
  { id: "R7", level: "blocking",
    title: { zh: "DISM 没有 /Dismount-Image 动词", en: "DISM has no /Dismount-Image verb" },
    fix: { zh: "改用 /Unmount-Image /MountDir:... /Discard", en: "Use /Unmount-Image /MountDir:... /Discard" },
    test: r7Dismount },
  { id: "R8", level: "advisory",
    title: { zh: "RestoreHealth 带 /Source：源版本必须不高于当前版本", en: "RestoreHealth with /Source requires a source no newer than the image" },
    fix: { zh: "确认源 install.wim 版本不高于当前系统，否则改用 Windows Update 源", en: "Verify the source build is not newer than the running image" },
    test: r8RestoreHealthSource },
  { id: "R9", level: "advisory",
    title: { zh: "curl -L 与 -C - 混用（续传语义冲突）", en: "curl -L combined with -C -" },
    fix: { zh: "改用并行分片 -r a-b，或去掉 -C - 后重新下载", en: "Use parallel -r ranges, or drop -C - and re-download" },
    test: r9CurlResume },
  { id: "R10", level: "blocking",
    title: { zh: "裸 npm/npx/pnpm 会命中 npm.ps1 执行策略", en: "Bare npm/npx/pnpm hits the npm.ps1 execution policy" },
    fix: { zh: "显式写 npm.cmd run ... / npx.cmd ... / pnpm.cmd ...", en: "Use npm.cmd / npx.cmd / pnpm.cmd explicitly" },
    test: r10BarePackageManager },
  { id: "R11", level: "blocking",
    title: { zh: "PowerShell 5.1 不支持 && / || 链（引号外）", en: "PowerShell 5.1 has no && / || chains" },
    fix: { zh: "改分行用 ;，写成 if ($LASTEXITCODE -eq 0) { ... }，或直接用 pwsh_run（内部自动拆链）", en: "Use ; / separate lines or if ($LASTEXITCODE -eq 0) { ... }; pwsh_run splits chains automatically" },
    test: r11AndOrChain },  { id: "R12", level: "advisory",
    title: { zh: "ConvertTo-Json 缺 -Depth（默认 2 会截断嵌套）", en: "ConvertTo-Json without -Depth truncates nested data" },
    fix: { zh: "加 -Depth 100", en: "Add -Depth 100" },
    test: r12JsonDepth },
  { id: "R13", level: "advisory",
    title: { zh: "foreach ($x in ...) 里用了 $_", en: "$_ used inside a foreach ($x in ...) loop" },
    fix: { zh: "改用循环变量 $x，或换成 ForEach-Object", en: "Use the loop variable, or switch to ForEach-Object" },
    test: r13ForeachUnderscore },
  { id: "R14", level: "blocking",
    title: { zh: "if/while 条件里单 = 是赋值不是比较", en: "Single = assigns instead of comparing" },
    fix: { zh: "比较用 -eq：if ($x -eq 5)", en: "Compare with -eq: if ($x -eq 5)" },
    test: r14SingleEqualsCondition },
  { id: "R15", level: "advisory",
    title: { zh: "使用了 PS 7+ 专有语法", en: "PS 7+ only syntax detected" },
    fix: { zh: "确认运行在 PS 7；本机 DSH 默认 PS 5.1，否则改用 5.1 等价写法", en: "Confirm PS 7; the local DSH defaults to PS 5.1" },
    test: r15Ps7Only },
  { id: "R16", level: "advisory",
    title: { zh: "cmd.exe 风格命令或 %VAR% 环境变量", en: "cmd-style command or %VAR% syntax" },
    fix: { zh: "改用 PowerShell cmdlet（Get-ChildItem / Copy-Item / Remove-Item）与 $env:VAR", en: "Use PowerShell cmdlets and $env:VAR" },
    test: r16CmdStyle },
  { id: "R17", level: "advisory",
    title: { zh: "Write-Host 输出不进管道", en: "Write-Host output bypasses the pipeline" },
    fix: { zh: "需要捕获结果用 Write-Output 或直接输出表达式；仅进度提示用 Write-Host", en: "Use Write-Output for capturable results" },
    test: r17WriteHost },
  { id: "R18", level: "advisory",
    title: { zh: "文本已含乱码痕迹", en: "Text already contains mojibake artifacts" },
    fix: { zh: "重新生成该段文本；.ps1 用 UTF-8 with BOM 保存", en: "Regenerate the text; save .ps1 as UTF-8 with BOM" },
    test: r18Mojibake },
  { id: "R19", level: "advisory",
    title: { zh: "Remove-Item 直接吃对象（FileSystemInfo）可能删错目标", en: "Remove-Item with a positional FileSystemInfo object" },
    fix: { zh: "传 -LiteralPath $items.FullName，或管道 $items | Remove-Item", en: "Pass -LiteralPath $items.FullName, or pipe the items" },
    test: r19RemoveItemObject },
  { id: "R20", level: "advisory",
    title: { zh: "只读沙箱下 .NET 静态调用/Add-Type/COM 会失败（ConstrainedLanguage）", en: "ConstrainedLanguage blocks .NET static calls / Add-Type / COM under read-only sandbox" },
    fix: { zh: "改用核心 cmdlet；确实需要 FullLanguage 时在 pwsh 调用上申请 workspace-write", en: "Prefer core cmdlets; request workspace-write when FullLanguage is required" },
    test: r20ConstrainedLanguage },
  { id: "R21", level: "advisory",
    title: { zh: "内联 -Command 下 $PSScriptRoot / $MyInvocation 为空", en: "$PSScriptRoot / $MyInvocation are empty under inline -Command" },
    fix: { zh: "改写成 .ps1 文件后执行，或用 pwsh_run 的 args 显式传路径", en: "Write a .ps1 and run it, or pass the path explicitly via args" },
    test: r21ScriptRoot },
  { id: "R22", level: "advisory",
    title: { zh: "PS 5.1 给原生程序传引号参数会被吞掉（且不报错）", en: "PS 5.1 silently strips embedded quotes passed to native programs" },
    fix: { zh: "改用 run_argv（argv 直传，不经 shell），或把代码写进临时文件再传路径", en: "Use run_argv (shell-free argv) or pass a temp-file path" },
    test: r22NativeQuoting },
];

/* ------------------------------------------------------------------ */
/* 对外 API                                                            */
/* ------------------------------------------------------------------ */

/**
 * 静态检查一段 PowerShell 文本。
 * @param {string} text 命令或脚本
 * @param {{ disabled?: string[] }} [options] 需要跳过的规则 id
 * @returns {{ hits: Array, blocking: Array, advisory: Array }}
 */
export function check(text, options = {}) {
  const raw = typeof text === "string" ? text : "";
  const disabled = new Set(options.disabled || []);
  const hits = [];
  if (raw.trim().length === 0) return { hits, blocking: [], advisory: [] };
  const cmd = maskHereStrings(raw).masked;
  for (const rule of RULES) {
    if (disabled.has(rule.id)) continue;
    let matched = false;
    try {
      matched = rule.test(cmd) === true;
    } catch {
      matched = false;
    }
    if (matched) hits.push({ id: rule.id, level: rule.level, title: rule.title, fix: rule.fix });
  }
  return {
    hits,
    blocking: hits.filter((h) => h.level === "blocking"),
    advisory: hits.filter((h) => h.level === "advisory"),
  };
}

/**
 * 把命中结果格式化成模型可读的修复指引。
 * @param {Array} hits check().hits 的子集
 * @param {"zh"|"en"} lang 输出语言
 */
export function formatHits(hits, lang = "zh") {
  const zh = lang !== "en";
  const lines = [];
  for (const hit of hits) {
    lines.push("  [" + hit.id + "] " + hit.title[zh ? "zh" : "en"]);
    lines.push("      " + (zh ? "修复" : "Fix") + ": " + hit.fix[zh ? "zh" : "en"]);
  }
  return lines.join(NL);
}