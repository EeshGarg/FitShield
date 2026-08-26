"use strict";
/**
 * Crafted IP packets for the Android connection-filter tests.
 *
 * Everything here builds the SAME payload over IPv4 and over IPv6 so the two
 * paths can be compared directly. That comparison is the point: IPv6 was
 * routed into the tunnel and then discarded, which cost an IPv6-only carrier's
 * users their entire internet connection while FitShield was on, and the fix is
 * only a fix if both families come out of the parser identically.
 */

const V4_LOCAL = [10, 111, 222, 5];
const V4_REMOTE = [93, 184, 216, 34];
// 2001:db8::5 and 2606:4700::1111 (documentation + a real-world-shaped address)
const V6_LOCAL = [0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5];
const V6_REMOTE = [0x26, 0x06, 0x47, 0x00, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x11, 0x11];

const u16 = (v) => [(v >> 8) & 0xff, v & 0xff];
const u32 = (v) => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];

/** A TLS ClientHello carrying [host] in the server_name extension. */
function clientHello(host) {
  const name = Buffer.from(host, "ascii");
  const serverName = [
    ...u16(0x0000),                                  // extension: server_name
    ...u16(name.length + 5),                          // extension length
    ...u16(name.length + 3),                          // server_name_list length
    0x00,                                             // name_type: host_name
    ...u16(name.length),
    ...name
  ];
  const body = [
    ...u16(0x0303),                                   // client_version TLS 1.2
    ...new Array(32).fill(0xab),                      // random
    0x00,                                             // session_id length
    ...u16(2), 0x13, 0x01,                            // cipher suites
    0x01, 0x00,                                       // compression methods
    ...u16(serverName.length),                        // extensions length
    ...serverName
  ];
  const handshake = [0x01, ...u32(body.length).slice(1), ...body];   // 3-byte length
  return Buffer.from([0x16, 0x03, 0x01, ...u16(handshake.length), ...handshake]);
}

/** A minimal HTTP/1.1 request naming [host]. */
function httpRequest(host) {
  return Buffer.from(`GET /order HTTP/1.1\r\nHost: ${host}\r\nUser-Agent: t\r\n\r\n`, "ascii");
}

/** A 20-byte TCP header plus payload. */
function tcpSegment({ srcPort = 51000, dstPort = 443, seq = 1, ack = 1, flags = 0x18, payload = Buffer.alloc(0) }) {
  return Buffer.from([
    ...u16(srcPort), ...u16(dstPort),
    ...u32(seq), ...u32(ack),
    0x50, flags,
    ...u16(65535),
    0x00, 0x00,                                       // checksum (not verified on input)
    0x00, 0x00,                                       // urgent pointer
    ...payload
  ]);
}

/** An 8-byte UDP header plus payload. */
function udpSegment({ srcPort = 51000, dstPort = 443, payload = Buffer.alloc(0) }) {
  return Buffer.from([
    ...u16(srcPort), ...u16(dstPort),
    ...u16(8 + payload.length),
    0x00, 0x00,
    ...payload
  ]);
}

/**
 * An IPv4 packet. [flagsFrag] is the raw flags/fragment-offset field, so a test
 * can set More-Fragments (0x2000) or a non-zero offset.
 */
function ipv4({ protocol = 6, payload, flagsFrag = 0x4000, ihlWords = 5, src = V4_LOCAL, dst = V4_REMOTE }) {
  const optionBytes = (ihlWords - 5) * 4;
  const total = ihlWords * 4 + payload.length;
  return Buffer.from([
    0x40 | ihlWords, 0x00,
    ...u16(total),
    ...u16(0x1234),
    ...u16(flagsFrag),
    64, protocol,
    0x00, 0x00,                                       // header checksum (not verified on input)
    ...src, ...dst,
    ...new Array(optionBytes).fill(0x01),             // NOP options
    ...payload
  ]);
}

/**
 * An IPv6 packet. [extensions] is a list of `{ type, bytes }`, chained in order
 * before the transport header exactly as the wire format does it.
 */
function ipv6({ protocol = 6, payload, extensions = [], src = V6_LOCAL, dst = V6_REMOTE }) {
  // The next-header field of each block is the type of the block that follows.
  const chain = [];
  let firstNext = protocol;
  for (let i = extensions.length - 1; i >= 0; i -= 1) {
    const followingType = i === extensions.length - 1 ? protocol : extensions[i + 1].type;
    chain.unshift([followingType, ...extensions[i].bytes]);
    firstNext = extensions[i].type;
  }
  const extBytes = chain.flat();
  const body = [...extBytes, ...payload];
  return Buffer.from([
    0x60, 0x00, 0x00, 0x00,
    ...u16(body.length),
    firstNext, 64,
    ...src, ...dst,
    ...body
  ]);
}

/**
 * A Hop-by-Hop / Destination-Options style extension header body: the length
 * byte (in 8-octet units beyond the first 8) plus padding. The leading
 * next-header byte is supplied by [ipv6].
 */
function optionsHeader(type, extraUnits = 0) {
  const size = (extraUnits + 1) * 8;
  return { type, bytes: [extraUnits, ...new Array(size - 2).fill(0x00)] };
}

/** A Fragment header (type 44): offset in 8-octet units and the More flag. */
function fragmentHeader({ offsetUnits = 0, more = false, id = 0x11223344 }) {
  const field = (offsetUnits << 3) | (more ? 1 : 0);
  return { type: 44, bytes: [0x00, ...u16(field), ...u32(id)] };
}

/** Authentication Header (type 51): length in 4-octet units, minus 2. */
function authHeader(units = 2) {
  const size = (units + 2) * 4;
  return { type: 51, bytes: [units, ...new Array(size - 2).fill(0x00)] };
}

const hex = (buf) => Buffer.from(buf).toString("hex");

module.exports = {
  V4_LOCAL, V4_REMOTE, V6_LOCAL, V6_REMOTE,
  clientHello, httpRequest, tcpSegment, udpSegment,
  ipv4, ipv6, optionsHeader, fragmentHeader, authHeader, hex, u16, u32
};
