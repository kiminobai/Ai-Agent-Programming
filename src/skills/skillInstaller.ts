import fs from "node:fs";
import path from "node:path";
import {
  clearSkillRegistryCache,
  listAgentSkills,
  parseSkillFile
} from "./skillRegistry";
import { getThreadSkillsRoot } from "../extensions/threadExtensionStorage";

export function installSkillFromPath(sourcePath: string, threadId: string) {
  const source = fs.realpathSync(sourcePath);
  const stat = fs.statSync(source);
  const skillFile = stat.isDirectory() ? path.join(source, "SKILL.md") : source;
  if (path.basename(skillFile).toLowerCase() !== "skill.md") {
    throw new Error("请选择包含 SKILL.md 的目录，或直接选择 SKILL.md。");
  }
  const parsed = parseSkillFile(skillFile, "user");
  const existing = listAgentSkills(threadId).find((skill) => skill.name === parsed.name);
  if (existing?.source === "builtin") {
    throw new Error(`不能覆盖内置 Skill：${parsed.name}`);
  }

  const targetDirectory = path.join(getThreadSkillsRoot(threadId), parsed.name);
  fs.mkdirSync(targetDirectory, { recursive: true });
  fs.copyFileSync(skillFile, path.join(targetDirectory, "SKILL.md"));
  clearSkillRegistryCache(threadId);
  return { name: parsed.name, description: parsed.description };
}
