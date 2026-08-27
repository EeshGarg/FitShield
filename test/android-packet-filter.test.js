"use strict";
/**
 * The Android connection filter, executed.
 *
 * `Tun2Filter.dispatch` opened with `if (version != 4) return`, while
 * `FitShieldVpnService` routed `::/0` into the tunnel. Every IPv6 packet on the
 * device was therefore captured and thrown away. On dual-stack Wi-Fi that
 * degraded quietly to IPv4; on an IPv6-only mobile carrier — normal on several
 * large networks — the user had no working internet at all for as long as
 * FitShield was on. A blocker that silently kills connectivity for a whole class
 * of users does not get a second chance on a store listing.
 *
 * The tempting cure was to stop routing `::/0`, which restores connectivity by
 * letting IPv6 bypass the filter — and turns a visible failure into an invisible
 * one, because a blocked brand reachable over IPv6 would simply not be blocked.
 * So the packets are parsed instead, and this file is what makes that claim
 * checkable: it COMPILES AND RUNS the shipped Kotlin (`IpPacket`, `HostPeek`,
 * `BootRestore`, `VpnIntent`) through test/helpers/kotlin-runner.js and asserts
 * on the values it returns.
 *
 * Two properties are asserted throughout:
 *
 *   PARITY   — the same TCP payload, carried over IPv4 and over IPv6, must yield
 *              the same hostname. A table drives both families through identical
 *              cases so neither can drift.
 *   SAFETY   — a malformed, truncated or hostile packet must come back as "drop"
 *              (null), never as an exception. The harness reports a thrown
 *              exception as "ERR:<class>", so every assertion of `null` is also
 *              an assertion that nothing read out of bounds. `dispatch` catches
 *              per packet, but an exception there is a dropped packet plus a log
 *              line for traffic that was perfectly valid.
 *
 * What this file does NOT establish: that the tunnel behaves this way on a real
 * device. There is no emulator or handset in this environment. It establishes
 * the parsing, the offsets, the emitted packets' checksums and the restore
 * decisions — the parts that are pure logic.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const kotlin = require("./helpers/kotlin-runner.js");
const P = require("./helpers/packets.js");

const SKIP = kotlin.unavailable();
const opts = SKIP ? { skip: `Kotlin harness ${SKIP}` } : {};

/** One `parse` answer as an object, or the string "null" / "ERR:…". */
function parse(packet, len) {
  const answer = kotlin.one(`parse ${P.hex(packet)}${len === undefined ? "" : ` ${len}`}`);
  return answer.startsWith("v=") ? kotlin.fields(answer) : answer;
}

function peek(kind, payload) {
  const answer = kotlin.one(`${kind} ${P.hex(payload)}`);
  if (answer === "need" || answer === "none") return answer;
  if (!answer.startsWith("host=")) return answer;
  return kotlin.text(kotlin.fields(answer).host);
}

// ---------------------------------------------------------------------------
// IPv6 reaches the transport header
// ---------------------------------------------------------------------------

test("an IPv6 TCP packet is parsed, not dropped for being IPv6", opts, () => {
  const packet = P.ipv6({ payload: P.tcpSegment({ payload: P.clientHello("doordash.com") }) });
  const header = parse(packet);

  assert.notEqual(header, "null", "IPv6 must not be dropped — the tunnel routes ::/0");
  assert.equal(header.v, "6");
  assert.equal(header.p, "6", "protocol must be TCP");
  assert.equal(header.off, "40", "the transport header starts after the 40-byte fixed header");
  assert.equal(header.src, P.hex(P.V6_LOCAL));
  assert.equal(header.dst, P.hex(P.V6_REMOTE));
});

test("the SNI comes out of an IPv6 ClientHello", opts, () => {
  const packet = P.ipv6({ payload: P.tcpSegment({ payload: P.clientHello("doordash.com") }) });
  const off = Number(parse(packet).off);
  // Exactly what Tun2Filter does with the offset: read the ports, then hand the
  // TCP payload to the same host peek the IPv4 path uses.
  assert.equal(packet.readUInt16BE(off + 2), 443, "destination port is read from the parsed offset");
  const dataOffset = off + ((packet[off + 12] >> 4) * 4);
  assert.equal(peek("sni", packet.subarray(dataOffset)), "doordash.com");
});

