"use strict";
/**
 * Protection has to come back after a restart — for the user who had it on, and
 * for nobody else.
 *
 * The old behaviour: the manifest recorded that `RECEIVE_BOOT_COMPLETED` was
 * "deliberately NOT requested (no boot startup)". In practice a user turned
 * FitShield on, their phone restarted overnight, and in the morning site
 * blocking was off and nothing had said so — while app blocking *had* silently
 * resumed, because the OS re-binds an AccessibilityService by itself. So the app
 * looked alive and half of it was not.
 *
 * Restarting a VPN at boot is also exactly the capability a user would resent
 * being used for anything else, so the rules are written as pure Kotlin
 * (`BootRestore`, `VpnIntent`) and EXECUTED here through
 * test/helpers/kotlin-runner.js, rather than asserted from the shape of the
 * source. Two of them carry the weight:
 *
 *   1. a stored instruction of "off" (or missing, or unreadable) starts nothing
 *      and posts nothing;
 *   2. the OS ending the service — a reboot, a low-memory kill, an app update —
 *      never rewrites that instruction, because if it did, protection would stay
 *      off forever afterwards with nobody having chosen it.
 *
 * What this file does NOT establish: what a real handset does at boot. Whether
 * `VpnService.prepare()` still returns null after a restart, and whether the OEM
 * lets the foreground service start, are device facts. That is precisely why
 * both outcomes are implemented — a silent restore, and a one-tap notification
 * when the silent restore is refused — rather than one being assumed.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const kotlin = require("./helpers/kotlin-runner.js");
const { bootRestoreAudit } = require("../tools/android-audit.js");
const { Reporter } = require("../tools/lib/report.js");

const ROOT = path.join(__dirname, "..");
const KOTLIN_DIR = path.join(ROOT, "android", "app", "src", "main", "java", "com", "usha", "fitshield");
const MANIFEST = fs.readFileSync(path.join(ROOT, "android", "app", "src", "main", "AndroidManifest.xml"), "utf8");

const read = (name) => fs.readFileSync(path.join(KOTLIN_DIR, name), "utf8");

/** Kotlin with comments removed — a sentence explaining a call is not the call. */
const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\r\n]*/g, " ");

/** Manifest with XML comments removed, for the same reason. */
const manifestBody = MANIFEST.replace(/<!--[\s\S]*?-->/g, "");

const SKIP = kotlin.unavailable();
const opts = SKIP ? { skip: `Kotlin harness ${SKIP}` } : {};

const hexOf = (value) => Buffer.from(value, "utf8").toString("hex");

// ---------------------------------------------------------------------------
// The decision, executed
// ---------------------------------------------------------------------------

test("a restart never turns protection on for someone who turned it off", opts, () => {
  const cases = [
    ["-", true, "NOTHING", "nothing stored yet — a fresh install must not start a VPN"],
    ["-", false, "NOTHING", "nothing stored and no consent"],
    ["false", true, "NOTHING", "the user switched it off; consent being held changes nothing"],
    ["false", false, "NOTHING", "the user switched it off"],
    ['"false"', true, "NOTHING", "the quoted JSON form the web shim writes"],
    ["", true, "NOTHING", "an empty value is not consent to start"],
    ["null", true, "NOTHING", "a JSON null is not an instruction"],
    ["garbage", true, "NOTHING", "an unreadable value must fail closed"],
    ["TRUE", true, "NOTHING", "only the exact stored form counts"],
    ["true", true, "START_TUNNEL", "the user had it on and Android still holds consent"],
    ['"true"', true, "START_TUNNEL", "the quoted JSON form the web shim writes"],
    [" true ", true, "START_TUNNEL", "surrounding whitespace is not a different answer"],
    ["true", false, "ASK_TO_RESTORE", "wanted on, but consent has lapsed — say so, do not start"],
    ['"true"', false, "ASK_TO_RESTORE", "wanted on, consent lapsed"]
  ];

  const answers = kotlin.run(
    cases.map(([stored, consent]) => `decide ${stored === "-" ? "-" : hexOf(stored)} ${consent}`)
  );

  cases.forEach(([stored, consent, expected, why], index) => {
    assert.equal(
      answers[index],
      expected,
      `stored=${JSON.stringify(stored)} consent=${consent}: expected ${expected} — ${why}`
    );
  });
});

