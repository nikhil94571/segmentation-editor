(async () => {
  const B = "http://127.0.0.1:8768";
  const r1 = await fetch(B + "/editor"); const ck = r1.headers.get("set-cookie").split(";")[0];
  const j = async (p, body) => { const r = await fetch(B + p, body ? { method: "POST", headers: { "Content-Type": "application/json", Cookie: ck }, body: JSON.stringify(body) } : { headers: { Cookie: ck } }); return [r.status, await r.json().catch(() => null)]; };
  const [, libs] = await j("/api/editor/libraries"); const lib = libs.libraries[0];
  const [, l] = await j("/api/editor/library?id=" + lib.id);
  const [s1, cl] = await j("/api/editor/library/classes", { id: lib.id, classes: [{ id: "a", name: "Gland", color: [1, 2, 3] }] });
  const [s2, sc] = await j("/api/editor/library/scale", { id: lib.id, um: 0.25 });
  const [s3, ms] = await j("/api/editor/library/measurements?id=" + lib.id);
  const [, sess] = await j("/api/editor/library/open", { id: lib.id, index: 0 });
  const sid = sess.id || sess.sid; const [, ses] = await j("/api/editor/session?id=" + encodeURIComponent(sid));
  const ring = ses.meta.regions[0].rings;
  const [s4, rs] = await j("/api/editor/reshape", { id: sid, op: "band", a: ring, dist: 8 });
  const [s5, sel] = await j("/api/editor/selftest", {});
  console.log(JSON.stringify({ cases: l.cases.length, default_classes: l.classes.length, set_classes: [s1, cl.classes.length], scale: [s2, sc.pixel_um], csv: [s3, ms.rows], reshape: [s4, rs.rings ? rs.rings.length : rs], selftest_blocked: s5 }));
})();
