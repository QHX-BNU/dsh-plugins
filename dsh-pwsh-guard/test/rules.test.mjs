import { test } from "node:test";
import assert from "node:assert/strict";
import { check, RULES } from "../lib/rules.js";

/** 断言某条规则命中。 */
function hits(cmd, id) {
  const r = check(cmd);
  return r.hits.some((h) => h.id === id);
}

/** 断言完全没有任何命中。 */
function clean(cmd) {
  const r = check(cmd);
  assert.deepEqual(r.hits.map((h) => h.id), [], "expected clean: " + cmd);
}

test("规则表非空且 id 唯一", () => {
  assert.ok(RULES.length >= 20);
  const ids = RULES.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const rule of RULES) {
    assert.ok(rule.title.zh && rule.title.en, rule.id + " 缺少双语标题");
    assert.ok(rule.fix.zh && rule.fix.en, rule.id + " 缺少双语修复说明");
    assert.ok(rule.level === "blocking" || rule.level === "advisory", rule.id + " level 非法");
  }
});

test("R1 涉及 wsl/DISM 且未固定代码页", () => {
  assert.ok(hits("wsl --status", "R1"));
  assert.ok(!hits("chcp 65001 | Out-Null; wsl --status", "R1"));
});

test("R2 $var: 解析陷阱（作用域前缀豁免）", () => {
  assert.ok(hits("$cfg: value", "R2"));
  assert.ok(!hits("Write-Output \"$env:PATH\"", "R2"));
});

test("R3 三元运算符", () => {
  assert.ok(hits("$x = ($a -gt 1) ? 1 : 0", "R3"));
  assert.ok(!hits("if ($a -gt 1) { $x = 1 } else { $x = 0 }", "R3"));
});

test("R4 双引号内 $NAME. 路径陷阱", () => {
  assert.ok(hits("Write-Host \"C:\\data\\$dir.txt\"", "R4"));
  assert.ok(!hits("Write-Host ('C:\\data\\' + $dir + '.txt')", "R4"));
});

test("R5 Start-Process 包外部命令", () => {
  assert.ok(hits("Start-Process node -ArgumentList \"app.js\"", "R5"));
  assert.ok(!hits("Start-Process 'https://example.com'", "R5"));
});

test("R6 -FeatureName 逗号数组", () => {
  assert.ok(hits("Enable-WindowsOptionalFeature -Online -FeatureName A, B", "R6"));
  assert.ok(!hits("Enable-WindowsOptionalFeature -Online -FeatureName A", "R6"));
});

test("R7 DISM 动词", () => {
  assert.ok(hits("dism /Dismount-Image /MountDir:C:\\mnt", "R7"));
  assert.ok(!hits("dism /Unmount-Image /MountDir:C:\\mnt /Discard", "R7"));
});

test("R8 RestoreHealth 带 Source", () => {
  assert.ok(hits("DISM /Online /Cleanup-Image /RestoreHealth /Source:wim:D:\\x", "R8"));
  assert.ok(!hits("DISM /Online /Cleanup-Image /RestoreHealth", "R8"));
});

test("R9 curl -L 与 -C -", () => {
  assert.ok(hits("curl -L -C - https://example.com/f.bin -o f.bin", "R9"));
  assert.ok(!hits("curl -L https://example.com/f.bin -o f.bin", "R9"));
});

test("R10 裸 npm/npx/pnpm", () => {
  assert.ok(hits("npm install react", "R10"));
  assert.ok(hits("pnpm add x", "R10"));
  assert.ok(!hits("npm.cmd install react", "R10"));
});

test("R11 && / || 链（引号内豁免）", () => {
  assert.ok(hits("git add . && git commit -m x", "R11"));
  assert.ok(hits("a || b", "R11"));
  assert.ok(!hits('git commit -m "a && b"', "R11"));
});

test("R12 ConvertTo-Json 缺 -Depth", () => {
  assert.ok(hits("$o | ConvertTo-Json", "R12"));
  assert.ok(!hits("$o | ConvertTo-Json -Depth 5", "R12"));
});

test("R13 foreach 里用 $_", () => {
  assert.ok(hits("foreach ($x in $list) { $_ }", "R13"));
  assert.ok(!hits("foreach ($x in $list) { $x }", "R13"));
  assert.ok(!hits("foreach ($x in $list) { $x }; $list | Where-Object { $_ }", "R13"));
});

test("R14 if/while 条件里单等号（字符串内豁免）", () => {
  assert.ok(hits("if ($x = 5) { Write-Output hi }", "R14"));
  assert.ok(hits("while ($i = 1) { $i++ }", "R14"));
  assert.ok(!hits("if ($x -eq 5) { Write-Output hi }", "R14"));
  assert.ok(!hits('if ($s -match "a=b") { Write-Output hi }', "R14"));
});

test("R15 PS 7+ 语法", () => {
  assert.ok(hits("Get-Content f -AsByteStream", "R15"));
  assert.ok(hits("$a ?? $b", "R15"));
  assert.ok(!hits("Get-Content f -Encoding Byte", "R15"));
});

test("R16 cmd 风格", () => {
  assert.ok(hits("del file.txt", "R16"));
  assert.ok(hits("echo %PATH%", "R16"));
  assert.ok(!hits("Remove-Item file.txt", "R16"));
});

test("R17 Write-Host", () => {
  assert.ok(hits("Write-Host hello", "R17"));
  assert.ok(!hits("Write-Output hello", "R17"));
});

test("R18 乱码痕迹", () => {
  assert.ok(hits("Write-Output \"锟斤拷\"", "R18"));
  assert.ok(!hits("Write-Output \"你好\"", "R18"));
});

test("R19 Remove-Item 位置对象", () => {
  assert.ok(hits("$items = Get-ChildItem; Remove-Item $items", "R19"));
  assert.ok(!hits("$items = Get-ChildItem; Remove-Item -LiteralPath $items.FullName", "R19"));
});

test("R20 只读沙箱下的 .NET 静态调用", () => {
  assert.ok(hits("[math]::Round(1.5)", "R20"));
  assert.ok(hits("[System.IO.File]::ReadAllText(\"x\")", "R20"));
  assert.ok(!hits("Get-Content x -Raw", "R20"));
});

test("R21 内联 -Command 下 PSScriptRoot", () => {
  assert.ok(hits("$p = $PSScriptRoot", "R21"));
  assert.ok(!hits("$p = $args[0]", "R21"));
});

test("R22 原生程序内联代码 + 引号", () => {
  assert.ok(hits("node -e \"console.log(1)\"", "R22"));
  assert.ok(!hits("node app.js", "R22"));
});

test("干净命令零命中", () => {
  clean('Get-ChildItem -Recurse -File | Select-String "foo"');
  clean("if ($a -eq 1) { Write-Output $a }");
  clean("npm.cmd run build");
  clean("$o | ConvertTo-Json -Depth 5");
});

test("check 支持禁用规则", () => {
  const r = check("git add . && git commit -m x", { disabled: ["R11"] });
  assert.ok(!r.hits.some((h) => h.id === "R11"));
});

test("blocking / advisory 分级正确", () => {
  const r = check("npm install x; Write-Host hi");
  assert.ok(r.blocking.some((h) => h.id === "R10"));
  assert.ok(r.advisory.some((h) => h.id === "R17"));
});