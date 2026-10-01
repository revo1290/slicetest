/**
 * Just enough X.509 to impersonate hosts in tests: a throwaway certificate
 * authority, leaf certificates for the intercepted hosts, and the CA in the
 * formats apps read it from (PEM bundle, and a PKCS#12 trust store for Java).
 * DER is written by hand so the package needs no crypto dependency.
 */
import { createHash, createPublicKey, generateKeyPairSync, KeyObject, randomBytes, sign, X509Certificate } from "node:crypto";

// --- DER ---

function len(n: number) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
const tlv = (tag: number, ...content: Buffer[]) => {
  const body = Buffer.concat(content);
  return Buffer.concat([Buffer.from([tag]), len(body.length), body]);
};
export const seq = (...items: Buffer[]) => tlv(0x30, ...items);
const set = (...items: Buffer[]) => tlv(0x31, ...items);
const octets = (b: Buffer) => tlv(0x04, b);
const bits = (b: Buffer) => tlv(0x03, Buffer.from([0]), b);
const utf8 = (s: string) => tlv(0x0c, Buffer.from(s, "utf8"));
const bmp = (s: string) => tlv(0x1e, Buffer.from(s, "utf16le").swap16());
const bool = (v: boolean) => tlv(0x01, Buffer.from([v ? 0xff : 0]));
const explicit = (n: number, ...content: Buffer[]) => tlv(0xa0 + n, ...content);
const int = (b: Buffer) => {
  let i = 0;
  while (i < b.length - 1 && b[i] === 0) i++;
  const v = b.subarray(i);
  return tlv(0x02, v[0]! & 0x80 ? Buffer.concat([Buffer.from([0]), v]) : v);
};
const oid = (dotted: string) => {
  const [a, b, ...rest] = dotted.split(".").map(Number);
  const out = [a! * 40 + b!];
  for (const n of rest) {
    const chunk: number[] = [];
    let v = n;
    do {
      chunk.unshift(v & 0x7f);
      v = Math.floor(v / 128);
    } while (v > 0);
    for (let i = 0; i < chunk.length - 1; i++) chunk[i]! |= 0x80;
    out.push(...chunk);
  }
  return tlv(0x06, Buffer.from(out));
};
const time = (d: Date) => {
  // UTCTime up to 2049, GeneralizedTime after, as RFC 5280 requires.
  const iso = d.toISOString().replace(/[-:T]/g, "").slice(0, 14);
  return d.getUTCFullYear() < 2050 ? tlv(0x17, Buffer.from(`${iso.slice(2)}Z`)) : tlv(0x18, Buffer.from(`${iso}Z`));
};

const OID = {
  ecdsaSha256: "1.2.840.10045.4.3.2",
  commonName: "2.5.4.3",
  organization: "2.5.4.10",
  basicConstraints: "2.5.29.19",
  keyUsage: "2.5.29.15",
  extKeyUsage: "2.5.29.37",
  serverAuth: "1.3.6.1.5.5.7.3.1",
  subjectAltName: "2.5.29.17",
  subjectKeyId: "2.5.29.14",
  authorityKeyId: "2.5.29.35",
  data: "1.2.840.113549.1.7.1",
  certBag: "1.2.840.113549.1.12.10.1.3",
  x509Certificate: "1.2.840.113549.1.9.22.1",
  friendlyName: "1.2.840.113549.1.9.20",
  // Java only treats a PKCS#12 certificate as trusted when it carries this attribute.
  oracleTrustedKeyUsage: "2.16.840.1.113894.746875.1.1",
  anyExtendedKeyUsage: "2.5.29.37.0",
};

const name = (cn: string) => seq(set(seq(oid(OID.organization), utf8("slicetest"))), set(seq(oid(OID.commonName), utf8(cn))));
const extension = (id: string, critical: boolean, value: Buffer) => seq(oid(id), ...(critical ? [bool(true)] : []), octets(value));
const keyId = (key: KeyObject) => createHash("sha1").update(createPublicKey(key).export({ type: "spki", format: "der" })).digest();

interface Issued {
  key: KeyObject;
  der: Buffer;
  pem: string;
}