test("an extension-header chain is walked to the real transport header", opts, () => {
  const cases = [
    { label: "Hop-by-Hop", extensions: [P.optionsHeader(0)], expected: 48 },
    { label: "Hop-by-Hop (24 bytes)", extensions: [P.optionsHeader(0, 2)], expected: 64 },
    { label: "Destination Options", extensions: [P.optionsHeader(60)], expected: 48 },
    { label: "Routing", extensions: [P.optionsHeader(43, 1)], expected: 56 },
    { label: "Authentication Header", extensions: [P.authHeader(2)], expected: 56 },
    { label: "atomic Fragment", extensions: [P.fragmentHeader({})], expected: 48 },
    {
      label: "Hop-by-Hop + Routing + Destination Options",
      extensions: [P.optionsHeader(0), P.optionsHeader(43), P.optionsHeader(60)],
      expected: 64
    }
  ];

  cases.forEach(({ label, extensions, expected }) => {
    const packet = P.ipv6({ extensions, payload: P.tcpSegment({ payload: P.clientHello("ubereats.com") }) });
    const header = parse(packet);
    assert.notEqual(header, "null", `${label}: chain must be walked, not dropped`);
    assert.equal(header.off, String(expected), `${label}: wrong transport offset`);
    assert.equal(header.p, "6", `${label}: must resolve to TCP`);

    const dataOffset = expected + ((packet[expected + 12] >> 4) * 4);
    assert.equal(peek("sni", packet.subarray(dataOffset)), "ubereats.com", `${label}: SNI must still be readable`);
  });
});

test("a QUIC datagram over IPv6 parses to UDP/443, the port the filter drops", opts, () => {
  const packet = P.ipv6({
    protocol: 17,
    payload: P.udpSegment({ dstPort: 443, payload: Buffer.from([0xc0, 0x00, 0x00, 0x00, 0x01]) })
  });
  const header = parse(packet);
  assert.notEqual(header, "null");
  assert.equal(header.p, "17");
  assert.equal(header.off, "40");
  assert.equal(packet.readUInt16BE(Number(header.off) + 2), 443,
    "handleUdp reads the destination port from this offset and drops 443 so the client falls back to TCP");
});

// ---------------------------------------------------------------------------
// The two families agree
// ---------------------------------------------------------------------------

test("IPv4 and IPv6 produce the same hostname for the same payload", opts, () => {
  const cases = [
    { port: 443, host: "doordash.com", payload: (h) => P.clientHello(h) },
    { port: 443, host: "fake-doordash.com", payload: (h) => P.clientHello(h) },
    { port: 443, host: "doordash.com.evil.com", payload: (h) => P.clientHello(h) },
    { port: 443, host: "www.just-eat.co.uk", payload: (h) => P.clientHello(h) },
    { port: 80, host: "ubereats.com", payload: (h) => P.httpRequest(h) },
    { port: 80, host: "wikipedia.org", payload: (h) => P.httpRequest(h) }
  ];

  cases.forEach(({ port, host, payload }) => {
    const segment = P.tcpSegment({ dstPort: port, payload: payload(host) });
    const four = parse(P.ipv4({ payload: segment }));
    const six = parse(P.ipv6({ payload: segment }));

    assert.equal(four.v, "4");
    assert.equal(six.v, "6");
    assert.equal(four.off, "20", `${host}: IPv4 transport offset`);
    assert.equal(six.off, "40", `${host}: IPv6 transport offset`);
    assert.equal(four.p, six.p, `${host}: both families must resolve to the same protocol`);

    const kind = port === 443 ? "sni" : "host";
    const fromV4 = peek(kind, P.ipv4({ payload: segment }).subarray(Number(four.off) + 20));
    const fromV6 = peek(kind, P.ipv6({ payload: segment }).subarray(Number(six.off) + 20));
    assert.equal(fromV4, host, `${host}: IPv4 path`);
    assert.equal(fromV6, host, `${host}: IPv6 path — must not differ from IPv4`);
  });
});

test("IPv4 options and IPv6 extension headers shift the offset the same way", opts, () => {
  const segment = P.tcpSegment({ payload: P.clientHello("grubhub.com") });

  const withOptions = P.ipv4({ payload: segment, ihlWords: 8 });   // 12 bytes of options
  assert.equal(parse(withOptions).off, "32");
  assert.equal(peek("sni", withOptions.subarray(32 + 20)), "grubhub.com");

  const withExtension = P.ipv6({ extensions: [P.optionsHeader(0)], payload: segment });
  assert.equal(parse(withExtension).off, "48");
  assert.equal(peek("sni", withExtension.subarray(48 + 20)), "grubhub.com");
});

