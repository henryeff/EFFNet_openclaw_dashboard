import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const baseUrl = process.env.DASHBOARD_URL || "http://127.0.0.1:4789";
const outDir = path.join(process.cwd(), "reports", "morning-briefs");

async function main() {
  const res = await fetch(`${baseUrl}/api/morning-brief-text`);
  if (!res.ok) throw new Error(`Request failed: ${res.status}`);

  const data = await res.json();
  if (!data.ok || !data.text) throw new Error(data.error || "Missing morning brief text");

  const stamp = new Date().toISOString().replace(/[:]/g, "-").replace(/\..+$/, "");
  const outPath = path.join(outDir, `morning-brief-${stamp}.txt`);

  await mkdir(outDir, { recursive: true });
  await writeFile(outPath, `${data.text}\n`, "utf8");

  console.log(`Exported morning brief to ${outPath}`);
}

main().catch((error) => {
  console.error("Failed to export morning brief", error.message);
  process.exit(1);
});