function certificate(opts: { subject: string; publicKey: KeyObject; issuer: string; signer: KeyObject; issuerKeyId: Buffer; ca: boolean; hosts?: string[] }): Buffer {
  const now = Date.now();
  const ski = keyId(opts.publicKey);
  const extensions = [
    extension(OID.basicConstraints, true, seq(...(opts.ca ? [bool(true)] : []))),
    // CA: keyCertSign + cRLSign. Leaf: digitalSignature.
    extension(OID.keyUsage, true, opts.ca ? tlv(0x03, Buffer.from([1, 0x06])) : tlv(0x03, Buffer.from([7, 0x80]))),
    extension(OID.subjectKeyId, false, octets(ski)),
    ...(opts.ca
      ? []
      : [
          extension(OID.authorityKeyId, false, seq(tlv(0x80, opts.issuerKeyId))),
          extension(OID.extKeyUsage, false, seq(oid(OID.serverAuth))),
          extension(OID.subjectAltName, false, seq(...opts.hosts!.map((h) => tlv(0x82, Buffer.from(h, "ascii"))))),
        ]),
  ];
  const algorithm = seq(oid(OID.ecdsaSha256));
  const tbs = seq(
    explicit(0, int(Buffer.from([2]))), // v3
    int(randomBytes(16)),
    algorithm,
    name(opts.issuer),
    seq(time(new Date(now - 60 * 60_000)), time(new Date(now + (opts.ca ? 7 : 2) * 24 * 60 * 60_000))),
    name(opts.subject),
    createPublicKey(opts.publicKey).export({ type: "spki", format: "der" }),
    explicit(3, seq(...extensions)),
  );
  return seq(tbs, algorithm, bits(sign("sha256", tbs, opts.signer)));
}

const toPem = (der: Buffer) => `-----BEGIN CERTIFICATE-----\n${der.toString("base64").replace(/.{64}/g, "$&\n").replace(/\n?$/, "\n")}-----END CERTIFICATE-----\n`;

/** A certificate authority that exists for one test run. */
export class Authority {
  readonly key: KeyObject;
  readonly der: Buffer;
  readonly pem: string;
  readonly #keyId: Buffer;
  readonly #leaves = new Map<string, Issued>();

  constructor() {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    this.key = privateKey;
    this.#keyId = keyId(privateKey);
    this.der = certificate({ subject: "slicetest test CA", publicKey: privateKey, issuer: "slicetest test CA", signer: privateKey, issuerKeyId: this.#keyId, ca: true });
    this.pem = toPem(this.der);
  }

  /** A certificate for `host`, signed by this authority (cached). */
  leaf(host: string): Issued {
    let issued = this.#leaves.get(host);
    if (!issued) {
      const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
      const der = certificate({ subject: host, publicKey: privateKey, issuer: "slicetest test CA", signer: this.key, issuerKeyId: this.#keyId, ca: false, hosts: [host] });
      issued = { key: privateKey, der, pem: toPem(der) };
      this.#leaves.set(host, issued);
    }
    return issued;
  }
}

/** PEM bundle of `extra` plus the usual public roots, for SSL_CERT_FILE and friends (which replace the default store). */
export function pemBundle(roots: readonly string[], extra: string) {
  return `${extra}${roots.map((r) => (r.endsWith("\n") ? r : `${r}\n`)).join("")}`;
}

/**
 * A PKCS#12 trust store of certificates, readable by Java without a password
 * (`-Djavax.net.ssl.trustStoreType=PKCS12`, no `trustStorePassword`): no MAC and
 * unencrypted certificate bags, each marked as a trusted certificate entry.
 */
export function pkcs12TrustStore(certs: { alias: string; der: Buffer }[]) {
  const bags = certs.map(({ alias, der }) =>
    seq(
      oid(OID.certBag),
      explicit(0, seq(oid(OID.x509Certificate), explicit(0, octets(der)))),
      set(seq(oid(OID.friendlyName), set(bmp(alias))), seq(oid(OID.oracleTrustedKeyUsage), set(oid(OID.anyExtendedKeyUsage)))),
    ),
  );
  const safeContents = seq(...bags);
  const authSafe = seq(seq(oid(OID.data), explicit(0, octets(safeContents))));
  return seq(int(Buffer.from([3])), seq(oid(OID.data), explicit(0, octets(authSafe))));
}

/** DER of a PEM certificate, or undefined when it doesn't parse. */
export function pemToDer(pem: string) {
  try {
    return Buffer.from(new X509Certificate(pem).raw);
  } catch {
    return undefined;
  }
}
