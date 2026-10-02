'use strict';

const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert');
process.env.EDITOR_TOKEN = 'test-token';
const Database = require('better-sqlite3');

const mem = new Database(':memory:');
const { SCHEMA, setDb } = require('../src/db');
mem.exec(SCHEMA);
setDb(mem);

const { app } = require('../src/server');
const { REDACTED_TEXT } = require('../src/redaction');

const TOKEN = 'test-token';
let base;
let server;

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  mem.close();
});

beforeEach(() => {
  mem.exec(`
    DELETE FROM version_relations;
    DELETE FROM version_events;
    DELETE FROM versions;
    DELETE FROM redacted_sources;
    DELETE FROM relations;
    DELETE FROM claims;
    DELETE FROM events;
    DELETE FROM sqlite_sequence;
    UPDATE draft_meta SET revision = 0;
  `);
});

async function call(method, url, { token = TOKEN, body } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'X-Editor-Token': token } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

async function makeEvent(title, description = '') {
  const r = await call('POST', '/api/editor/events', { body: { title, description } });
  assert.strictEqual(r.status, 201);
  return r.json.event.id;
}

async function makeClaim(eventId, payload) {
  const r = await call('POST', `/api/editor/events/${eventId}/claims`, { body: payload });
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  return r.json.claim.id;
}

async function makeRel(earlierId, laterId, source = '') {
  const r = await call('POST', '/api/editor/relations', { body: { earlierId, laterId, source } });
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  return r.json.relation.id;
}

async function publish(selection, baseVersionNo) {
  const r = await call('POST', '/api/editor/publish', { body: { selection, baseVersionNo } });
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  return r.json;
}

const SRC_A = '李宝山口述，2021-07-05 访谈';
const SRC_B = '王秀兰口述';
const SRC_REL = '二人口述一致';

// 两事件两版本：v1 动员会(SRC_A)/通水会(SRC_B)，关系出处 SRC_REL；
// v2 追加抽水机(张德福口述)。
async function seedTwoVersions() {
  const e1 = await makeEvent('动员会');
  const e2 = await makeEvent('通水会');
  const c1 = await makeClaim(e1, { precision: 'day', year: 1958, month: 9, day: 12, source: SRC_A });
  const c2 = await makeClaim(e2, { precision: 'month', year: 1959, month: 5, source: SRC_B });
  const rid = await makeRel(e1, e2, SRC_REL);
  await publish(
    [
      { eventId: e1, claimId: c1 },
      { eventId: e2, claimId: c2 },
    ],
    0
  );
  const e3 = await makeEvent('抽水机到站');
  const c3 = await makeClaim(e3, { precision: 'year', year: 1962, source: '张德福口述' });
  await makeRel(e2, e3, '先有水渠后有抽水机');
  const v2 = await publish(
    [
      { eventId: e1, claimId: c1 },
      { eventId: e2, claimId: c2 },
      { eventId: e3, claimId: c3 },
    ],
    1
  );
  return { e1, e2, e3, c1, c2, c3, rid, v2No: v2.versionNo };
}

test('遮盖接口需要编辑者口令', async () => {
  const p = await call('POST', '/api/editor/redaction-preview', { token: null, body: { source: 'x' } });
  assert.strictEqual(p.status, 401);
  const c = await call('POST', '/api/editor/redaction', { token: null, body: { source: 'x', currentVersionNo: 0 } });
  assert.strictEqual(c.status, 401);
});

test('空文本（含纯空白）在预览与确认都被拒绝；参数非法 400', async () => {
  await seedTwoVersions();
  assert.strictEqual((await call('POST', '/api/editor/redaction-preview', { body: { source: '' } })).status, 400);
  assert.strictEqual((await call('POST', '/api/editor/redaction-preview', { body: { source: '   ' } })).status, 400);
  assert.strictEqual((await call('POST', '/api/editor/redaction-preview', { body: {} })).status, 400);
  const c1 = await call('POST', '/api/editor/redaction', { body: { source: '', currentVersionNo: 2 } });
  assert.strictEqual(c1.status, 400);
  const c2 = await call('POST', '/api/editor/redaction', { body: { source: SRC_A, currentVersionNo: -1 } });
  assert.strictEqual(c2.status, 400);
});

