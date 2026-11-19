import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), "save-sync-safety-"));
try {
  const modules = ["safe_files", "game_operations", "sync_policy"];
  const harness = join(temporary, "safety.rs");
  writeFileSync(harness, modules.map((name) =>
    `#[path = ${JSON.stringify(resolve(root, `src-tauri/src/${name}.rs`))}] mod ${name};`
  ).join("\n"));
  const binary = join(temporary, process.platform === "win32" ? "safety.exe" : "safety");
  const compile = spawnSync("rustc", ["--edition=2021", "--test", harness, "-o", binary], { stdio: "inherit" });
  if (compile.error) throw compile.error;
  if (compile.status !== 0) process.exitCode = compile.status ?? 1;
  else {
    const tests = spawnSync(binary, [], { stdio: "inherit" });
    if (tests.error) throw tests.error;
    process.exitCode = tests.status ?? 1;
  }
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
