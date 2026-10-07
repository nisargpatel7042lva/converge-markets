/* global console */
// Renders the PNG icons from the SVG sources (no network, no fonts): `pnpm --filter @converge/web icons`.
import { Resvg } from "@resvg/resvg-js";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const dir = resolve(dirname(fileURLToPath(import.meta.url)), "../public/icons");
const render = (src, size, out) => {
  const png = new Resvg(readFileSync(resolve(dir, src)), { fitTo: { mode: "width", value: size } })
    .render()
    .asPng();
  writeFileSync(resolve(dir, out), png);
  console.log(out, png.length);
};
render("icon.svg", 192, "icon-192.png");
render("icon.svg", 512, "icon-512.png");
render("maskable.svg", 512, "maskable-512.png");
render("maskable.svg", 180, "apple-touch-icon.png");
