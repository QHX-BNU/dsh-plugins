import { test } from "node:test";
import assert from "node:assert/strict";
import { assessDanger, formatDanger } from "../lib/danger.js";

const DANGEROUS = [
  ["rm -rf /", "recursiveDelete"],
  ["rm -rf C:\\", "recursiveDelete"],
  ["rm -rf ~", "recursiveDelete"],
  ["Remove-Item -Recurse -Force C:\\", "recursiveDelete"],
  ["Remove-Item $env:USERPROFILE -Recurse -Force", "recursiveDelete"],
  ["Remove-Item C:\\Users -Recurse -Force", "recursiveDelete"],
  ["rd /s /q C:\\Windows", "recursiveDelete"],
  ["Format-Volume -DriveLetter D", "disk"],
  ["Clear-Disk -Number 1 -RemoveData", "disk"],
  ["diskpart", "disk"],
  ["Set-ExecutionPolicy Unrestricted -Force", "execPolicy"],
  ['setx PATH "C:\\x"', "persistence"],
  ['[Environment]::SetEnvironmentVariable("A","1","User")', "persistence"],
  ["reg add HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run /v X /d y", "persistence"],
  ["Register-ScheduledTask -TaskName bad", "persistence"],
  ["New-Service -Name x -BinaryPathName y", "persistence"],
  ["Restart-Computer -Force", "power"],
];

const SAFE = [
  "rm -rf ./dist",
  "Remove-Item ./node_modules -Recurse -Force",
  "Remove-Item C:\\Users\\me\\project\\build -Recurse -Force",
  "Get-ChildItem -Recurse -File | Select-String TODO",
  "Write-Output hello",
  "npm.cmd install x",
  "Set-ExecutionPolicy Bypass -Scope Process -Force",
  "Copy-Item a b -Recurse",
  "Remove-Item ./tmp -Force",
];

test("高危操作被识别", () => {
  for (const [script, id] of DANGEROUS) {
    const result = assessDanger(script);
    assert.equal(result.dangerous, true, script);
    assert.ok(result.reasons.some((r) => r.id === id), script + " -> " + JSON.stringify(result.reasons));
  }
});

test("常规操作不误报", () => {
  for (const script of SAFE) {
    const result = assessDanger(script);
    assert.equal(result.dangerous, false, script + " -> " + JSON.stringify(result.reasons));
  }
});

test("formatDanger 双语渲染", () => {
  const { reasons } = assessDanger("rm -rf /");
  assert.match(formatDanger(reasons, "zh"), /根路径/);
  assert.match(formatDanger(reasons, "en"), /root/);
});