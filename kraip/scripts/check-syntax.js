// Syntax-checks every JavaScript file in the project (node --check). Run: npm run check
const { readdirSync, statSync } = require("fs");
const { join } = require("path");
const { spawnSync } = require("child_process");
const root = join(__dirname, "..");
const skip = new Set(["node_modules", ".git", "data"]);
const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (skip.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (name.endsWith(".js")) files.push(p);
  }
})(root);
let bad = 0;
for (const f of files) {
  const r = spawnSync(process.execPath, ["--check", f], { encoding: "utf8" });
  if (r.status !== 0) { bad++; console.error(`SYNTAX ERROR in ${f}\n${r.stderr}`); }
}
console.log(`${files.length - bad}/${files.length} files OK`);
process.exit(bad ? 1 : 0);
