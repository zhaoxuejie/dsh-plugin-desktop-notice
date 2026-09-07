// dsh-plugin-desktop-notice — git 分支探测（FR-5 内容增强，M2）
// 读 <cwd>/.git/HEAD 解析 "ref: refs/heads/<branch>"，按 cwd 缓存 5s（spec phase2 §5）。
// 尽力而为：cwd 缺省 / 无 .git / detached HEAD / 读失败 → undefined（调用方省略该字段）。

import fs from "node:fs";
import path from "node:path";

const CACHE_TTL_MS = 5000;

export function createBranchResolver({ now = () => Date.now() } = {}) {
  /** @type {Map<string, { branch: string | null, at: number }>} */
  const cache = new Map();

  function readGitHead(cwd) {
    try {
      const head = fs.readFileSync(path.join(cwd, ".git", "HEAD"), "utf8").trim();
      const m = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
      return m ? m[1] : null; // detached HEAD（40 位 hash）→ null，省略
    } catch {
      return null;
    }
  }

  /** @param {string=} cwd 工作目录；取不到返回 undefined */
  function resolve(cwd) {
    if (!cwd) return undefined;
    const t = now();
    const hit = cache.get(cwd);
    if (hit && t - hit.at < CACHE_TTL_MS) return hit.branch ?? undefined;
    const branch = readGitHead(cwd);
    cache.set(cwd, { branch, at: t });
    return branch ?? undefined;
  }

  return { resolve };
}