test("only the user's own actions write the stored instruction", opts, () => {
  const cases = [
    ["USER_ENABLED", "true", "the user turned it on and the tunnel came up"],
    ["USER_DISABLED", "false", "the user turned it off"],
    ["CONSENT_REVOKED", "false", "consent withdrawn, or another VPN took over — not ours to resume"],
    ["SERVICE_DESTROYED", "null",
      "a reboot, a low-memory kill and an app update all land here; writing 'off' would leave " +
      "protection off forever with nobody having chosen it"],
    ["ESTABLISH_FAILED", "null", "a tunnel that would not come up is not the user changing their mind"],
    ["BOOT_RESTORE_STARTED", "null", "restoring must not manufacture an instruction, only honour one"]
  ];

  const answers = kotlin.run(cases.map(([event]) => `record ${event}`));
  cases.forEach(([event, expected, why], index) => {
    assert.equal(answers[index], expected, `${event}: expected ${expected} — ${why}`);
  });
});

test("what the service stores is what the boot path reads back", opts, () => {
  // The value lands in the same SharedPreferences the web UI reads through
  // android-shim.js, so the two ends have to agree on the encoding.
  const [onValue, offValue, decodeOn, decodeOff, key] = kotlin.run([
    "encode true", "encode false", `decode ${hexOf("true")}`, `decode ${hexOf("false")}`, "key_name"
  ]);

  assert.equal(kotlin.text(kotlin.fields(onValue).s), "true");
  assert.equal(kotlin.text(kotlin.fields(offValue).s), "false");
  assert.equal(decodeOn, "true");
  assert.equal(decodeOff, "false");
  assert.doesNotThrow(() => JSON.parse(kotlin.text(kotlin.fields(onValue).s)),
    "the stored form must survive android-shim.js's JSON.parse");

  const keyName = kotlin.text(kotlin.fields(key).s);
  assert.equal(read("FitShieldVpnService.kt").includes("VpnIntent.KEY"), true);
  assert.ok(/^[A-Za-z][A-Za-z0-9]*$/.test(keyName), `storage key looks wrong: ${keyName}`);
});

// ---------------------------------------------------------------------------
// The wiring around that decision
// ---------------------------------------------------------------------------