test('预览只读：列出该文本在全部已发布版本的命中位置与数量，不改数据', async () => {
  const ids = await seedTwoVersions();
  const before = await call('GET', '/api/editor/state');

  const pv = await call('POST', '/api/editor/redaction-preview', { body: { source: SRC_A } });
  assert.strictEqual(pv.status, 200, JSON.stringify(pv.json));
  assert.strictEqual(pv.json.currentVersionNo, 2);
  assert.strictEqual(pv.json.alreadyRedacted, false);
  assert.strictEqual(pv.json.counts.versionCount, 2); // v1 与 v2 都含该主张
  assert.strictEqual(pv.json.counts.eventClaimCount, 2);
  assert.strictEqual(pv.json.counts.relationCount, 0);
  assert.strictEqual(pv.json.counts.hitCount, 2);
  assert.deepStrictEqual(pv.json.versions.map((v) => v.versionNo), [1, 2]);
  const hit = pv.json.versions[0].eventClaimHits[0];
  assert.strictEqual(hit.eventId, ids.e1);
  assert.strictEqual(hit.claimId, ids.c1);
  assert.strictEqual(hit.title, '动员会');

  // 关系出处也能命中
  const pvRel = await call('POST', '/api/editor/redaction-preview', { body: { source: SRC_REL } });
  assert.strictEqual(pvRel.json.counts.versionCount, 2);
  assert.strictEqual(pvRel.json.counts.relationCount, 2);
  assert.strictEqual(pvRel.json.counts.eventClaimCount, 0);
  const rh = pvRel.json.versions[0].relationHits[0];
  assert.strictEqual(rh.relationId, ids.rid);
  assert.strictEqual(rh.earlierTitle, '动员会');
  assert.strictEqual(rh.laterTitle, '通水会');

  // 必须精确相等：部分文本不命中
  const pvMiss = await call('POST', '/api/editor/redaction-preview', { body: { source: '李宝山' } });
  assert.strictEqual(pvMiss.json.counts.hitCount, 0);
  assert.deepStrictEqual(pvMiss.json.versions, []);

  // 预览不改任何数据
  const after = await call('GET', '/api/editor/state');
  assert.strictEqual(after.json.draftRevisionNo, before.json.draftRevisionNo);
  const pub = await call('GET', '/api/public/chronicle', { token: null });
  assert.strictEqual(pub.json.version.events.find((e) => e.eventId === ids.e1).source, SRC_A);
});

test('确认后访客读最新与历史版本均显示「出处已遮盖」，其余字段与版本号不变', async () => {
  const ids = await seedTwoVersions();
  const pv = await call('POST', '/api/editor/redaction-preview', { body: { source: SRC_A } });
  const ok = await call('POST', '/api/editor/redaction', {
    body: { source: SRC_A, currentVersionNo: pv.json.currentVersionNo, editor: '合规员' },
  });
  assert.strictEqual(ok.status, 200, JSON.stringify(ok.json));
  assert.strictEqual(ok.json.alreadyRedacted, false);
  assert.strictEqual(ok.json.counts.hitCount, 2);

  // 最新版
  const latest = await call('GET', '/api/public/chronicle', { token: null });
  const hitLatest = latest.json.version.events.find((e) => e.eventId === ids.e1);
  assert.strictEqual(hitLatest.source, REDACTED_TEXT);
  assert.strictEqual(hitLatest.sourceRedacted, true);
  // 其余字段与版本号不变
  assert.strictEqual(latest.json.currentVersionNo, 2);
  assert.strictEqual(hitLatest.title, '动员会');
  assert.strictEqual(hitLatest.dateLabel, '1958 年 09 月 12 日');
  assert.strictEqual(hitLatest.resolvedDate, '1958-09-12');
  // 未登记遮盖的出处照常显示
  assert.strictEqual(latest.json.version.events.find((e) => e.eventId === ids.e2).source, SRC_B);

  // 历史版本 v1 同样遮盖
  const v1 = await call('GET', '/api/public/versions/1', { token: null });
  assert.strictEqual(v1.json.version.events.find((e) => e.eventId === ids.e1).source, REDACTED_TEXT);
  assert.strictEqual(v1.json.version.versionNo, 1);

  // 关系出处与事件出处相互独立
  assert.strictEqual(
    latest.json.version.relations.find((r) => r.relationId === ids.rid).source,
    SRC_REL
  );
});

