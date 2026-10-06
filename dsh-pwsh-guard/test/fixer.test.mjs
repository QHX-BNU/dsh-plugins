import { test } from "node:test";
import assert from "node:assert/strict";
import { fix } from "../lib/fixer.js";

const CASES = [
  ["export FOO=bar", (o) => o.includes("$env:FOO='bar'")],
  ["ls -la .", (o) => o === "Get-ChildItem . -Force"],
  ["npm install react", (o) => o === "npm.cmd install react"],
  ["rm -rf ./dist", (o) => o === "Remove-Item ./dist -Recurse -Force"],
  ["mkdir -p a/b/c", (o) => o === "New-Item -ItemType Directory -Force -Path a/b/c"],
  ["which node", (o) => o.includes("Get-Command node")],
  ["tail -f log.txt", (o) => o === "Get-Content log.txt -Wait"],
  ["head -n 10 f.txt", (o) => o === "Get-Content f.txt -TotalCount 10"],
  ["grep -r TODO src", (o) => o === "Get-ChildItem src -Recurse -File | Select-String -Pattern TODO"],
  ["grep -v TODO f.txt", (o) => o === "Select-String -NotMatch -Pattern TODO -Path f.txt"],
  ["unset FOO", (o) => o.includes("Test-Path Env:FOO")],
  ["node app.js > /dev/null", (o) => o === "node app.js > $null"],
  ["cp -r a b", (o) => o === "Copy-Item a b -Recurse"],
  ["mv -f a b", (o) => o === "Move-Item a b -Force"],
  ["touch new.txt", (o) => o.includes("New-Item -ItemType File -Path new.txt")],
];

test("bash -> PowerShell 语义转换", () => {
  for (const [input, check] of CASES) {
    const r = fix(input);
    assert.ok(check(r.text), input + " => " + r.text);
    assert.ok(r.notes.length > 0, input + " 缺少 notes");
  }
});

test("修复是幂等的", () => {
  for (const [input] of CASES) {
    const once = fix(input).text;
    const twice = fix(once).text;
    assert.equal(twice, once, input);
  }
});

test("正确 PowerShell 原样通过", () => {
  const samples = [
    'Get-ChildItem -Recurse -File | Select-String "foo"',
    "if ($x -eq 5) { Write-Output $x }",
    "npm.cmd run build",
    "$o | ConvertTo-Json -Depth 5",
    "Remove-Item -LiteralPath $items.FullName",
  ];
  for (const s of samples) {
    const r = fix(s);
    assert.equal(r.text, s, "unexpected change: " + s);
    assert.equal(r.changed, false);
  }
});

test("&& / || 链拆分并逐段 shim", () => {
  const r1 = fix("git add . && git commit -m x");
  assert.equal(r1.text, 'git add .; if ($?) { git commit -m x }');
  const r2 = fix("npm install x && ls -la .");
  assert.equal(r2.text, "npm.cmd install x; if ($?) { Get-ChildItem . -Force }");
  const r3 = fix("rm -rf a || ls -la");
  assert.equal(r3.text, "Remove-Item a -Recurse -Force; if (-not $?) { Get-ChildItem -Force }");
});

test("继续符处理", () => {
  const r = fix("Get-Item x\n  -Force");
  assert.ok(r.text.startsWith("Get-Item x `"), r.text);
  const r2 = fix("curl -H \"a\" \\\n  -o out.bin https://x");
  assert.ok(r2.text.includes("`\n"), r2.text);
});

test("CRLF 与粘贴提示符", () => {
  const r = fix("PS C:\\Users\\x> Get-ChildItem\r\n$ npm.cmd run build\r\n");
  assert.ok(!r.text.includes("\r"));
  assert.ok(r.text.startsWith("Get-ChildItem"));
  assert.ok(r.text.includes("npm.cmd run build"));
});

test("无法安全改写的只产出提示", () => {
  const r = fix("sed -i 's/a/b/' f.txt");
  assert.ok(r.notes.some((n) => n.id === "SED"));
  assert.ok(r.text.includes("sed"));
});

test("notes 提供中英双语字段", () => {
  const r = fix("npm install x");
  for (const n of r.notes) {
    assert.ok(typeof n.id === "string" && n.id.length > 0);
    assert.ok(typeof n.zh === "string" && n.zh.length > 0);
    assert.ok(typeof n.en === "string" && n.en.length > 0);
  }
});