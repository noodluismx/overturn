// Assembles the uploadable Gorgias app bundle: manifest + assets + built widget script.

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const out = path.join(root, "dist", "app");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// Copy app metadata and assets
if (existsSync(path.join(root, "app", "assets"))) {
  cpSync(path.join(root, "app", "assets"), out, { recursive: true });
}
if (existsSync(path.join(root, "app", "manifest.json"))) {
  cpSync(path.join(root, "app", "manifest.json"), path.join(out, "manifest.json"));
}

// Copy compiled browser bundle
const globalJs = path.join(root, "dist", "main.global.js");
const mainJs = path.join(root, "dist", "main.js");
if (existsSync(globalJs)) {
  cpSync(globalJs, path.join(out, "main.js"));
} else if (existsSync(mainJs)) {
  cpSync(mainJs, path.join(out, "main.js"));
}

const zip = (name) => {
  try {
    rmSync(path.join(root, "dist", name), { force: true });
    execFileSync("zip", ["-qr", path.join(root, "dist", name), "."], { cwd: out });
    console.log(`dist/${name}`);
  } catch {
    console.log(`dist/app (bundle directory ready for upload at dist/${name})`);
  }
};

zip("overturn-gorgias-app.zip");