// ---------------------------------------------------------------------------
// Fragments
// ---------------------------------------------------------------------------

test("fragments are dropped in both families rather than half-parsed", opts, () => {
  const segment = P.tcpSegment({ payload: P.clientHello("doordash.com") });

  // A non-first fragment carries no transport header at all; a FIRST fragment
  // carries only part of the segment, and feeding that to the TCP path counts a
  // partial payload as a whole one and corrupts the sequence bookkeeping.
  assert.equal(parse(P.ipv4({ payload: segment, flagsFrag: 0x2000 })), "null", "IPv4 More-Fragments");
  assert.equal(parse(P.ipv4({ payload: segment, flagsFrag: 0x00b9 })), "null", "IPv4 non-zero fragment offset");

  assert.equal(
    parse(P.ipv6({ extensions: [P.fragmentHeader({ more: true })], payload: segment })),
    "null",
    "IPv6 first fragment of several"
  );
  assert.equal(
    parse(P.ipv6({ extensions: [P.fragmentHeader({ offsetUnits: 185 })], payload: segment })),
    "null",
    "IPv6 later fragment"
  );

  // The unfragmented equivalents still pass, so the guard cannot be a blanket drop.
  assert.notEqual(parse(P.ipv4({ payload: segment })), "null");
  assert.notEqual(parse(P.ipv6({ payload: segment })), "null");
});

// ---------------------------------------------------------------------------
// Malformed input cannot crash or read out of bounds
// ---------------------------------------------------------------------------

test("malformed packets are dropped, never thrown", opts, () => {
  const segment = P.tcpSegment({ payload: P.clientHello("doordash.com") });
  const cases = [
    ["empty", Buffer.alloc(0)],
    ["one byte claiming IPv6", Buffer.from([0x60])],
    ["IPv6 header cut short", P.ipv6({ payload: segment }).subarray(0, 39)],
    ["IPv4 header cut short", P.ipv4({ payload: segment }).subarray(0, 19)],
    ["IPv4 IHL below the minimum", Buffer.from([0x43, ...new Array(23).fill(0)])],
    ["IPv4 IHL past the end", Buffer.from([0x4f, ...new Array(23).fill(0)])],
    ["version 7", Buffer.from([0x70, ...new Array(63).fill(0)])],
    ["version 0", Buffer.from([0x00, ...new Array(63).fill(0)])],
    ["extension header running past the end",
      P.ipv6({ extensions: [P.optionsHeader(0, 40)], payload: segment }).subarray(0, 60)],
    // A Hop-by-Hop header declaring 2048 bytes inside a 48-byte packet.
    ["extension header length 255",
      Buffer.concat([
        P.ipv6({ protocol: 0, payload: Buffer.alloc(0) }).subarray(0, 40),
        Buffer.from([6, 255, 0, 0, 0, 0, 0, 0])
      ])],
    // The fixed header points at a Fragment header that is three bytes long.
    ["truncated Fragment header",
      Buffer.concat([
        P.ipv6({ protocol: 44, payload: Buffer.alloc(0) }).subarray(0, 40),
        Buffer.from([6, 0, 0])
      ])],
    ["ESP (transport header is encrypted)", P.ipv6({ extensions: [], protocol: 50, payload: Buffer.alloc(8) })],
    ["no next header", P.ipv6({ extensions: [], protocol: 59, payload: Buffer.alloc(0) })],
    ["ICMPv6", P.ipv6({ protocol: 58, payload: Buffer.from([128, 0, 0, 0, 0, 0, 0, 1]) })],
    ["unknown next header", P.ipv6({ protocol: 253, payload: Buffer.alloc(8) })]
  ];

  cases.forEach(([label, packet]) => {
    const answer = parse(packet);
    assert.equal(typeof answer, "string", `${label}: must be dropped, got a parsed header`);
    assert.equal(answer, "null", `${label}: must drop cleanly, not throw`);
  });
});

