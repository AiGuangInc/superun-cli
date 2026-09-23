import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";

const request = JSON.parse(readFileSync(".github/release-request.json", "utf8"));
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const stableVersion = /^\d+\.\d+\.\d+$/;

if (!request || typeof request !== "object" || Array.isArray(request)) {
  throw new Error("Release request must be an object");
}
if (Object.keys(request).some((key) => !["version", "notes"].includes(key))) {
  throw new Error("Unknown release request field");
}
if (!stableVersion.test(request.version) || pkg.name !== "superun-cli" || pkg.version !== request.version) {
  throw new Error("Release version must match package.json and be a stable version");
}
if (!Array.isArray(request.notes) || request.notes.length === 0 || request.notes.some((note) => typeof note !== "string" || !note.trim())) {
  throw new Error("Release notes must contain at least one nonempty item");
}

const npmView = (...args) => JSON.parse(execFileSync("npm", ["view", "superun-cli", ...args, "--json"], { encoding: "utf8" }));
const versions = npmView("versions");
if ([].concat(versions).includes(request.version)) {
  throw new Error(`superun-cli@${request.version} is already published`);
}

const latest = npmView("dist-tags.latest");
if (!stableVersion.test(latest)) throw new Error("The current latest tag is not a stable version");
const nextParts = request.version.split(".").map(Number);
const latestParts = latest.split(".").map(Number);
const differing = nextParts.findIndex((part, index) => part !== latestParts[index]);
if (differing < 0 || nextParts[differing] < latestParts[differing]) {
  throw new Error(`Release version must be newer than latest ${latest}`);
}

console.log(`Valid release request: superun-cli@${request.version}`);
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `version=${request.version}\n`);
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Release request: superun-cli@${request.version}\n\n${request.notes.map((note) => `- ${note.trim()}`).join("\n")}\n`);
}
