import { readFileSync } from "node:fs";
import { verifyEvidencePackage } from "../lib/proof-format.ts";

const path = process.argv[2];
if (!path) {
  console.error("Usage: npm run verify:bundle -- <evidence.json>");
  process.exitCode = 2;
} else {
  try {
    const bundle = JSON.parse(readFileSync(path, "utf8"));
    const result = verifyEvidencePackage(bundle);
    if (!result.valid) {
      console.error(`INVALID ${result.code}: ${result.message}`);
      process.exitCode = 1;
    } else {
      console.log(`VALID: ${result.checkedEvents} events; head ${result.headHash}`);
      console.log("Internal consistency only: this unsigned bundle does not prove who created it.");
    }
  } catch (error) {
    console.error(`INVALID_BUNDLE: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