test("an endless extension-header chain is refused instead of walked", opts, () => {
  // Twenty Hop-by-Hop headers pointing at each other: legal-looking bytes, not a
  // real packet. The walk is capped rather than trusted.
  const extensions = new Array(20).fill(null).map(() => P.optionsHeader(0));
  const packet = P.ipv6({ extensions, payload: P.tcpSegment({ payload: Buffer.alloc(0) }) });
  assert.equal(parse(packet), "null");
});

test("every truncation of a valid packet drops cleanly", opts, () => {
  const packets = {
    ipv4: P.ipv4({ payload: P.tcpSegment({ payload: P.clientHello("doordash.com") }) }),
    ipv6: P.ipv6({ payload: P.tcpSegment({ payload: P.clientHello("doordash.com") }) }),
    "ipv6+ext": P.ipv6({
      extensions: [P.optionsHeader(0), P.optionsHeader(60, 1)],
      payload: P.tcpSegment({ payload: P.clientHello("doordash.com") })
    })
  };

  Object.entries(packets).forEach(([label, packet]) => {
    // Two flavours of truncation: a genuinely short buffer, and a full buffer
    // with a short length — the second is what a real read() reports, and the
    // parser must never read past it.
    const commands = [];
    for (let len = 0; len <= packet.length; len += 1) {
      commands.push(`parse ${P.hex(packet.subarray(0, len))}`);
      commands.push(`parse ${P.hex(packet)} ${len}`);
    }
    kotlin.run(commands).forEach((answer, index) => {
      assert.ok(
        !answer.startsWith("ERR:"),
        `${label}: truncation ${index} threw ${answer} — a hostile packet must not reach the read loop`
      );
    });
  });
});

test("a length longer than the buffer is refused", opts, () => {
  const packet = P.ipv6({ payload: P.tcpSegment({ payload: Buffer.alloc(0) }) });
  assert.equal(parse(packet, packet.length + 200), "null");
});

test("random bytes never throw", opts, () => {
  // Deterministic pseudo-random, so a failure is reproducible. Version nibbles
  // are biased toward 4 and 6 so the fuzz spends its time inside the parsers.
  let seed = 0x9e3779b9;
  const next = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed >>> 24;
  };

  const commands = [];
  for (let i = 0; i < 500; i += 1) {
    const length = 1 + (next() % 96);
    const bytes = Buffer.alloc(length);
    for (let b = 0; b < length; b += 1) bytes[b] = next();
    bytes[0] = (i % 2 === 0 ? 0x40 : 0x60) | (bytes[0] & 0x0f);
    commands.push(`parse ${P.hex(bytes)}`);
  }

  kotlin.run(commands).forEach((answer, index) => {
    assert.ok(!answer.startsWith("ERR:"), `random packet ${index} threw ${answer}: ${commands[index]}`);
  });
});

test("a hostile TLS record cannot walk off the end of the payload", opts, () => {
  const hello = P.clientHello("doordash.com");
  const commands = [];
  for (let len = 0; len <= hello.length; len += 1) commands.push(`sni ${P.hex(hello.subarray(0, len))}`);
  // Lengths that claim far more than is present.
  commands.push(`sni ${P.hex(Buffer.from([0x16, 0x03, 0x01, 0xff, 0xff, 0x01, 0xff, 0xff, 0xff]))}`);
  commands.push(`sni ${P.hex(Buffer.from([0x16, 0x03, 0x01, 0x00, 0x04, 0x01, 0x00, 0x00, 0xff]))}`);
  commands.push(`host ${P.hex(Buffer.from("Host:", "ascii"))}`);
  commands.push(`host ${P.hex(Buffer.from("GET / HTTP/1.1\r\n\r\n", "ascii"))}`);

  kotlin.run(commands).forEach((answer, index) => {
    assert.ok(!answer.startsWith("ERR:"), `payload case ${index} threw ${answer}`);
  });
});

// ---------------------------------------------------------------------------
// The packets FitShield emits back into the tunnel
// ---------------------------------------------------------------------------

/** Verify a checksum by summing the region; a correct one sums to 0xFFFF. */
function ones(buffer) {
  let sum = 0;
  for (let i = 0; i + 1 < buffer.length; i += 2) sum += buffer.readUInt16BE(i);
  if (buffer.length % 2) sum += buffer[buffer.length - 1] << 8;
  while (sum >> 16) sum = (sum & 0xffff) + (sum >>> 16);
  return sum & 0xffff;
}