test("the boot receiver is registered for the two protected broadcasts and nothing else", () => {
  const receiver = manifestBody.match(/<receiver[\s\S]*?<\/receiver>/);
  assert.ok(receiver, "no <receiver> in the manifest — nothing restores protection after a restart");

  const actions = [...receiver[0].matchAll(/<action[^>]*android:name="([^"]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(actions, [
    "android.intent.action.BOOT_COMPLETED",
    "android.intent.action.MY_PACKAGE_REPLACED"
  ], "the boot receiver may handle only the broadcasts that end the VpnService without the user asking");

  assert.match(manifestBody, /android\.permission\.RECEIVE_BOOT_COMPLETED/,
    "BOOT_COMPLETED never fires without the permission");
  assert.match(receiver[0], /android:exported="true"/,
    "BOOT_COMPLETED is a protected system broadcast; the receiver has to be exported to receive it");
});

test("the receiver decides before it starts anything, and never opens a screen", () => {
  const source = stripComments(read("BootReceiver.kt"));

  const decideAt = source.indexOf("BootRestore.decide");
  assert.ok(decideAt > 0, "the boot path must go through BootRestore.decide — the gate the suite executes");

  [...source.matchAll(/\bstart(?:Foreground)?Service\s*\(/g)].forEach((match) => {
    assert.ok(match.index > decideAt,
      "BootReceiver starts a service before consulting the stored instruction");
  });
  assert.ok(!/\bstartActivity\s*\(/.test(source),
    "a receiver that throws a screen at you after a reboot is malware behaviour, not a blocker");
  assert.ok(!/Log\.(i|d)\s*\(/.test(source) || !/host|domain|apex/i.test(source),
    "the boot path must not log anything about browsing");
});

test("the service records the user's instruction, and the OS ending it does not", () => {
  const service = stripComments(read("FitShieldVpnService.kt"));

  assert.match(service, /VpnIntent\.Event\.USER_DISABLED/, "an explicit stop must record 'off'");
  assert.match(service, /VpnIntent\.Event\.USER_ENABLED/, "a successful user-initiated start must record 'on'");
  assert.match(service, /VpnIntent\.Event\.CONSENT_REVOKED/, "onRevoke must record 'off'");

  const onDestroy = service.slice(service.indexOf("fun onDestroy"));
  const body = onDestroy.slice(0, onDestroy.indexOf("\n    }") + 1);
  assert.ok(!/(recordIntent|VpnIntent)/.test(body),
    "onDestroy writes the stored instruction — a reboot or a low-memory kill would be recorded as the user " +
    "turning FitShield off, and protection would never come back");

  // The restore path has to be distinguishable from a user tapping Enable, or a
  // failed restore cannot speak up and a successful one rewrites the instruction.
  assert.match(service, /ACTION_BOOT_RESTORE/);
  assert.match(service, /fromBoot/);
});

test("a restore that Android refuses ends in a notification, not silence", () => {
  const receiver = stripComments(read("BootReceiver.kt"));
  const service = stripComments(read("FitShieldVpnService.kt"));
  const notice = stripComments(read("RestoreNotice.kt"));
  const activity = stripComments(read("MainActivity.kt"));

  assert.match(receiver, /ASK_TO_RESTORE\s*->\s*RestoreNotice\.post/,
    "a lapsed consent must produce the one-tap notification");
  assert.match(service, /if\s*\(fromBoot\)\s*RestoreNotice\.post/,
    "establish() returning null during a restore must not exit quietly");

  // The notification is the only way back, so its tap has to do something.
  assert.match(notice, /setContentIntent/);
  assert.match(notice, /setAutoCancel\(true\)/);
  assert.match(activity, /EXTRA_RESTORE_VPN/,
    "MainActivity must act on the notification's extra — the consent dialog can only come from an Activity");
  assert.match(activity, /requestVpnEnable\(\)/);
  assert.match(service, /RestoreNotice\.clear/,
    "the notice must disappear once the tunnel is actually up");
});

test("the app explains the boot permission where the user can read it", () => {
  /*
   * Play asks for "start at startup" to be justified in the app, not only in the
   * store listing — and independently of Play, an app that comes back by itself
   * after a reboot owes the user a sentence saying so. This binds the two
   * together in both directions: the permission cannot be declared without the
   * explanation, and the explanation cannot outlive the permission.
   */
  const dashboard = fs.readFileSync(
    path.join(ROOT, "android", "app", "src", "main", "assets", "web", "index.html"), "utf8"
  ).replace(/<!--[\s\S]*?-->/g, " ");

  const declared = /android\.permission\.RECEIVE_BOOT_COMPLETED/.test(manifestBody);
  const explained = /RECEIVE_BOOT_COMPLETED/.test(dashboard);

  assert.equal(explained, declared,
    declared
      ? "the manifest asks to start at device startup and the dashboard never mentions it"
      : "the dashboard explains a boot permission the manifest no longer requests");

  if (!declared) return;
  assert.match(dashboard, /start at device startup/i, "name the permission the way the system does");
  assert.match(dashboard, /if you had it off, nothing starts/i,
    "the user needs to read that turning FitShield off keeps it off");
  assert.match(dashboard, /one notification/i,
    "the fallback — a notification instead of a silent start — has to be stated");
});

// ---------------------------------------------------------------------------
// The audit that keeps all of that true
// ---------------------------------------------------------------------------

test("the audit refuses every shape of an unconstrained boot path", () => {
  const receiverXml = `
    <receiver android:name=".BootReceiver" android:exported="true">
      <intent-filter>
        <action android:name="android.intent.action.BOOT_COMPLETED" />
        <action android:name="android.intent.action.MY_PACKAGE_REPLACED" />
      </intent-filter>
    </receiver>`;
  const BOOT = "android.permission.RECEIVE_BOOT_COMPLETED";

  const errorsFor = (xml, declared) => {
    const reporter = new Reporter("boot gate");
    bootRestoreAudit(reporter, xml, declared);
    return reporter.errors;
  };

  assert.deepEqual(errorsFor("<manifest></manifest>", []), [],
    "no permission and no receiver is a valid state — nothing to constrain");

  assert.equal(errorsFor("<manifest></manifest>", [BOOT]).length, 1,
    "declaring RECEIVE_BOOT_COMPLETED without a receiver leaves an unused, reviewer-visible permission");

  assert.equal(errorsFor(receiverXml, []).length, 1,
    "a boot receiver without the permission never fires — protection would silently not come back");

  assert.equal(errorsFor(receiverXml + receiverXml, [BOOT]).length, 1,
    "two boot paths mean one of them is unaudited");

  const smuggled = receiverXml.replace(
    "</intent-filter>",
    '  <action android:name="android.intent.action.USER_PRESENT" />\n      </intent-filter>'
  );
  assert.ok(errorsFor(smuggled, [BOOT]).some((message) => /USER_PRESENT/.test(message)),
    "a boot receiver may not quietly grow a second trigger");

  assert.deepEqual(errorsFor(manifestBody, [BOOT]), [],
    "the shipped manifest must satisfy the gate it is guarded by");
});
