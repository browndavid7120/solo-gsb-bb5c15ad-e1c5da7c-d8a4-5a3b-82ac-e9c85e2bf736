'use strict';

// 出处遮盖：编辑者可按出处原文撤回其公开展示。
//
// 登记内容仅为“被遮盖的精确出处文本”（redacted_sources 表），
// 不修改、不删除任何历史快照（version_events / version_relations 保持不可变），
// 也不触碰草稿区（该表上没有草稿修订号触发器，登记不推进 draft_meta.revision）。
//
// 访客侧（getVersionDetail 后经 maskVersionDetail 读出）把与登记文本
// 逐字符相等的 source（事件主张出处、「先于」关系出处）统一替换为
// REDACTED_TEXT「出处已遮盖」，其余字段与版本号不变。因此：
//   - 历史版本与最新版本在读出时同样被遮盖；
//   - 以后发布的新版本只要含同一文本，读出时自动遮盖，无需再次登记；
//   - 持编辑口令查看版本详情（/api/editor/versions/:no）仍显示快照原文；
//   - 从历史版本恢复草稿仍复制快照原文。
//
// 流程与「恢复草稿 / 导入整理包」一致，分两步：
//   预览（buildRedactionPreview）只读，给出该文本在全部已发布版本中的
//   命中位置与数量，以及预览时的最新版本号；
//   确认（confirmRedaction）须带回该最新版本号：预览后若有新版本发布，
//   返回 409 REDACTION_VERSION_CONFLICT 且不落库；对同一文本重复确认是幂等的，
//   返回已遮盖状态（alreadyRedacted: true）。空文本在路由层即被拒绝（400）。

const { getDb } = require('./db');
const { getVersionDetail, latestVersionNo } = require('./publish');

const REDACTED_TEXT = '出处已遮盖';
const MAX_SOURCE_LEN = 1000;

function loadRedactedSet() {
  const rows = getDb().prepare('SELECT source FROM redacted_sources').all();
  return new Set(rows.map((r) => r.source));
}

// 在读出层遮盖一个版本详情：仅替换命中的 source，其余字段（含版本号）不变。
// redactedSet 可由调用方预先加载（一次请求内多个版本共用），缺省时即时查询。
function maskVersionDetail(detail, redactedSet) {
  if (!detail) return detail;
  const set = redactedSet || loadRedactedSet();
  if (set.size === 0) return detail;
  return {
    ...detail,
    events: detail.events.map((e) =>
      set.has(e.source) ? { ...e, source: REDACTED_TEXT, sourceRedacted: true } : e
    ),
    relations: detail.relations.map((r) =>
      set.has(r.source) ? { ...r, source: REDACTED_TEXT, sourceRedacted: true } : r
    ),
  };
}

// 统计一个（未遮盖的）版本详情中与给定文本精确相等的命中位置。
function hitsInVersion(version, source) {
  const eventHits = version.events
    .filter((e) => e.source === source)
    .map((e) => ({ eventId: e.eventId, claimId: e.claimId, title: e.title }));
  const titleByEvent = new Map(version.events.map((e) => [e.eventId, e.title]));
  const relationHits = version.relations
    .filter((r) => r.source === source)
    .map((r) => ({
      relationId: r.relationId,
      earlierEventId: r.earlierEventId,
      laterEventId: r.laterEventId,
      earlierTitle: titleByEvent.get(r.earlierEventId) || null,
      laterTitle: titleByEvent.get(r.laterEventId) || null,
    }));
  return {
    versionNo: version.versionNo,
    eventClaimHits: eventHits,
    relationHits,
    hitCount: eventHits.length + relationHits.length,
  };
}