function pseudoHeader(src, dst, protocol, length) {
  return Buffer.from([
    ...src, ...dst,
    ...P.u32(length),
    0, 0, 0, protocol
  ]);
}

test("an emitted IPv6 packet is well formed and its checksums verify", opts, () => {
  const payload = Buffer.from("hello from the server", "ascii");
  const answer = kotlin.fields(kotlin.one(
    `tcp ${P.hex(P.V6_REMOTE)} ${P.hex(P.V6_LOCAL)} 443 51000 1000 2000 24 65535 ${P.hex(payload)} -`
  ));
  const packet = Buffer.from(answer.pkt, "hex");

  assert.equal(packet.length, 40 + 20 + payload.length);
  assert.equal(packet[0] >> 4, 6, "version nibble");
  assert.equal(packet.readUInt16BE(4), 20 + payload.length, "payload length field");
  assert.equal(packet[6], 6, "next header is TCP");
  assert.equal(packet[7], 64, "hop limit");
  assert.equal(P.hex(packet.subarray(8, 24)), P.hex(P.V6_REMOTE));
  assert.equal(P.hex(packet.subarray(24, 40)), P.hex(P.V6_LOCAL));
  assert.equal(packet.readUInt16BE(40), 443);
  assert.equal(packet.readUInt16BE(42), 51000);

  const segment = packet.subarray(40);
  assert.equal(
    ones(Buffer.concat([pseudoHeader(P.V6_REMOTE, P.V6_LOCAL, 6, segment.length), segment])),
    0xffff,
    "TCP checksum over the IPv6 pseudo-header must verify — a wrong one is dropped by the client's stack, silently"
  );
});

test("an emitted IPv4 packet still verifies, header checksum included", opts, () => {
  const payload = Buffer.from("hello from the server", "ascii");
  const answer = kotlin.fields(kotlin.one(
    `tcp ${P.hex(P.V4_REMOTE)} ${P.hex(P.V4_LOCAL)} 443 51000 1000 2000 24 65535 ${P.hex(payload)} -`
  ));
  const packet = Buffer.from(answer.pkt, "hex");

  assert.equal(packet.length, 20 + 20 + payload.length);
  assert.equal(packet[0], 0x45);
  assert.equal(packet.readUInt16BE(2), packet.length, "total length field");
  assert.equal(packet[9], 6);
  assert.equal(ones(packet.subarray(0, 20)), 0xffff, "IPv4 header checksum");

  const segment = packet.subarray(20);
  assert.equal(ones(Buffer.concat([pseudoHeader(P.V4_REMOTE, P.V4_LOCAL, 6, segment.length), segment])), 0xffff);
});

test("the SYN-ACK carries an MSS option in both families", opts, () => {
  [[P.V4_REMOTE, P.V4_LOCAL, 20], [P.V6_REMOTE, P.V6_LOCAL, 40]].forEach(([src, dst, headerLength]) => {
    const answer = kotlin.fields(kotlin.one(
      `tcp ${P.hex(src)} ${P.hex(dst)} 443 51000 5 6 18 65535 - 1400`
    ));
    const packet = Buffer.from(answer.pkt, "hex");
    const tcp = packet.subarray(headerLength);
    assert.equal(packet.length, headerLength + 24);
    assert.equal(tcp[12] >> 4, 6, "data offset must count the option");
    assert.equal(tcp[20], 2, "option kind: MSS");
    assert.equal(tcp[21], 4, "option length");
    assert.equal(tcp.readUInt16BE(22), 1400);
    // 1400 payload + 20 TCP + 40 IPv6 = 1460, inside the tunnel's 1500-byte MTU.
    assert.ok(1400 + 20 + 40 <= 1500, "the advertised MSS must fit the IPv6 header too");
    assert.equal(ones(Buffer.concat([pseudoHeader(src, dst, 6, tcp.length), tcp])), 0xffff);
  });
});

test("an emitted UDP reply verifies, and IPv6 never sends a zero checksum", opts, () => {
  const payload = Buffer.from([0x00, 0x01, 0x02, 0x03]);
  [[P.V4_REMOTE, P.V4_LOCAL, 20], [P.V6_REMOTE, P.V6_LOCAL, 40]].forEach(([src, dst, headerLength]) => {
    const answer = kotlin.fields(kotlin.one(
      `udp ${P.hex(src)} ${P.hex(dst)} 123 51000 ${P.hex(payload)}`
    ));
    const packet = Buffer.from(answer.pkt, "hex");
    const segment = packet.subarray(headerLength);
    assert.equal(segment.readUInt16BE(4), 8 + payload.length, "UDP length field");
    assert.notEqual(segment.readUInt16BE(6), 0, "a zero UDP checksum is illegal in IPv6");
    assert.equal(ones(Buffer.concat([pseudoHeader(src, dst, 17, segment.length), segment])), 0xffff);
  });
});

