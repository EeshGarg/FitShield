"use strict";
/**
 * Compiles and runs the Android adapter's pure Kotlin logic on this machine.
 *
 * Why this exists: the packet filter's correctness is the one part of the
 * Android target where a source grep is worthless. "Does an IPv6 packet with a
 * Hop-by-Hop header yield the right transport offset" and "does a truncated
 * packet return null instead of throwing out of the tun read loop" are questions
 * only execution answers, and both are answerable without a device because
 * IpPacket / HostPeek / BootRestore / VpnIntent import nothing from Android.
 *
 * No new dependency is introduced. The JDK comes from the project's own
 * `npm run toolchain:android`, and the Kotlin compiler is the one the Android
 * build already downloads into the Gradle cache — this only invokes what
 * building the APK on this machine already required.
 *
 * When neither is present (a checkout that has never built the APK), the caller
 * is told so and skips, exactly as tools/build-android.js treats an absent SDK.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..", "..");
const KOTLIN_DIR = path.join(ROOT, "android", "app", "src", "main", "java", "com", "usha", "fitshield");

/** The pure sources under test, plus the harness that drives them. */
const SOURCES = [
  path.join(KOTLIN_DIR, "IpPacket.kt"),
  path.join(KOTLIN_DIR, "RestorePolicy.kt"),
  path.join(__dirname, "NativeLogicHarness.kt")
];

const GRADLE_CACHE = path.join(os.homedir(), ".gradle", "caches", "modules-2", "files-2.1");
const TOOLCHAIN_JDK = path.join(os.homedir(), ".fitshield-toolchain", "jdk");

function exe(name) {
  return process.platform === "win32" ? `${name}.exe` : name;
}

function findJava() {
  const candidates = [
    path.join(TOOLCHAIN_JDK, "bin", exe("java")),
    process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, "bin", exe("java")) : null
  ].filter(Boolean);
  const found = candidates.find((p) => fs.existsSync(p));
  if (found) return found;
  // Last resort: whatever is on PATH.
  const probe = spawnSync(exe("java"), ["-version"], { stdio: "ignore" });
  return probe.error ? null : exe("java");
}

/** Newest jar for a cached Maven artifact, or null. */
function cachedJar(group, artifact) {
  const dir = path.join(GRADLE_CACHE, group, artifact);
  if (!fs.existsSync(dir)) return null;
  const jars = [];
  for (const version of fs.readdirSync(dir)) {
    const versionDir = path.join(dir, version);
    if (!fs.statSync(versionDir).isDirectory()) continue;
    for (const hash of fs.readdirSync(versionDir)) {
      const hashDir = path.join(versionDir, hash);
      if (!fs.statSync(hashDir).isDirectory()) continue;
      for (const file of fs.readdirSync(hashDir)) {
        if (file.endsWith(".jar") && !file.includes("-sources") && !file.includes("-javadoc")) {
          jars.push({ version, file: path.join(hashDir, file) });
        }
      }
    }
  }
  if (jars.length === 0) return null;
  jars.sort((a, b) => a.version.localeCompare(b.version, undefined, { numeric: true }));
  return jars[jars.length - 1].file;
}

/** Everything needed to run the embeddable Kotlin compiler, or null. */
function findKotlin() {
  const compiler = cachedJar("org.jetbrains.kotlin", "kotlin-compiler-embeddable");
  const stdlib = cachedJar("org.jetbrains.kotlin", "kotlin-stdlib");
  if (!compiler || !stdlib) return null;
  const support = [
    cachedJar("org.jetbrains.kotlin", "kotlin-script-runtime"),
    cachedJar("org.jetbrains.kotlin", "kotlin-daemon-embeddable"),
    cachedJar("org.jetbrains.intellij.deps", "trove4j"),
    cachedJar("org.jetbrains", "annotations")
  ].filter(Boolean);
  return { compiler, stdlib, support };
}

/** Why the harness cannot run here, or null when it can. */
function unavailable() {
  const missing = [];
  if (!findJava()) missing.push("a JDK (run `npm run toolchain:android`)");
  if (!findKotlin()) missing.push("the Kotlin compiler in the Gradle cache (run `npm run build:android` once)");
  return missing.length > 0 ? `needs ${missing.join(" and ")}` : null;
}

const SEPARATOR = process.platform === "win32" ? ";" : ":";

/**
 * Compile once per source revision. Keyed by a hash of the sources so an edit
 * recompiles and an unchanged tree reuses the classes (compiling costs seconds).
 */
function compile() {
  const java = findJava();
  const kotlin = findKotlin();
  const digest = crypto.createHash("sha256");
  SOURCES.forEach((file) => digest.update(fs.readFileSync(file)));
  const key = digest.digest("hex").slice(0, 16);
  const outDir = path.join(os.tmpdir(), `fitshield-kotlin-${key}`);
  const stamp = path.join(outDir, ".built");

  if (fs.existsSync(stamp)) return { java, kotlin, outDir };

  // node --test runs files concurrently, so build somewhere private and publish
  // by rename. A loser of that race finds the winner's directory already there.
  const staging = `${outDir}.${process.pid}`;
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });

  const classpath = [kotlin.compiler, kotlin.stdlib, ...kotlin.support].join(SEPARATOR);
  const result = spawnSync(
    java,
    [
      "-cp", classpath,
      "org.jetbrains.kotlin.cli.jvm.K2JVMCompiler",
      ...SOURCES,
      "-d", staging,
      "-classpath", kotlin.stdlib,
      "-jvm-target", "17",
      "-no-stdlib", "-no-reflect", "-nowarn"
    ],
    { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }
  );

  const compiled = fs.existsSync(staging) && fs.readdirSync(staging).length > 0;
  if (result.status !== 0 || !compiled) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw new Error(
      `Kotlin compilation of the Android adapter's pure logic failed:\n${result.stderr || result.stdout || "(no output)"}`
    );
  }
  fs.writeFileSync(path.join(staging, ".built"), key);
  try {
    fs.renameSync(staging, outDir);
  } catch {
    fs.rmSync(staging, { recursive: true, force: true });
    if (!fs.existsSync(stamp)) throw new Error(`could not publish compiled classes to ${outDir}`);
  }
  return { java, kotlin, outDir };
}

/**
 * Run [commands] through the harness and return one answer per command.
 * Throws when the JVM itself fails, so a broken harness can never look like a
 * passing assertion.
 */
function run(commands) {
  const { java, kotlin, outDir } = compile();
  const result = spawnSync(
    java,
    ["-cp", [outDir, kotlin.stdlib].join(SEPARATOR), "com.usha.fitshield.NativeLogicHarnessKt"],
    { input: `${commands.join("\n")}\n`, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }
  );
  if (result.status !== 0) {
    throw new Error(`Kotlin harness exited ${result.status}:\n${result.stderr || result.stdout}`);
  }
  const lines = result.stdout.split(/\r?\n/).filter((line) => line.length > 0);
  if (lines.length !== commands.length) {
    throw new Error(`harness returned ${lines.length} answers for ${commands.length} commands`);
  }
  return lines;
}

/** Single command convenience. */
function one(command) {
  return run([command])[0];
}

/** Parse "k=v k=v" answers into an object; text values are hex-decoded. */
function fields(answer) {
  const out = {};
  answer.split(" ").forEach((pair) => {
    const at = pair.indexOf("=");
    if (at > 0) out[pair.slice(0, at)] = pair.slice(at + 1);
  });
  return out;
}

const text = (hex) => Buffer.from(hex, "hex").toString("utf8");

module.exports = { run, one, fields, text, unavailable, SOURCES };
