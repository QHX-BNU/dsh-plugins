/**
 * dsh-pwsh-guard — 命令修复器（零依赖）
 *
 * 把 bash 风格 / 从终端粘贴进来的脏文本修成可执行的 PowerShell：
 *   - 行卫生：CRLF、粘贴的提示符、续行符（反斜杠/反引号/缺失续行）
 *   - 语义转换：export/unset、/dev/null、&&/|| 链、ls/rm/mkdir/touch/grep/which/head/tail 等
 *   - 无法安全改写的（sed/awk/chmod）只产出提示，不猜
 *
 * 融合自 GuTianshuo/powershell-fix（MIT，思路借鉴、实现重写）。
 * 约束：幂等（fix(fix(x)) === fix(x)）；正确 PowerShell 原样通过。
 */

import { maskHereStrings, restoreHereStrings } from "./rules.js";

const NL = "\n";

function splitLines(text) {
  return String(text).split(NL);
}

function joinLines(lines) {
  return lines.join(NL);
}

/** 扫描引号外的位置（单引号里两个单引号代表一个）。 */
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
    const stop = fn(i, c);
    if (stop === true) return;
    i++;
  }
}

/** 找到第一个引号外的 && / ||，返回 { index, length, op }。 */
function findTopLevelChain(text) {
  let hit = null;
  eachOutsideQuotes(text, (i, c) => {
    if (c === "&" && text[i + 1] === "&") { hit = { index: i, length: 2, op: "&&" }; return true; }
    if (c === "|" && text[i + 1] === "|") { hit = { index: i, length: 2, op: "||" }; return true; }
    return false;
  });
  return hit;
}