test("flow keys cannot collide between the two families", opts, () => {
  const answers = kotlin.run([
    `key ${P.hex(P.V4_LOCAL)}`,
    `key ${P.hex(P.V6_LOCAL)}`,
    `key ${P.hex(P.V6_REMOTE)}`
  ]).map((answer) => kotlin.text(kotlin.fields(answer).k));

  assert.equal(answers[0], "10.111.222.5");
  assert.equal(answers[1], "[2001:db8:0:0:0:0:0:5]");
  assert.ok(answers[1].startsWith("[") && answers[1].endsWith("]"),
    "an IPv6 key must be bracketed, or its colons run into the port that follows it");
  assert.equal(new Set(answers).size, answers.length);
});

// ---------------------------------------------------------------------------
// The always-allow layer
// ---------------------------------------------------------------------------
//
// "Always-allow domains" told the user, in the app, that "domains here are
// never blocked". The list was written to SharedPreferences, read back, and
// rendered with a Remove button — and the filter never consulted it. On a
// Galaxy S24 Ultra a domain sitting in that list was still reset:
//
//     androidAllowlist = ["doordash.com"]
//     curl https://www.doordash.com  ->  Recv failure: Connection reset by peer
//
// A control that does nothing is worse than one that is absent, because the
// user believes it worked. These run the real matcher, allow layer included.

const CURATED = "doordash.com,mcdonalds.com";

/** Hex for a piece of text, so a value may safely contain a space. */
const asHex = (text) => P.hex(Buffer.from(text, "utf8"));

/** blockedApex through the shipped Kotlin: the apex, or null. */
function apex(host, allow, custom) {
  const list = allow && allow.length ? asHex(allow.join(",")) : "-";
  const own = custom && custom.length ? asHex(custom.join(",")) : "-";
  const answer = kotlin.one(`apex ${asHex(CURATED)} ${list} ${asHex(host)} ${own}`);
  return answer === "null" ? null : kotlin.text(kotlin.fields(answer).apex);
}

test("a curated brand is blocked when nothing exempts it", opts, () => {
  assert.equal(apex("doordash.com", []), "doordash.com");
  assert.equal(apex("www.doordash.com", []), "doordash.com");
  assert.equal(apex("order.doordash.com", []), "doordash.com", "subdomains match their apex");
  assert.equal(apex("example.com", []), null, "an uncurated host is not blocked");
});

test("a domain on the always-allow list is never blocked", opts, () => {
  assert.equal(
    apex("doordash.com", ["doordash.com"]), null,
    "the always-allow list is what the UI calls a per-site whitelist; it must win"
  );
  assert.equal(
    apex("www.doordash.com", ["doordash.com"]), null,
    "allowing a domain has to cover the www host the user actually types"
  );
  assert.equal(
    apex("order.doordash.com", ["doordash.com"]), null,
    "an exemption covers subdomains by the same rule blocking uses"
  );
});

test("an exemption frees only what it names", opts, () => {
  assert.equal(
    apex("mcdonalds.com", ["doordash.com"]), "mcdonalds.com",
    "allowing one brand must not switch off the rest of the list"
  );
  assert.equal(
    apex("notdoordash.com", ["doordash.com"]), null,
    "a suffix match is on label boundaries, so this is neither blocked nor an exemption"
  );
  assert.equal(
    apex("doordash.com.evil.test", ["doordash.com"]), null,
    "a lookalike that merely CONTAINS the name is not the domain"
  );
});

test("allow entries are normalised the same way hosts are", opts, () => {
  assert.equal(apex("doordash.com", ["www.doordash.com"]), null, "a www. entry means the domain");
  assert.equal(apex("doordash.com", ["DoorDash.COM"]), null, "case cannot decide whether blocking happens");
  assert.equal(apex("doordash.com", ["doordash.com."]), null, "a trailing root dot is the same name");
  assert.equal(apex("doordash.com", ["  "]), "doordash.com", "blank entries exempt nothing");
});

