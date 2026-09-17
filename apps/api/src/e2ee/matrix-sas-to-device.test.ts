import { deepEqual, equal, notEqual, ok, throws } from "node:assert/strict";
import { before, describe, it } from "node:test";
import { parseMatrixSasToDeviceRequest, MatrixSasValidationError } from "./matrix-sas-to-device";
import { hashMatrixCanonicalJson } from "./matrix-key-upload";
import { parseMatrixToDeviceRequest, MatrixToDeviceValidationError } from "./matrix-to-device";
import { E2EE_RELEASE } from "./e2ee-release";
import { runMatrixSasFixture, SAS_FIXTURE_CANDIDATE, SAS_FIXTURE_TRUSTED, SAS_FIXTURE_USER, type SasFixtureEvent } from "./testing/matrix-sas.fixture";

type Json = Record<string, any>;
const NAMES = ["request", "ready", "start", "accept", "key", "mac", "done", "cancel"];
let events: SasFixtureEvent[];
const eventName = (event: SasFixtureEvent) => event.eventType.slice("m.key.verification.".length);
function parse(e: SasFixtureEvent) { return parseMatrixSasToDeviceRequest(e.eventType, e.transactionId, e.body, e.expected); }
function fixture(name = "request") { return structuredClone(events.find((event) => eventName(event) === name)!); }
function content(e: SasFixtureEvent): Json { return e.body.messages[e.expected.userId][e.expected.recipientDeviceId]; }
function invalid(operation: () => unknown, code?: string) {
  throws(operation, (error) => error instanceof MatrixSasValidationError && (!code || error.code === code));
}

