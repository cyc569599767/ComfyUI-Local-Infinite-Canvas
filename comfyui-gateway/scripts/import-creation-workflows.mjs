import fs from "node:fs";
import path from "node:path";
import { ALL_CREATION_WORKFLOWS as CREATION_WORKFLOWS, prepareCreationTemplate } from "../src/creation-workflows.js";

const sourceDir = process.argv[2];
if (!sourceDir) throw new Error("请传入参考项目的 workflows 目录。");
const targetDir = path.resolve(import.meta.dirname, "../workflows");
const registryFile = path.join(targetDir, "registry.json");
const original = fs.readFileSync(registryFile, "utf8");
const registry = JSON.parse(original);
const missing = [];
for (const entry of CREATION_WORKFLOWS) {
  const source = JSON.parse(fs.readFileSync(path.join(entry.source.bundled ? targetDir : sourceDir, entry.source.file), "utf8"));
  const template = prepareCreationTemplate(source, entry);
  const target = path.join(targetDir, entry.file);
  const existing = registry.workflows.find((item) => item.id === entry.id);
  if (existing && JSON.stringify(existing) !== JSON.stringify(entry)) throw new Error(`已存在不同的注册项，拒绝覆盖：${entry.id}`);
  if (fs.existsSync(target)) {
    if (JSON.stringify(JSON.parse(fs.readFileSync(target, "utf8"))) !== JSON.stringify(template)) throw new Error(`已存在不同的模板，拒绝覆盖：${target}`);
  } else {
    fs.writeFileSync(target, `${JSON.stringify(template, null, 2)}\n`, { flag: "wx" });
  }
  if (!existing) missing.push(entry);
}
if (missing.length) {
  // 仅插入新行，既有注册项与工作流文件均不重写。
  const insertion = missing.map((entry) => JSON.stringify(entry, null, 2).split("\n").map((line) => `    ${line}`).join("\n")).join(",\n");
  const prefix = /("workflows"\s*:\s*\[)\s*/;
  if (!prefix.test(original)) throw new Error("注册表格式无效。");
  const updated = original.replace(prefix, `$1\n${insertion}${registry.workflows.length ? "," : ""}\n${registry.workflows.length ? "    " : "  "}`);
  JSON.parse(updated);
  fs.writeFileSync(registryFile, updated);
}
console.log(`已校验 ${CREATION_WORKFLOWS.length} 张完整模板，新增 ${missing.length} 个注册 ID。`);