// ---------------------------------------------------------------------------
// Custom URLs
// ---------------------------------------------------------------------------
//
// The generated asset holds the curated brands and nothing else, so a domain
// the user types into "Custom URLs" can never appear in it. That section took a
// domain, listed it back with a Remove button, and the filter never saw it: on
// the device a custom entry was simply not blocked. The extension builds its
// catalog as a UNION — delivery + fast food + custom URLs — and these assert the
// native filter does the same, with the allow layer still winning over both.

test("a custom domain the user added is blocked", opts, () => {
  assert.equal(
    apex("nowhere.test", [], ["nowhere.test"]), "nowhere.test",
    "a domain in Custom URLs must actually be blocked"
  );
  assert.equal(
    apex("shop.nowhere.test", [], ["nowhere.test"]), "nowhere.test",
    "a custom entry covers its subdomains, like every other rule here"
  );
  assert.equal(
    apex("nowhere.test", [], []), null,
    "and only because the user asked — it is not curated"
  );
});

test("custom URLs are a union with the curated set, not a replacement", opts, () => {
  assert.equal(
    apex("mcdonalds.com", [], ["nowhere.test"]), "mcdonalds.com",
    "adding a custom domain must not narrow blocking to only that domain"
  );
  assert.equal(
    apex("doordash.com", [], ["nowhere.test"]), "doordash.com",
    "the curated brands stay blocked alongside the user's own"
  );
});

test("the allow layer wins over a custom entry too", opts, () => {
  assert.equal(
    apex("nowhere.test", ["nowhere.test"], ["nowhere.test"]), null,
    "a domain on both lists is allowed; the escape hatch has to be the stronger one"
  );
});

test("a custom entry is normalised like every other host", opts, () => {
  assert.equal(apex("nowhere.test", [], ["www.nowhere.test"]), "nowhere.test", "a www. entry means the domain");
  assert.equal(apex("nowhere.test", [], ["NoWhere.TEST"]), "nowhere.test", "case cannot decide whether blocking happens");
  assert.equal(apex("nowhere.test", [], ["  "]), null, "a blank entry blocks nothing");
});

// ---------------------------------------------------------------------------
// The blocking schedule
// ---------------------------------------------------------------------------
//
// "Block only during scheduled hours" lives in Blocking Options, which reads as
// covering everything FitShield blocks. It did not: AppBlockPolicy honoured the
// window for APPS while the connection filter reset SITES around the clock. One
// switch, two answers, and nothing in the UI said so.
//
// The window is inclusive at both ends, and an overnight window wraps midnight —
// the case where the obvious "now in start..end" is false for every minute of it.

/** Schedule.withinWindow through the shipped Kotlin. */
function within(enabled, start, end, nowMinutes) {
  return kotlin.one(`sched ${enabled} ${start} ${end} ${nowMinutes}`) === "true";
}

const at = (h, m) => h * 60 + (m || 0);

test("scheduling off means blocking is always active", opts, () => {
  assert.equal(within(false, "18:00", "23:00", at(3)), true);
  assert.equal(within(false, "18:00", "23:00", at(20)), true);
});

test("a daytime window blocks inside it and only inside it", opts, () => {
  assert.equal(within(true, "18:00", "23:00", at(17, 59)), false, "a minute before the window");
  assert.equal(within(true, "18:00", "23:00", at(18)), true, "the window is inclusive at the start");
  assert.equal(within(true, "18:00", "23:00", at(20, 30)), true, "the middle");
  assert.equal(within(true, "18:00", "23:00", at(23)), true, "inclusive at the end");
  assert.equal(within(true, "18:00", "23:00", at(23, 1)), false, "a minute after");
});

test("an overnight window wraps past midnight", opts, () => {
  assert.equal(within(true, "22:00", "02:00", at(23)), true, "before midnight is inside");
  assert.equal(within(true, "22:00", "02:00", at(0, 30)), true, "after midnight is still inside");
  assert.equal(within(true, "22:00", "02:00", at(2)), true, "inclusive at the wrapped end");
  assert.equal(within(true, "22:00", "02:00", at(2, 1)), false, "and closes");
  assert.equal(within(true, "22:00", "02:00", at(12)), false, "midday is outside");
});