test('确认不改写历史快照，也不影响草稿与草稿修订号', async () => {
  const ids = await seedTwoVersions();
  const before = await call('GET', '/api/editor/state');
  const pv = await call('POST', '/api/editor/redaction-preview', { body: { source: SRC_A } });
  await call('POST', '/api/editor/redaction', {
    body: { source: SRC_A, currentVersionNo: pv.json.currentVersionNo },
  });

  // 快照表物理内容仍是原文（读出层才遮盖）
  const raw = mem.prepare('SELECT source FROM version_events WHERE event_id = ? AND source = ?').all(ids.e1, SRC_A);
  assert.strictEqual(raw.length, 2);
  // 草稿原文不动、修订号不变
  const st = (await call('GET', '/api/editor/state')).json;
  assert.strictEqual(st.draftRevisionNo, before.json.draftRevisionNo);
  const draftClaim = st.events
    .find((e) => e.id === ids.e1).claims
    .find((c) => c.id === ids.c1);
  assert.strictEqual(draftClaim.source, SRC_A);
});

test('持编辑口令查看版本详情仍显示原文；从历史版本恢复草稿也使用原文', async () => {
  const ids = await seedTwoVersions();
  const pv = await call('POST', '/api/editor/redaction-preview', { body: { source: SRC_A } });
  await call('POST', '/api/editor/redaction', {
    body: { source: SRC_A, currentVersionNo: pv.json.currentVersionNo },
  });

  // 编辑者视角版本详情：原文
  const ed = await call('GET', '/api/editor/versions/1');
  assert.strictEqual(ed.status, 200);
  assert.strictEqual(ed.json.version.events.find((e) => e.eventId === ids.e1).source, SRC_A);
  assert.strictEqual(ed.json.version.relations.find((r) => r.relationId === ids.rid).source, SRC_REL);
  // 无口令访问编辑者详情 → 401
  assert.strictEqual((await call('GET', '/api/editor/versions/1', { token: null })).status, 401);

  // 从 v1 恢复草稿：恢复出的主张出处仍是原文
  const rpv = await call('GET', '/api/editor/restore-preview/2');
  const restored = await call('POST', '/api/editor/restore', {
    body: {
      versionNo: 2,
      draftRevisionNo: rpv.json.draftRevisionNo,
      currentVersionNo: rpv.json.currentVersionNo,
    },
  });
  assert.strictEqual(restored.status, 200, JSON.stringify(restored.json));
  const st = (await call('GET', '/api/editor/state')).json;
  assert.strictEqual(st.events.find((e) => e.title === '动员会').claims[0].source, SRC_A);
});

test('预览后有新版本发布 → 确认 409 冲突且不落库', async () => {
  await seedTwoVersions(); // latest = 2
  const pv = await call('POST', '/api/editor/redaction-preview', { body: { source: SRC_A } });
  assert.strictEqual(pv.json.currentVersionNo, 2);

  // 期间有人发布第 3 版（用现有草稿重选重发；内容相同也会生成新版本号）
  const st = await call('GET', '/api/editor/state');
  const sel = st.json.events.map((e) => ({ eventId: e.id, claimId: e.claims[0].id }));
  const pub3 = await publish(sel, 2);
  assert.strictEqual(pub3.versionNo, 3);

  const bad = await call('POST', '/api/editor/redaction', {
    body: { source: SRC_A, currentVersionNo: 2 },
  });
  assert.strictEqual(bad.status, 409);
  assert.strictEqual(bad.json.code, 'REDACTION_VERSION_CONFLICT');
  assert.strictEqual(bad.json.currentVersionNo, 3);

  // 不落库：访客仍见原文
  const view = await call('GET', '/api/public/versions/1', { token: null });
  assert.strictEqual(view.json.version.events.find((e) => e.title === '动员会').source, SRC_A);
  assert.strictEqual(mem.prepare('SELECT COUNT(*) AS n FROM redacted_sources').get().n, 0);

  // 重新预览（latest=3）后确认成功
  const pv2 = await call('POST', '/api/editor/redaction-preview', { body: { source: SRC_A } });
  assert.strictEqual(pv2.json.currentVersionNo, 3);
  const ok = await call('POST', '/api/editor/redaction', {
    body: { source: SRC_A, currentVersionNo: 3 },
  });
  assert.strictEqual(ok.status, 200);
  const view2 = await call('GET', '/api/public/versions/1', { token: null });
  assert.strictEqual(view2.json.version.events.find((e) => e.title === '动员会').source, REDACTED_TEXT);
});