// 草稿区命中（仅供预览提示）：遮盖不改动草稿；但这些位置一旦发布即会自动遮盖。
function draftHitsFor(source) {
  const db = getDb();
  const claims = db
    .prepare(
      `SELECT c.id AS claimId, c.event_id AS eventId, e.title
         FROM claims c JOIN events e ON e.id = c.event_id
        WHERE c.source = ? ORDER BY c.id`
    )
    .all(source);
  const relations = db
    .prepare(
      `SELECT r.id AS relationId, r.earlier_id AS earlierId, r.later_id AS laterId,
              te.title AS earlierTitle, tl.title AS laterTitle
         FROM relations r
         JOIN events te ON te.id = r.earlier_id
         JOIN events tl ON tl.id = r.later_id
        WHERE r.source = ? ORDER BY r.id`
    )
    .all(source);
  return {
    claimCount: claims.length,
    relationCount: relations.length,
    claims,
    relations,
  };
}

// 只读预览：扫描全部已发布版本，不改任何数据。
function buildRedactionPreview(source) {
  const db = getDb();
  const latest = latestVersionNo();
  const already = db.prepare('SELECT created_at AS createdAt FROM redacted_sources WHERE source = ?').get(source);

  const versions = [];
  for (let no = 1; no <= latest; no += 1) {
    const detail = getVersionDetail(no); // 快照原文（编辑者视角的内部读取）
    const hits = hitsInVersion(detail, source);
    if (hits.hitCount > 0) versions.push(hits);
  }
  const eventClaimCount = versions.reduce((n, v) => n + v.eventClaimHits.length, 0);
  const relationCount = versions.reduce((n, v) => n + v.relationHits.length, 0);

  return {
    source,
    currentVersionNo: latest,
    alreadyRedacted: Boolean(already),
    redactedAt: already ? already.createdAt : null,
    counts: {
      hitCount: eventClaimCount + relationCount,
      eventClaimCount,
      relationCount,
      versionCount: versions.length,
    },
    versions,
    draftHits: draftHitsFor(source),
  };
}

// 确认遮盖。expectedLatestVersionNo 必须等于预览时的最新版本号。
// 抛 { status, ...body } 表示 HTTP 错误；成功返回当前全部命中状态。
function confirmRedaction({ source, expectedLatestVersionNo, editor = '' }) {
  const db = getDb();

  const tx = db.transaction(() => {
    // 幂等优先：同一文本重复确认直接返回已遮盖状态，不重复落库、不报错
    const existing = db
      .prepare('SELECT id, created_at AS createdAt FROM redacted_sources WHERE source = ?')
      .get(source);
    const latest = latestVersionNo();
    if (existing) {
      return { alreadyRedacted: true, latest, redactedAt: existing.createdAt };
    }
    // 预览后若有新版本发布 → 冲突且不落库（新版本可能也含该文本，需重新预览确认范围）
    if (Number(expectedLatestVersionNo) !== latest) {
      throw {
        status: 409,
        code: 'REDACTION_VERSION_CONFLICT',
        message: `版本冲突：你预览遮盖时最新是第 ${expectedLatestVersionNo} 版，现在已是第 ${latest} 版。请重新预览命中范围后再确认。`,
        currentVersionNo: latest,
        expectedVersionNo: Number(expectedLatestVersionNo),
      };
    }
    const info = db
      .prepare('INSERT INTO redacted_sources (source, editor) VALUES (?, ?)')
      .run(source, String(editor || ''));
    return { alreadyRedacted: false, latest, redactedId: info.lastInsertRowid };
  });

  const result = tx();
  // 命中范围以确认后的最新状态重算（含期间已发布版本上的自动遮盖）
  const preview = buildRedactionPreview(source);
  return {
    source,
    alreadyRedacted: result.alreadyRedacted,
    redactedAt: result.redactedAt,
    currentVersionNo: result.latest,
    counts: preview.counts,
    versions: preview.versions,
  };
}

// 已登记遮盖清单（编辑台展示用）
function listRedactions() {
  return getDb()
    .prepare(
      `SELECT id AS redactionId, source, editor, created_at AS redactedAt
         FROM redacted_sources ORDER BY id`
    )
    .all();
}

module.exports = {
  REDACTED_TEXT,
  MAX_SOURCE_LEN,
  loadRedactedSet,
  maskVersionDetail,
  buildRedactionPreview,
  confirmRedaction,
  listRedactions,
};