test("a window that cannot be read leaves protection ON", opts, () => {
  // The direction this has to fail in: a malformed time must never become a
  // quiet way to switch blocking off.
  assert.equal(within(true, "nonsense", "23:00", at(3)), true);
  assert.equal(within(true, "18:00", "", at(3)), true);
  assert.equal(within(true, "25:00", "23:00", at(3)), true, "an hour that does not exist");
  assert.equal(within(true, "18:70", "23:00", at(3)), true, "a minute that does not exist");
});

// ---------------------------------------------------------------------------
// "Open anyway" has to reach the connection filter too
// ---------------------------------------------------------------------------
//
// The pause screen's "Open anyway" grants a temporary unlock, and the UI calls
// it "unlocks that app for this many minutes". Only the AccessibilityService
// honoured it. The VpnService went on resetting the brand's domains, so on a
// Galaxy S24 Ultra Grubhub opened straight into "We weren't able to load this
// screen" — and every retry counted as another interruption. An unlock the user
// explicitly chose has to hold across both layers or it is not an unlock.

/** BlockDecision.shouldReset through the shipped Kotlin. */
function shouldReset(apex, scheduleAllows, unlockedUntil, now) {
  const a = apex === null ? "-" : asHex(apex);
  const u = unlockedUntil === null ? "-" : String(unlockedUntil);
  return kotlin.one(`reset ${a} ${scheduleAllows} ${u} ${now}`) === "true";
}

const NOW = 1_700_000_000_000;

test("a matched brand is reset when nothing exempts it", opts, () => {
  assert.equal(shouldReset("grubhub.com", true, null, NOW), true);
});

test("an unmatched host is never reset", opts, () => {
  assert.equal(shouldReset(null, true, null, NOW), false, "no apex means nothing to block");
});

test("an active unlock stops the filter resetting that brand", opts, () => {
  assert.equal(
    shouldReset("grubhub.com", true, NOW + 60_000, NOW), false,
    "the app the user just chose to open must be able to reach its own servers"
  );
});

test("an expired unlock does not keep a brand open forever", opts, () => {
  assert.equal(shouldReset("grubhub.com", true, NOW - 1, NOW), true, "one millisecond past is past");
  assert.equal(shouldReset("grubhub.com", true, NOW, NOW), true, "the expiry instant itself is over");
});

test("the schedule still wins when it is closed", opts, () => {
  assert.equal(shouldReset("grubhub.com", false, null, NOW), false, "outside the window nothing is reset");
  assert.equal(shouldReset("grubhub.com", false, NOW + 60_000, NOW), false, "both reasons agree");
});

// ---------------------------------------------------------------------------
// IPv6 on a network that has no IPv6
// ---------------------------------------------------------------------------
//
// ::/0 is routed into the tun so IPv6 is filtered rather than bypassing the
// filter. On a network with no IPv6 route that backfired: the client's IPv6
// attempt was accepted by the tunnel, the handshake completed locally, the
// upstream connect failed, and the client got an RST. Having seen a connection
// ESTABLISH, the browser reported the site as reset instead of falling back to
// IPv4 — so on an IPv4-only Wi-Fi, FitShield broke unrelated dual-stack sites.
//
// Measured on a Galaxy S24 Ultra joined to an IPv4-only hotspot: with FitShield
// on, en.wikipedia.org gave "This site can't be reached. The connection was
// reset."; with it off, the same page loaded, because the IPv6 connect failed
// in 5ms and Happy Eyeballs moved to IPv4. Refusing the SYN reproduces that
// fast failure.

/** BlockDecision.shouldRefuseSyn through the shipped Kotlin. */
function refuses(destIsIpv6, ipv6Upstream) {
  return kotlin.one(`refuse ${destIsIpv6} ${ipv6Upstream}`) === "true";
}

test("an IPv6 connection is refused when the network has no IPv6", opts, () => {
  assert.equal(
    refuses(true, false), true,
    "accepting it would establish a connection that cannot be honoured, and the client would not fail over"
  );
});

test("IPv6 is untouched on a network that really has it", opts, () => {
  assert.equal(
    refuses(true, true), false,
    "this is the dual-stack case that must keep working, and keep being filtered"
  );
});

test("IPv4 is never refused by this rule", opts, () => {
  assert.equal(refuses(false, false), false, "no IPv6 upstream says nothing about IPv4");
  assert.equal(refuses(false, true), false);
});