test('重复确认幂等：返回 alreadyRedacted 且不重复落库', async () => {
  await seedTwoVersions();
  const pv = await call('POST', '/api/editor/redaction-preview', { body: { source: SRC_A } });
  const first = await call('POST', '/api/editor/redaction', {
    body: { source: SRC_A, currentVersionNo: 2 },
  });
  assert.strictEqual(first.status, 200);
  assert.strictEqual(first.json.alreadyRedacted, false);

  // 即便携带过期版本号，重复确认仍幂等成功
  const again = await call('POST', '/api/editor/redaction', {
    body: { source: SRC_A, currentVersionNo: pv.json.currentVersionNo },
  });
  assert.strictEqual(again.status, 200);
  assert.strictEqual(again.json.alreadyRedacted, true);
  assert.strictEqual(mem.prepare('SELECT COUNT(*) AS n FROM redacted_sources').get().n, 1);

  // 清单接口可见
  const list = await call('GET', '/api/editor/redactions');
  assert.strictEqual(list.json.redactions.length, 1);
  assert.strictEqual(list.json.redactions[0].source, SRC_A);

  // 再次预览会标注已遮盖
  const pvAgain = await call('POST', '/api/editor/redaction-preview', { body: { source: SRC_A } });
  assert.strictEqual(pvAgain.json.alreadyRedacted, true);
});

test('以后发布含同一文本的新版本自动遮盖，无需再次登记', async () => {
  const ids = await seedTwoVersions();
  // 先登记遮盖（只有 v1/v2）
  const pv = await call('POST', '/api/editor/redaction-preview', { body: { source: SRC_A } });
  await call('POST', '/api/editor/redaction', { body: { source: SRC_A, currentVersionNo: pv.json.currentVersionNo } });

  // 新事件使用同一出处，发布 v3
  const e4 = await makeEvent('动员会补记');
  const c4 = await makeClaim(e4, { precision: 'year', year: 1958, source: SRC_A });
  const st = await call('GET', '/api/editor/state');
  const selIds = st.json.events.map((e) => ({
    eventId: e.id,
    claimId: e.id === e4 ? c4 : e.claims[0].id,
  }));
  const v3 = await publish(selIds, 2);
  assert.strictEqual(v3.versionNo, 3);

  // v3 的该出处自动遮盖
  const view = await call('GET', '/api/public/versions/3', { token: null });
  assert.strictEqual(view.json.version.events.find((e) => e.eventId === e4).source, REDACTED_TEXT);
  assert.strictEqual(view.json.version.events.find((e) => e.eventId === ids.e1).source, REDACTED_TEXT);
  // 登记记录仍只有一条
  assert.strictEqual(mem.prepare('SELECT COUNT(*) AS n FROM redacted_sources').get().n, 1);
});

test('零命中也可登记：确认成功但命中数为 0（以后发布含该文本仍自动遮盖）', async () => {
  await seedTwoVersions();
  const future = '某档案全宗99，页码0000';
  const pv = await call('POST', '/api/editor/redaction-preview', { body: { source: future } });
  assert.strictEqual(pv.json.counts.hitCount, 0);
  const ok = await call('POST', '/api/editor/redaction', {
    body: { source: future, currentVersionNo: 2 },
  });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(ok.json.counts.hitCount, 0);
  assert.strictEqual(mem.prepare('SELECT COUNT(*) AS n FROM redacted_sources WHERE source = ?').get(future).n, 1);
});