/** PS 单引号字面量：只需把单引号加倍。 */
function psLiteral(value) {
  return "'" + String(value).replace(/'/g, "''") + "'";
}

/* ------------------------------------------------------------------ */
/* 行卫生                                                              */
/* ------------------------------------------------------------------ */

function normLineEndings(text) {
  if (!/\r/.test(text)) return undefined;
  return {
    text: text.replace(/\r\n?/g, NL),
    notes: [{ id: "NORM_LINEENDINGS", zh: "CRLF 统一为 LF", en: "Normalized CRLF to LF" }],
  };
}

function stripPrompts(text) {
  const lines = splitLines(text);
  let changed = false;
  const out = lines.map((line) => {
    const next = line
      .replace(/^\s*PS\s+[A-Za-z]:\\[^>]*>\s?/, "")
      .replace(/^\s*[A-Za-z]:\\[^>]*>\s?/, "")
      .replace(/^\s*\$\s+/, "")
      .replace(/^\s*>\s+/, "");
    if (next !== line) changed = true;
    return next;
  });
  if (!changed) return undefined;
  return { text: joinLines(out), notes: [{ id: "STRIP_PROMPT", zh: "剥离粘贴进来的终端提示符", en: "Stripped pasted shell prompts" }] };
}

function fixContinuations(text) {
  const lines = splitLines(text);
  const notes = [];
  let changed = false;

  for (let i = 0; i < lines.length; i++) {
    const before = lines[i];
    let line = lines[i];

    // 续行符后面的不可见空格会让续行失效
    line = line.replace(/([\\`])[ \t]+$/, "$1");

    // bash 反斜杠续行 -> PowerShell 反引号（只在下一行像续行时转换，避免误伤路径结尾）
    if (/\\[ \t]*$/.test(line) && i + 1 < lines.length) {
      const next = lines[i + 1].trim();
      const looksContinued = /^(-|\||&&|\|\||\.|\{|\(|\[)/.test(next);
      const safeContext = /[ \t]\\[ \t]*$/.test(before) || /\b(curl|wget|npm|npx|pnpm|node|python|git)\b/.test(before);
      if (looksContinued || safeContext) {
        line = line.replace(/\\[ \t]*$/, "`");
        notes.push({ id: "LC_BACKSLASH_TO_BACKTICK", zh: "bash 反斜杠续行改为反引号", en: "Converted a bash backslash continuation to a backtick" });
      }
    }

    // 上一行没有续行符，但下一行是参数行：补反引号
    if (i + 1 < lines.length && line.trim().length > 0 && !/[|,`({[]$/.test(line.trimEnd())) {
      const next = lines[i + 1];
      if (/^\s+-[A-Za-z][A-Za-z0-9]*\b/.test(next)) {
        line = line.replace(/[ \t]*$/, "") + " `";
        notes.push({ id: "LC_MISSING_CONT", zh: "参数行前补上反引号续行", en: "Inserted a backtick before a parameter line" });
      }
    }

    // 悬空反引号（下一行为空）
    if (i + 1 < lines.length && /`[ \t]*$/.test(line) && lines[i + 1].trim().length === 0) {
      line = line.replace(/`[ \t]*$/, "");
      notes.push({ id: "LC_DANGLING_BACKTICK", zh: "删除悬空的反引号续行", en: "Removed a dangling backtick" });
    }

    if (line !== before) changed = true;
    lines[i] = line;
  }

  if (!changed) return undefined;
  return { text: joinLines(lines), notes };
}

function quoteBalanceNote(text) {

  const singleCount = (text.match(/'/g) || []).length;
  const doubleCount = (text.match(/"/g) || []).length;
  if (singleCount % 2 !== 0 || doubleCount % 2 !== 0) {
    return { id: "QUOTE_BALANCE", zh: "引号数量不平衡，请人工确认（未自动改写）", en: "Unbalanced quotes detected (left as-is)" };
  }
  return undefined;
}
/* ------------------------------------------------------------------ */
/* 语义转换                                                            */
/* ------------------------------------------------------------------ */

/** 在引号外做正则替换（引号内原样保留）。 */
function rewriteOutside(text, pattern, replacer) {
  let out = "";
  let i = 0;
  let quote = "";
  while (i < text.length) {
    const c = text[i];
    if (quote === "") {
      if (c === "'") { quote = "'"; out += c; i++; continue; }
      if (c === '"') { quote = '"'; out += c; i++; continue; }
      pattern.lastIndex = i;
      const m = pattern.exec(text);
      if (m && m.index === i) {
        out += replacer(m);
        i += m[0].length;
        continue;
      }
      out += c;
      i++;
      continue;
    }
    if (quote === "'") {
      if (c === "'" && text[i + 1] === "'") { out += "''"; i += 2; continue; }
      if (c === "'") quote = "";
      out += c;
      i++;
      continue;
    }
    if (c === "`") { out += c + (text[i + 1] || ""); i += 2; continue; }
    if (c === '"') quote = "";
    out += c;
    i++;
  }
  return out;
}

function envExport(text) {
  const names = new Set();
  let touched = false;
  const pattern = /(^|[;&|]\s*)export\s+([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|'[^']*'|\S+)/g;
  let out = text.replace(pattern, (match, prefix, name, raw) => {
    touched = true;
    names.add(name);
    let value = raw;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    return prefix + "$env:" + name + "=" + psLiteral(value);
  });
  if (!touched) return undefined;
  const notes = [{ id: "ENV_EXPORT", zh: "export NAME=value 改为 $env:NAME", en: "Converted export NAME=value to $env:NAME" }];
  for (const name of names) {
    const ref = new RegExp("\\$" + name + "(?![A-Za-z0-9_:])", "g");
    const before = out;
    out = rewriteOutside(out, ref, () => "$env:" + name);
    if (out !== before) notes.push({ id: "ENV_LOCAL_REF", zh: "同一段脚本里的 $" + name + " 引用改为 $env:" + name, en: "Rewrote $" + name + " references to $env:" + name });
  }
  return { text: out, notes };
}

function envUnset(text) {
  let touched = false;
  const out = text.replace(/(^|[;&|]\s*)unset\s+([A-Za-z_][A-Za-z0-9_]*)/g, (match, prefix, name) => {
    touched = true;
    return prefix + "if (Test-Path Env:" + name + ") { Remove-Item Env:" + name + " }";
  });
  if (!touched) return undefined;
  return { text: out, notes: [{ id: "ENV_UNSET", zh: "unset NAME 改为 PowerShell 等价写法", en: "Converted unset NAME to its PowerShell equivalent" }] };
}

function devNull(text) {
  if (!/\/dev\/null/.test(text)) return undefined;
  const out = text
    .replace(/&>\s*\/dev\/null/g, "*> $null")
    .replace(/2>\s*\/dev\/null/g, "2> $null")
    .replace(/1>\s*\/dev\/null/g, "> $null")
    .replace(/>\s*\/dev\/null/g, "> $null");
  return { text: out, notes: [{ id: "DEV_NULL", zh: "/dev/null 重定向改为 $null", en: "Replaced /dev/null redirection with $null" }] };
}

function splitChainsInLine(line) {
  const ops = [];
  eachOutsideQuotes(line, (i, c) => {
    if (c === "&" && line[i + 1] === "&") ops.push({ index: i, op: "&&" });
    if (c === "|" && line[i + 1] === "|") ops.push({ index: i, op: "||" });
    return false;
  });
  if (ops.length === 0) return null;
  const segments = [];
  let prev = 0;
  for (const o of ops) {
    segments.push(line.slice(prev, o.index));
    prev = o.index + 2;
  }
  segments.push(line.slice(prev));
  let result = segments[0].trim();
  for (let i = 0; i < ops.length; i++) {
    const seg = segments[i + 1].trim();
    if (seg.length === 0) continue;
    const cond = ops[i].op === "&&" ? "if ($?)" : "if (-not $?)";
    result += "; " + cond + " { " + seg + " }";
  }
  return result;
}

function splitChains(text) {
  const lines = splitLines(text);
  let changed = false;
  const out = lines.map((line) => {
    const fixed = splitChainsInLine(line);
    if (fixed === null) return line;
    changed = true;
    return fixed;
  });
  if (!changed) return undefined;
  return { text: joinLines(out), notes: [{ id: "AND_OR_CHAIN", zh: "&& / || 链拆成 PS 5.1 可执行的 if ($?) 形式", en: "Split && / || chains into PS 5.1-safe if ($?) form" }] };
}
/* ------------------------------------------------------------------ */
/* 命令 shim：常见 bash 命令 -> PowerShell cmdlet                       */
/* ------------------------------------------------------------------ */

const NOTE = (id, zh, en) => ({ id, zh, en });

function shimCommandLine(line) {
  let m;

  m = line.match(/^(\s*)ls\s+(-[A-Za-z]+)(?:\s+([^;&|]*?))?\s*$/);
  if (m && /[aAlL]/.test(m[2])) {
    const force = /[aA]/.test(m[2]) ? " -Force" : "";
    return { line: m[1] + "Get-ChildItem" + (m[3] ? " " + m[3] : "") + force, note: NOTE("LS_FLAGS", "ls -l/-a 改为 Get-ChildItem", "Converted ls -l/-a to Get-ChildItem") };
  }

  m = line.match(/^(\s*)rm\s+(-[A-Za-z]+)(?:\s+([^;&|]*?))?\s*$/);
  if (m && /[rRfF]/.test(m[2]) && m[3]) {
    const recurse = /[rR]/.test(m[2]) ? " -Recurse" : "";
    const force = /[fF]/.test(m[2]) ? " -Force" : "";
    return { line: m[1] + "Remove-Item " + m[3] + recurse + force, note: NOTE("RM_FLAGS", "rm -r/-f 改为 Remove-Item -Recurse/-Force", "Converted rm -r/-f to Remove-Item") };
  }

  m = line.match(/^(\s*)(npm|npx|pnpm)(\s+[^;&|]*)?\s*$/);
  if (m) {
    return { line: m[1] + m[2] + ".cmd" + (m[3] || ""), note: NOTE("PKG_SUFFIX", "裸 npm/npx/pnpm 改为 .cmd 形式", "Suffixed npm/npx/pnpm with .cmd") };
  }

  m = line.match(/^(\s*)mkdir\s+-p\s+([^;&|]+?)\s*$/);
  if (m) {
    return { line: m[1] + "New-Item -ItemType Directory -Force -Path " + m[2], note: NOTE("MKDIR_P", "mkdir -p 改为 New-Item -ItemType Directory -Force", "Converted mkdir -p to New-Item") };
  }

  m = line.match(/^(\s*)touch\s+([^\s;&|]+|"[^"]*"|'[^']*')\s*$/);
  if (m) {
    return {
      line: m[1] + "if (Test-Path " + m[2] + ") { (Get-Item " + m[2] + ").LastWriteTime = Get-Date } else { New-Item -ItemType File -Path " + m[2] + " | Out-Null }",
      note: NOTE("TOUCH", "touch 改为 Test-Path + New-Item/更新时间戳", "Converted touch to New-Item or a timestamp update"),
    };
  }

  m = line.match(/^(\s*)which\s+([^\s;&|]+)\s*$/);
  if (m) {
    return { line: m[1] + "(Get-Command " + m[2] + " -ErrorAction SilentlyContinue).Source", note: NOTE("WHICH", "which 改为 Get-Command", "Converted which to Get-Command") };
  }

  m = line.match(/^(\s*)head\s+(?:-n\s+)?(\d+)\s+([^;&|]+?)\s*$/);
  if (m) {
    return { line: m[1] + "Get-Content " + m[3] + " -TotalCount " + m[2], note: NOTE("HEAD", "head -n 改为 Get-Content -TotalCount", "Converted head -n to Get-Content -TotalCount") };
  }

  m = line.match(/^(\s*)tail\s+-f\s+([^;&|]+?)\s*$/);
  if (m) {
    return { line: m[1] + "Get-Content " + m[2] + " -Wait", note: NOTE("TAIL_F", "tail -f 改为 Get-Content -Wait", "Converted tail -f to Get-Content -Wait") };
  }

  m = line.match(/^(\s*)tail\s+(?:-n\s+)?(\d+)\s+([^;&|]+?)\s*$/);
  if (m) {
    return { line: m[1] + "Get-Content " + m[3] + " -Tail " + m[2], note: NOTE("TAIL", "tail -n 改为 Get-Content -Tail", "Converted tail -n to Get-Content -Tail") };
  }

  m = line.match(/^(\s*)grep\s+((?:-[A-Za-z]+\s+)*)(\S+|"[^"]*"|'[^']*')(?:\s+([^;&|]+?))?\s*$/);
  if (m) {
    const flags = m[2] || "";
    const pattern = m[3];
    const targets = m[4] || "";
    const recurse = /-[A-Za-z]*r/.test(flags);
    const invert = /-[A-Za-z]*v/.test(flags);
    const base = invert ? "Select-String -NotMatch" : "Select-String";
    if (recurse) {
      const root = targets.length > 0 ? targets : ".";
      return {
        line: m[1] + "Get-ChildItem " + root + " -Recurse -File | " + base + " -Pattern " + pattern,
        note: NOTE("GREP_R", "grep -r 改为 Get-ChildItem -Recurse | Select-String", "Converted grep -r to Get-ChildItem | Select-String"),
      };
    }
    return {
      line: m[1] + base + " -Pattern " + pattern + (targets.length > 0 ? " -Path " + targets : ""),
      note: NOTE("GREP", "grep 改为 Select-String", "Converted grep to Select-String"),
    };
  }

  m = line.match(/^(\s*)cp\s+(-[A-Za-z]+)\s+([^;&|]+?)\s*$/);
  if (m) {
    const recurse = /[rR]/.test(m[2]) ? " -Recurse" : "";
    const force = /[fFz]/.test(m[2]) ? " -Force" : "";
    return { line: m[1] + "Copy-Item " + m[3] + recurse + force, note: NOTE("CP_FLAGS", "cp 带参数改为 Copy-Item", "Converted cp flags to Copy-Item") };
  }

  m = line.match(/^(\s*)mv\s+(-[A-Za-z]+)\s+([^;&|]+?)\s*$/);
  if (m) {
    const force = /[fF]/.test(m[2]) ? " -Force" : "";
    return { line: m[1] + "Move-Item " + m[3] + force, note: NOTE("MV_FLAGS", "mv 带参数改为 Move-Item", "Converted mv flags to Move-Item") };
  }

  return null;
}
/* ------------------------------------------------------------------ */
/* 无法安全改写的：只提示                                              */
/* ------------------------------------------------------------------ */

const UNSUPPORTED = [
  { re: /(^|[;&|]\s*)sed\s/, id: "SED", zh: "sed 无直接对应：改用 -replace 或 Select-String（未自动改写）", en: "sed has no direct equivalent: use -replace or Select-String (left as-is)" },
  { re: /(^|[;&|]\s*)awk\s/, id: "AWK", zh: "awk 无直接对应：改用 ForEach-Object + 字符串处理（未自动改写）", en: "awk has no direct equivalent (left as-is)" },
  { re: /(^|[;&|]\s*)chmod\s/, id: "CHMOD", zh: "Windows 没有 chmod：用 icacls 或 ACL 相关 cmdlet（未自动改写）", en: "No chmod on Windows: use icacls (left as-is)" },
  { re: /(^|[;&|]\s*)sudo\s/, id: "SUDO", zh: "没有 sudo：需要管理员权限时用 Start-Process -Verb RunAs 或提升 DSH 权限（未自动改写）", en: "No sudo: elevate explicitly (left as-is)" },
];

function noteUnsupported(text) {
  const notes = [];
  for (const item of UNSUPPORTED) {
    if (item.re.test(text)) notes.push(NOTE(item.id, item.zh, item.en));
  }
  return notes.length > 0 ? { notes } : undefined;
}

/** 顶层分号切分（不追踪大括号，够用即可）。 */
function splitTopLevelSemicolons(line) {
  const parts = [];
  let start = 0;
  eachOutsideQuotes(line, (i, c) => {
    if (c === ";") { parts.push(line.slice(start, i)); start = i + 1; }
    return false;
  });
  parts.push(line.slice(start));
  return parts;
}

/** 处理 if ($?) { <bash command> } 这类块内单命令。 */
function shimIfBlock(line) {
  const m = line.match(/^(\s*if\s*\([^)]*\)\s*\{\s*)([^{}]*?)(\s*\}\s*;?\s*)$/);
  if (!m) return null;
  const inner = shimCommandLine(m[2].trim());
  if (!inner) return null;
  return { line: m[1] + inner.line + m[3], note: inner.note };
}

/** 先整行、再分号分段、再 if 块内命令。 */
function shimLine(line) {
  const direct = shimCommandLine(line);
  if (direct) return { line: direct.line, notes: [direct.note] };
  const parts = splitTopLevelSemicolons(line);
  if (parts.length > 1) {
    const notes = [];
    let changed = false;
    const rebuilt = parts.map((part) => {
      const res = shimLine(part.trim());
      if (res) { changed = true; notes.push(...res.notes); return res.line; }
      return part.trim();
    });
    if (changed) return { line: rebuilt.join("; "), notes };
  }
  const block = shimIfBlock(line);
  if (block) return { line: block.line, notes: [block.note] };
  return null;
}
function shimCommands(text) {
  const lines = splitLines(text);
  const notes = [];
  let changed = false;
  const out = lines.map((line) => {
    const res = shimLine(line);
    if (!res) return line;
    changed = true;
    notes.push(...res.notes);
    return res.line;
  });
  if (!changed) return undefined;
  return { text: joinLines(out), notes };
}

/* ------------------------------------------------------------------ */
/* 对外 API                                                            */
/* ------------------------------------------------------------------ */

const STEPS = [normLineEndings, stripPrompts, fixContinuations, envExport, envUnset, devNull, shimCommands, splitChains, shimCommands, noteUnsupported];

/**
 * 修复一段 bash 风格 / 粘贴脏文本。
 * @param {string} text
 * @returns {{ text: string, notes: Array<{id:string,zh:string,en:string}>, changed: boolean }}
 */
export function fix(text) {
  const source = typeof text === "string" ? text : "";
  const extracted = maskHereStrings(source);
  const blocks = extracted.blocks;
  let out = extracted.masked;
  const notes = [];
  for (const step of STEPS) {
    let res;
    try {
      res = step(out);
    } catch {
      res = undefined;
    }
    if (!res) continue;
    if (typeof res.text === "string") out = res.text;
    if (Array.isArray(res.notes)) notes.push(...res.notes);
  }
  const quoteNote = quoteBalanceNote(out);
  if (quoteNote) notes.push(quoteNote);
  out = restoreHereStrings(out, blocks);
  return { text: out, notes, changed: out !== source };
}

/** 把 notes 渲染成给模型/用户看的多行说明。 */
export function formatNotes(notes, lang = "zh") {
  const zh = lang !== "en";
  return notes.map((n) => "  - " + n[zh ? "zh" : "en"]).join(NL);
}