describe("SAS de cuarentena: perfil público acotado, no autorización", () => {
  before(async () => {
    // Validate every real SDK event BEFORE delivery to the other SDK machine.
    // Synthetic confirmations only; no signatures are published or secrets sent.
    events = [...await runMatrixSasFixture((event) => { parse(event); }),
      ...await runMatrixSasFixture((event) => { parse(event); }, "m.mismatched_sas")];
  });
  for (const name of NAMES) {
    it(`acepta ${name} real del SDK sin cambiar su contenido`, () => {
      const f = fixture(name); const result = parse(f);
      deepEqual(result.messages, f.body.messages); equal(result.flowId, f.expected.flowId);
      equal(result.transactionId, f.transactionId); equal(result.senderDeviceId, f.expected.senderDeviceId);
      deepEqual(Object.keys(result).sort(), ["canonicalSha256", "eventType", "flowId", "messages", "recipientDeviceId", "senderDeviceId", "transactionId"]);
      equal(result.canonicalSha256, hashMatrixCanonicalJson({ event_type: f.eventType, transaction_id: f.transactionId,
        sender_device_id: f.expected.senderDeviceId, pinned_master_key: f.expected.pinnedMasterKey, messages: f.body.messages }));
    });
  }
  for (const code of ["m.user", "m.timeout"]) {
    it(`acepta cancelación ${code} del SDK y ambos extremos terminan cancelados`, async () => {
      const cancelled = await runMatrixSasFixture((event) => { parse(event); }, code);
      equal(content(cancelled.find((event) => eventName(event) === "cancel")!).code, code);
      equal(cancelled.some((event) => eventName(event) === "done"), false);
    });
  }
  for (const cancel of [undefined, "m.user", "m.mismatched_sas"]) {
    it(`el bootstrap inicia SAS dirigido al candidato: ${cancel ?? "completa"}`, async () => {
      const captured = await runMatrixSasFixture((event) => { parse(event); }, cancel, "TRUSTED");
      const request = captured[0]; equal(eventName(request), "request");
      equal(request.expected.senderDeviceId, SAS_FIXTURE_TRUSTED);
      equal(request.expected.recipientDeviceId, SAS_FIXTURE_CANDIDATE);
      equal(content(request).from_device, SAS_FIXTURE_TRUSTED);
      equal(captured.some((event) => eventName(event) === "done"), !cancel);
    });
  }
  it("captura los MAC iniciales: confiable dispositivo+master, candidato solo dispositivo", () => {
    const macs = events.filter((event) => eventName(event) === "mac"); equal(macs.length, 2);
    for (const f of macs) {
      const keys = Object.keys(content(f).mac).sort();
      deepEqual(keys, (f.expected.senderDeviceId === SAS_FIXTURE_TRUSTED ?
        [`ed25519:${SAS_FIXTURE_TRUSTED}`, `ed25519:${f.expected.pinnedMasterKey}`] : [`ed25519:${SAS_FIXTURE_CANDIDATE}`]).sort());
    }
  });
  it("conserva ofertas legacy/MSC del SDK pero accept elige exclusivamente v2 y no tiene method", () => {
    const start = content(fixture("start"));
    deepEqual(start.message_authentication_codes, ["hkdf-hmac-sha256", "hkdf-hmac-sha256.v2", "org.matrix.msc3783.hkdf-hmac-sha256"]);
    const accept = fixture("accept"); equal(content(accept).message_authentication_code, "hkdf-hmac-sha256.v2");
    equal(Object.hasOwn(content(accept), "method"), false);
    content(accept).method = "m.sas.v1"; invalid(() => parse(accept), "MATRIX_SAS_CONTENT_INVALID");
  });
  it("no confunde ni exige distintos los espacios HTTP/flow", () => {
    const f = fixture("done"); const original = parse(f);
    f.transactionId = f.expected.flowId;
    const equalIds = parse(f); equal(equalIds.transactionId, equalIds.flowId);
    f.transactionId = "another-http-request"; const differentIds = parse(f);
    equal(differentIds.flowId, original.flowId); notEqual(differentIds.canonicalSha256, equalIds.canonicalSha256);
  });
  it("hash de reintento incluye envío, emisor, destinatario, flujo y pin, sin mutar el contexto", () => {
    const f = fixture("key"); const original = parse(f);
    deepEqual(parse(f), original);
    for (const change of ["sender", "target", "flow", "pin"] as const) {
      const altered = fixture("key");
      if (change === "sender") altered.expected.senderDeviceId = "D44444444444444448444444444444444";
      if (change === "target") {
        altered.expected.recipientDeviceId = "D55555555555545558555555555555555";
        altered.body.messages[altered.expected.userId] = { [altered.expected.recipientDeviceId]: content(fixture("key")) };
      }
      if (change === "flow") { altered.expected.flowId = "new-flow"; content(altered).transaction_id = "new-flow"; }
      if (change === "pin") altered.expected.pinnedMasterKey = Buffer.alloc(32, 5).toString("base64").replace(/=+$/, "");
      notEqual(parse(altered).canonicalSha256, original.canonicalSha256);
    }
  });
  it("reordenar objetos conserva hash, reordenar ofertas no; nunca normaliza arrays", () => {
    const f = fixture("start"); const original = parse(f);
    f.body = reverseObjects(f.body); equal(parse(f).canonicalSha256, original.canonicalSha256);
    content(f).message_authentication_codes.reverse();
    const changed = parse(f); notEqual(changed.canonicalSha256, original.canonicalSha256);
    deepEqual(changed.messages, f.body.messages);
  });
  it("congela toda la salida sin conservar referencias a entrada", () => {
    const f = fixture("start"); const result = parse(f);
    const out = result.messages[f.expected.userId][f.expected.recipientDeviceId];
    for (const value of [result, result.messages, result.messages[f.expected.userId], out, out.hashes, out.message_authentication_codes]) ok(Object.isFrozen(value));
    notEqual(out, content(f)); notEqual(out.hashes, content(f).hashes);
    const hash = result.canonicalSha256; content(f).hashes[0] = "tampered";
    equal(result.canonicalSha256, hash); deepEqual(out.hashes, ["sha256"]);
    throws(() => (out.hashes as string[]).push("new"), TypeError);
  });
  it("no comparte referencias del mapa MAC", () => {
    const f = fixture("mac"); const result = parse(f);
    const mac = result.messages[f.expected.userId][f.expected.recipientDeviceId].mac;
    ok(Object.isFrozen(mac)); notEqual(mac, content(f).mac);
  });
  it("acepta registros JSON de prototipo nulo", () => {
    const f = fixture("mac"); const expected = parse(f);
    f.body = nullObjects(f.body); f.expected = nullObjects(f.expected);
    deepEqual(parse(f), expected);
  });
  for (const type of ["m.room.encrypted", "m.room.message", "m.secret.request", "m.secret.send", "m.room_key", "m.forwarded_room_key", "m.key.verification.fake", "m.key.verification.start ", "m.key.verification.qr"]) {
    it(`rechaza tipo ajeno al perfil: ${type}`, () => {
      const f = fixture(); f.eventType = type; invalid(() => parse(f), "MATRIX_SAS_EVENT_TYPE_INVALID");
    });
  }
  for (const id of ["", "x".repeat(256), "hello world", "flow/id", "flow\n", "á", 5, null]) {
    it("rechaza ID HTTP no canónico sin conversiones", () => {
      const f = fixture(); f.transactionId = id as string; invalid(() => parse(f), "MATRIX_SAS_TRANSACTION_ID_INVALID");
    });
  }
  for (const name of NAMES) {
    it(`${name}: rechaza flujo distinto y no toma el esperado del cuerpo`, () => {
      const f = fixture(name); content(f).transaction_id = "other-flow";
      invalid(() => parse(f), "MATRIX_SAS_FLOW_MISMATCH");
    });
    it(`${name}: todos los campos requeridos y ningún campo privado/extensión`, () => {
      for (const field of Object.keys(content(fixture(name)))) {
        const f = fixture(name); delete content(f)[field]; invalid(() => parse(f), "MATRIX_SAS_CONTENT_INVALID");
      }
      for (const field of ["private_key", "seed", "approved", "sender", "session_id", "m.relates_to", "org.matrix.msgid", "body", "next_method"]) {
        const f = fixture(name); content(f)[field] = "never-log-payload"; invalid(() => parse(f), "MATRIX_SAS_CONTENT_INVALID");
      }
    });
  }
  for (const name of ["request", "ready", "start"]) {
    it(`${name}: from_device es exactamente el emisor autenticado`, () => {
      const f = fixture(name); content(f).from_device = f.expected.recipientDeviceId;
      invalid(() => parse(f), "MATRIX_SAS_SENDER_MISMATCH");
    });
  }
  for (const mutation of ["empty-body", "extra-body", "foreign-user", "multi-user", "foreign-device", "multi-device", "wildcard", "empty-targets"]) {
    it(`rechaza encaminamiento no exclusivo: ${mutation}`, () => {
      const f = fixture(); const c = content(f);
      if (mutation === "empty-body") f.body = {} as any;
      if (mutation === "extra-body") (f.body as Json).approved = true;
      if (mutation === "foreign-user") f.body.messages = { "@other:sinochat.invalid": { [f.expected.recipientDeviceId]: c } };
      if (mutation === "multi-user") f.body.messages["@other:sinochat.invalid"] = { [f.expected.recipientDeviceId]: c };
      if (mutation === "foreign-device") f.body.messages[f.expected.userId] = { [f.expected.senderDeviceId]: c };
      if (mutation === "multi-device") f.body.messages[f.expected.userId][f.expected.senderDeviceId] = c;
      if (mutation === "wildcard") f.body.messages[f.expected.userId] = { "*": c };
      if (mutation === "empty-targets") f.body.messages[f.expected.userId] = {};
      invalid(() => parse(f));
    });
  }
  for (const field of ["userId", "senderDeviceId", "recipientDeviceId", "flowId", "pinnedMasterKey"] as const) {
    it(`contexto ${field} obligatorio y validado`, () => {
      const f = fixture(); (f.expected as Json)[field] = ""; invalid(() => parse(f), "MATRIX_SAS_SCOPE_INVALID");
      delete (f.expected as Json)[field]; invalid(() => parse(f), "MATRIX_SAS_SCOPE_INVALID");
    });
  }
  it("rechaza dispositivo remitente igual a destinatario", () => {
    const f = fixture(); f.expected.senderDeviceId = f.expected.recipientDeviceId; invalid(() => parse(f), "MATRIX_SAS_SCOPE_INVALID");
  });
  it("rechaza contexto con propiedades extra y namespace UTF-16 incompleto", () => {
    const f = fixture(); (f.expected as Json).approved = true; invalid(() => parse(f), "MATRIX_SAS_SCOPE_INVALID");
    delete (f.expected as Json).approved; f.expected.userId = SAS_FIXTURE_USER + "\ud800"; invalid(() => parse(f), "MATRIX_SAS_SCOPE_INVALID");
  });
  for (const value of [null, {}, "123", -1, -0, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    it("timestamp solo entero seguro no negativo", () => {
      const f = fixture(); content(f).timestamp = value; invalid(() => parse(f), "MATRIX_SAS_TIMESTAMP_INVALID");
    });
  }
  it("no confunde validación estructural del timestamp con vigencia de sesión/ceremonia", () => {
    const f = fixture(); content(f).timestamp = 0; ok(parse(f));
    content(f).timestamp = Number.MAX_SAFE_INTEGER; ok(parse(f));
  });
  for (const [name, field, choices] of [
    ["request", "methods", ["m.sas.v1"]], ["ready", "methods", ["m.sas.v1"]],
    ["start", "hashes", ["sha256"]], ["start", "key_agreement_protocols", ["curve25519-hkdf-sha256"]],
    ["start", "message_authentication_codes", ["hkdf-hmac-sha256.v2"]],
    ["start", "short_authentication_string", ["decimal"]], ["accept", "short_authentication_string", ["decimal"]]
  ] as const) {
    it(`${name}/${field}: elecciones conocidas, únicas, completas y sin accessor`, () => {
      for (const bad of [null, {}, [], ["unknown"], [...choices, ...choices], [null], new Array(1)]) {
        const f = fixture(name); content(f)[field] = bad; invalid(() => parse(f), "MATRIX_SAS_ALGORITHM_INVALID");
      }
      const f = fixture(name); content(f)[field] = [...choices]; ok(parse(f));
      content(f)[field] = Object.assign([...choices], { extra: "hidden" }); invalid(() => parse(f));
      let accessed = false; const arr = [...choices]; Object.defineProperty(arr, "0", { get() { accessed = true; return choices[0]; } });
      content(f)[field] = arr; invalid(() => parse(f)); equal(accessed, false);
    });
  }
  for (const field of ["message_authentication_code", "hash", "key_agreement_protocol"]) {
    it(`accept rechaza elección degradada: ${field}`, () => {
      const f = fixture("accept"); content(f)[field] = field === "message_authentication_code" ? "hkdf-hmac-sha256" : field === "hash" ? "sha1" : "curve25519";
      invalid(() => parse(f), "MATRIX_SAS_ALGORITHM_INVALID");
    });
  }
  it("no ofrece solo MAC legacy/MSC ni admite elegir MSC", () => {
    const start = fixture("start"); content(start).message_authentication_codes = ["hkdf-hmac-sha256", "org.matrix.msc3783.hkdf-hmac-sha256"];
    invalid(() => parse(start), "MATRIX_SAS_ALGORITHM_INVALID");
    const accept = fixture("accept"); content(accept).message_authentication_code = "org.matrix.msc3783.hkdf-hmac-sha256";
    invalid(() => parse(accept), "MATRIX_SAS_ALGORITHM_INVALID");
  });
  it("QR y reciprocate no se filtran/suprimen: el evento completo es rechazado", () => {
    const f = fixture(); content(f).methods.push("m.qr_code.show.v1", "m.reciprocate.v1"); invalid(() => parse(f));
    const start = fixture("start"); content(start).method = "m.reciprocate.v1"; invalid(() => parse(start));
  });
  for (const [name, field] of [["accept", "commitment"], ["key", "key"], ["mac", "keys"], ["mac", "mac"]] as const) {
    it(`${name}/${field}: solo 32 bytes Base64 canónica sin padding`, () => {
      const good = Buffer.alloc(32, 255).toString("base64").replace(/=+$/, "");
      for (const bad of [null, 0, "", good + "=", good + "\n", good.replace(/\//g, "_"), good.slice(0, -1) + "9", "A".repeat(42), "A".repeat(44), "A".repeat(100000)]) {
        const f = fixture(name);
        if (field === "mac") content(f).mac[`ed25519:${f.expected.senderDeviceId}`] = bad; else content(f)[field] = bad;
        invalid(() => parse(f));
      }
    });
  }
  it("MAC requiere clave del emisor, no basta master, destinatario u otras identidades", () => {
    for (const key of ["empty", "master-only", "ed25519:foreign", `ed25519:${SAS_FIXTURE_CANDIDATE}`, "curve25519:public", "self_signing", "user_signing"]) {
      const f = fixture("mac"); const mac = content(f).mac[`ed25519:${f.expected.senderDeviceId}`];
      content(f).mac = key === "empty" ? {} : { [key === "master-only" ? `ed25519:${f.expected.pinnedMasterKey}` : key]: mac };
      invalid(() => parse(f), "MATRIX_SAS_MAC_INVALID");
    }
  });
  it("MAC no admite raíz distinta o una tercera entrada", () => {
    const f = fixture("mac"); content(f).mac[`ed25519:${Buffer.alloc(32).toString("base64").replace(/=+$/, "")}`] = content(f).keys;
    invalid(() => parse(f), "MATRIX_SAS_MAC_INVALID");
  });
  it("la clave efímera, compromiso y MAC no son verificados criptográficamente por el parser", () => {
    for (const [name, field] of [["key", "key"], ["accept", "commitment"], ["mac", "keys"]]) {
      const f = fixture(name); content(f)[field] = "A".repeat(43); ok(parse(f));
    }
    const done = parse(fixture("done")); equal(Object.hasOwn(done, "approved"), false); equal(E2EE_RELEASE.state, "BLOCKED");
  });
  for (const [field, values] of [["code", ["", "unknown", "m.user ", null]], ["reason", ["", null, "x".repeat(513), "é".repeat(257), "line\nbreak", "nul\0", "\ud800", "\udfff"]]] as const) {
    it(`cancel/${field}: diagnóstico acotado y sin conversiones`, () => {
      for (const bad of values) { const f = fixture("cancel"); content(f)[field] = bad; invalid(() => parse(f), "MATRIX_SAS_CANCEL_INVALID"); }
    });
  }
  it("cancel admite texto Unicode válido acotado, sin usarlo como motivo del usuario", () => {
    const f = fixture("cancel"); content(f).reason = "Verificación cancelada 🔒"; ok(parse(f));
    content(f).reason = "é".repeat(256); ok(parse(f));
  });
  for (const level of ["body", "users", "devices", "content", "mac", "scope"] as const) {
    it(`${level}: no ejecuta getters/toJSON ni omite propiedades ocultas o símbolos`, () => {
      for (const mutation of ["getter", "hidden", "symbol", "toJSON", "prototype"] as const) {
        const f = fixture("mac"); const target = container(f, level); let called = false;
        if (mutation === "getter") Object.defineProperty(target, Object.keys(target)[0], { enumerable: true, get() { called = true; throw new Error("never-call"); } });
        if (mutation === "hidden") Object.defineProperty(target, "extra", { enumerable: false, value: "hidden" });
        if (mutation === "symbol") target[Symbol("extra") as any] = "symbol";
        if (mutation === "toJSON") target.toJSON = () => { called = true; throw new Error("never-call"); };
        if (mutation === "prototype") Object.setPrototypeOf(target, { injected: true });
        invalid(() => parse(f)); equal(called, false);
      }
    });
    it(`${level}: rechaza proxies activos y revocados sin ejecutar traps`, () => {
      const f = fixture("mac"); let called = false;
      const { proxy, revoke } = Proxy.revocable(container(f, level), { get() { called = true; throw new Error("never-call"); }, ownKeys() { called = true; throw new Error("never-call"); } });
      replaceContainer(f, level, proxy); invalid(() => parse(f)); equal(called, false);
      revoke(); invalid(() => parse(f)); equal(called, false);
    });
  }
  it("rechaza proxies y propiedades ocultas en arrays antes de serializar", () => {
    for (const mutation of ["proxy", "revoked", "hidden", "symbol", "length", "prototype"]) {
      const f = fixture("start"); let arr = content(f).message_authentication_codes; let called = false;
      if (mutation === "proxy" || mutation === "revoked") { const p = Proxy.revocable(arr, { get() { called = true; throw new Error("never-call"); } }); arr = p.proxy; if (mutation === "revoked") p.revoke(); }
      if (mutation === "hidden") Object.defineProperty(arr, "extra", { value: true });
      if (mutation === "symbol") arr[Symbol("extra")] = true;
      if (mutation === "length") arr.length = 1_000_000;
      if (mutation === "prototype") Object.setPrototypeOf(arr, null);
      content(f).message_authentication_codes = arr; invalid(() => parse(f)); equal(called, false);
    }
  });
  it("la ruta to-device de conversaciones sigue rechazando todos los eventos SAS", () => {
    for (const name of NAMES) { const f = fixture(name);
      throws(() => parseMatrixToDeviceRequest(f.eventType, f.transactionId, f.body), (e) => e instanceof MatrixToDeviceValidationError && e.code === "MATRIX_TO_DEVICE_EVENT_TYPE_INVALID");
    }
  });
});

function reverseObjects(value: any): any {
  if (Array.isArray(value)) return value.map(reverseObjects);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).reverse().map(([key, child]) => [key, reverseObjects(child)]));
  return value;
}
function nullObjects(value: any): any {
  if (Array.isArray(value)) return value.map(nullObjects);
  if (value && typeof value === "object") return Object.assign(Object.create(null), Object.fromEntries(Object.entries(value).map(([key, child]) => [key, nullObjects(child)])));
  return value;
}
function container(f: SasFixtureEvent, level: string): Json {
  if (level === "body") return f.body;
  if (level === "users") return f.body.messages;
  if (level === "devices") return f.body.messages[f.expected.userId];
  if (level === "content") return content(f);
  if (level === "mac") return content(f).mac;
  return f.expected;
}
function replaceContainer(f: SasFixtureEvent, level: string, value: any): void {
  if (level === "body") f.body = value;
  else if (level === "users") f.body.messages = value;
  else if (level === "devices") f.body.messages[f.expected.userId] = value;
  else if (level === "content") f.body.messages[f.expected.userId][f.expected.recipientDeviceId] = value;
  else if (level === "mac") content(f).mac = value;
  else f.expected = value;
}
