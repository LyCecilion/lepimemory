import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { openStore } from '../lib/store.js';
import { HindsightClient, attribute, renderRecall } from '../lib/hindsight.js';
import { createRecaller } from '../lib/recall.js';
import { createRecallSources } from '../lib/recall-source.js';
import { rawVersion, loadSource } from '../lib/raw-source.js';
import { TRUST, trustOf, scoreOf, candidateExclusion } from '../lib/trust.js';

async function fixture(t, specs = [{}]) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lep-recall-test-'));
  const store = openStore({ dbFile: path.join(home, 'runtime.sqlite') });
  const now = Date.parse('2026-10-05T12:00:00Z');
  const records = specs.map((spec) => {
    const candidate = {
      candidate_id: randomUUID(),
      text: '合成角色偏好安静的交流。',
      content_kind: 'preference',
      origin: 'user',
      sensitivity: 'ordinary',
      subject_key: '青柠',
      facet_key: '交流环境',
      source_ids: [randomUUID()],
      formed_at: '2026-10-05T10:00:00Z',
      valid_from: null,
      valid_until: null,
      occurred_start: null,
      occurred_end: null,
      occurrence: 'reported',
      explicit: true,
      request_id: null,
      ...spec.candidate,
    };
    const json = JSON.stringify(candidate);
    const payloadHash = createHash('sha256').update(json).digest('hex');
    store.db
      .prepare('INSERT INTO snapshots VALUES (?,?,?,?)')
      .run(candidate.candidate_id, json, payloadHash, now);
    store.db
      .prepare(
        `INSERT INTO lifecycle(candidate_id,status,purpose,grant_id,policy_epoch,updated_at)
            VALUES (?,?,'current',?,?,?)`,
      )
      .run(
        candidate.candidate_id,
        spec.status ?? 'active',
        spec.grant_id ?? null,
        store.policyEpoch,
        now,
      );
    const document = {
      id: `lepi-${candidate.candidate_id}`,
      bank_id: 'demo',
      original_text: candidate.text,
      document_metadata: { candidate_id: candidate.candidate_id, payload_hash: payloadHash },
    };
    const raw = {
      id: randomUUID(),
      text: candidate.text,
      fact_type: 'world',
      type: 'world',
      date: candidate.formed_at,
      mentioned_at: candidate.formed_at,
      occurred_start: null,
      occurred_end: null,
      document_id: document.id,
      metadata: document.document_metadata,
      state: 'valid',
    };
    store.db
      .prepare('INSERT INTO raw_links VALUES (?,?,?,?,?,?)')
      .run(raw.id, candidate.candidate_id, document.id, rawVersion(raw), 'valid', now);
    return { candidate, document, raw };
  });
  const observation = {
    id: randomUUID(),
    type: 'observation',
    state: 'valid',
    text: '综合材料包含全部来源。',
    source_memory_ids: records.map((record) => record.raw.id),
    source_fact_ids: records.map((record) => record.raw.id),
    scores: { semantic: 0.8 },
  };
  let response = { results: [observation], source_facts: {}, source_facts_truncated: true };
  const requests = [];
  let before;
  const server = createServer(async (req, res) => {
    req.resume();
    requests.push(req.url);
    if (before) await before(req.url);
    const id = decodeURIComponent(req.url.split('/').at(-1));
    let body;
    if (id === 'recall') body = response;
    else if (req.url.includes('/documents/'))
      body = records.find((record) => record.document.id === id)?.document;
    else
      body =
        id === observation.id ? observation : records.find((record) => record.raw.id === id)?.raw;
    res.writeHead(body ? 200 : 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body ?? {}));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const hindsight = new HindsightClient({
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    bank: 'demo',
  });
  const processed = [];
  let verify = async (input) => ({
    safe: true,
    used_source_ids: input.sources.map((source) => source.id),
  });
  const processor = {
    async verifyObservation(input) {
      processed.push(input);
      return verify(input);
    },
  };
  const recaller = createRecaller({ store, hindsight, processor, now: () => now });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    store.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  return {
    store,
    now,
    records,
    observation,
    requests,
    processed,
    hindsight,
    recaller,
    setResponse(value) {
      response = value;
    },
    setVerify(value) {
      verify = value;
    },
    setBefore(value) {
      before = value;
    },
  };
}

test('observation never lends fact authority to an unknown source or unconfirmed inference', () => {
  const result = {
    type: 'observation',
    metadata: { trust: 'fact' },
    mentioned_at: '2026-10-05T12:00:00Z',
    scores: { semantic: 0.8 },
  };
  assert.equal(trustOf(result), TRUST.UNKNOWN);
  assert.equal(trustOf(result, { origin: 'user' }), TRUST.UNKNOWN);
  const score = scoreOf(result, {
    candidate: { origin: 'inference', formed_at: '2026-09-21T12:00:00Z' },
    nowMs: Date.parse('2026-10-05T12:00:00Z'),
  });
  assert.equal(score.trust, TRUST.INFERENCE);
  assert.equal(score.effective, 0.4);
});

test('a mixed observation containing forgotten material never reaches the verifier; allowed snapshot keeps parent relevance', async (t) => {
  const f = await fixture(t, [
    {},
    { status: 'forgotten', candidate: { text: '不可再用于模型的合成秘密。' } },
  ]);
  const result = await f.recaller.recall({ query: '交流偏好', purpose: 'current' });
  assert.equal(f.processed.length, 0);
  assert.deepEqual(
    result.picked.map((item) => item.text),
    [f.records[0].candidate.text],
  );
  assert.equal(result.picked[0].score_source, 'parent_observation');
  assert.equal(result.picked[0].rank, 0.8);
  assert.equal(result.text.includes(f.records[1].candidate.text), false);
  assert.equal(
    f.requests.some((route) => route.endsWith(f.records[1].raw.id)),
    false,
  );
  const audits = f.store.history({ kind: 'recall', limit: 100 }).items;
  assert.equal(JSON.stringify(audits).includes(f.observation.text), false);
  assert.equal(JSON.stringify(audits).includes(f.records[1].candidate.text), false);
  assert.deepEqual(
    audits[0].data.chains[0].sources.map((source) => source.candidate_id),
    f.records.map((record) => record.candidate.candidate_id),
  );
});

test('external raw changes during observation verification cannot escape through a local snapshot fallback', async (t) => {
  const f = await fixture(t);
  f.setVerify(async (input) => {
    f.records[0].raw.text = '远端已被外部修改。';
    return { safe: true, used_source_ids: input.sources.map((source) => source.id) };
  });
  const result = await f.recaller.recall({ query: '交流偏好' });
  assert.deepEqual(result.picked, []);
  assert.ok(result.excluded.some((item) => item.code === 'LEPI_SOURCE_CHANGED'));
  assert.equal(result.text, '');
});

test('a known changed observation body is not revalidated as if it were the current composite', async (t) => {
  const f = await fixture(t);
  f.setResponse({
    results: [{ ...f.observation, text: '旧综合正文。' }],
    source_facts_truncated: false,
  });
  const result = await f.recaller.recall({ query: '交流偏好' });
  assert.equal(f.processed.length, 0);
  assert.deepEqual(
    result.picked.map((item) => item.text),
    [f.records[0].candidate.text],
  );
  assert.equal(result.text.includes('旧综合正文'), false);
});

test('expired planned memories become historical, never completed; undated-cutoff states remain dated statements', async (t) => {
  const f = await fixture(t, [
    {
      candidate: {
        text: '计划昨天去公园。',
        content_kind: 'plan',
        occurrence: 'planned',
        valid_until: '2026-10-04T23:59:59Z',
      },
    },
    { candidate: { text: '表达时有些疲倦。', content_kind: 'temporary_state' } },
  ]);
  f.setResponse({
    results: f.records.map((record) => ({
      id: record.raw.id,
      type: 'world',
      scores: { semantic: 0.8 },
    })),
  });
  const current = await f.recaller.recall({ query: '状态与安排', purpose: 'current' });
  assert.deepEqual(
    current.picked.map((item) => item.text),
    [f.records[1].candidate.text],
  );
  assert.match(current.text, /不代表现在仍成立/);
  assert.equal(
    loadSource(f.store, f.records[0].candidate.candidate_id).lifecycle.status,
    'history_only',
  );
  const history = await f.recaller.recall({ query: '过去安排', purpose: 'history' });
  assert.match(history.text, /历史/);
  assert.match(history.text, /计划/);
  assert.equal(
    history.picked.find((item) => item.text === f.records[0].candidate.text).candidates[0]
      .occurrence,
    'planned',
  );
});

test('inference in a verified composite keeps its own formation age and unconfirmed label', async (t) => {
  const f = await fixture(t, [
    { candidate: { formed_at: '2020-01-01T00:00:00Z' } },
    {
      candidate: {
        text: '我猜角色喜欢安静。',
        origin: 'inference',
        formed_at: '2026-09-21T12:00:00Z',
      },
    },
  ]);
  const result = await f.recaller.recall({ query: '交流偏好' });
  assert.equal(result.picked[0].trust, 'inference');
  assert.equal(result.picked[0].rank, 0.4);
  assert.match(result.text, /未确认的推断/);
  assert.match(result.text, /用户陈述/);
});

test('an original kept private grant remains readable after revocation, but another candidate cannot borrow it', async (t) => {
  const grantId = randomUUID();
  const f = await fixture(t, [{ grant_id: grantId, candidate: { sensitivity: 'private' } }]);
  const c = f.records[0].candidate;
  f.store.db
    .prepare('INSERT INTO grants VALUES (?,?,?,?,?,?,?)')
    .run(
      grantId,
      JSON.stringify({ kind: 'item', candidate_id: c.candidate_id }),
      JSON.stringify(c.source_ids),
      null,
      1,
      2,
      0,
    );
  assert.equal(
    candidateExclusion(loadSource(f.store, c.candidate_id), f.store, 'current', f.now),
    null,
  );
  f.store.db
    .prepare('UPDATE grants SET scope_json=? WHERE id=?')
    .run(JSON.stringify({ kind: 'item', candidate_id: randomUUID() }), grantId);
  assert.equal(
    candidateExclusion(loadSource(f.store, c.candidate_id), f.store, 'current', f.now),
    'LEPI_GRANT_INVALID',
  );
});

test('source fallback scans stop at four pages across refresh and do not call an incomplete scan missing', async (t) => {
  const f = await fixture(t);
  let pages = 0;
  const hindsight = {
    bank: 'demo',
    raw: async () => null,
    document: async () => f.records[0].document,
    unitsPage: async () => {
      pages++;
      return { total: 1000, items: Array.from({ length: 100 }, () => ({ id: randomUUID() })) };
    },
  };
  const resolver = createRecallSources({
    store: f.store,
    hindsight,
    checkSource: (source, purpose) => candidateExclusion(source, f.store, purpose, f.now),
  });
  const first = await resolver.resolve(f.records[0].raw.id, {
    purpose: 'current',
    epoch: f.store.policyEpoch,
  });
  assert.equal(first.code, 'LEPI_SOURCE_UNKNOWN');
  assert.equal(pages, 4);
  resolver.refresh();
  assert.equal(
    (
      await resolver.resolve(f.records[0].raw.id, {
        purpose: 'current',
        epoch: f.store.policyEpoch,
      })
    ).code,
    'LEPI_SOURCE_UNKNOWN',
  );
  assert.equal(pages, 4);
});

test('forget between document and raw awaits stops the subsequent raw body query', async (t) => {
  const f = await fixture(t);
  f.setResponse({
    results: [{ id: f.records[0].raw.id, type: 'world', scores: { semantic: 0.8 } }],
  });
  f.setBefore(async (route) => {
    if (route.includes('/documents/'))
      f.store.db
        .prepare("UPDATE lifecycle SET status='forgotten' WHERE candidate_id=?")
        .run(f.records[0].candidate.candidate_id);
  });
  const result = await f.recaller.recall({ query: '交流偏好' });
  assert.deepEqual(result.picked, []);
  assert.equal(
    f.requests.some((route) => route.endsWith(f.records[0].raw.id)),
    false,
  );
});

test('partial observation fallback ranks each snapshot independently within the explicit item budget', async (t) => {
  const f = await fixture(t, [
    { candidate: { origin: 'inference', formed_at: '2026-09-21T12:00:00Z' } },
    { candidate: { text: '已陈述的偏好甲。' } },
    { candidate: { text: '已陈述的偏好乙。' } },
    { status: 'forgotten', candidate: { text: '已忘记的内容。' } },
  ]);
  const sources = f.records.map((record) => ({
    ...loadSource(f.store, record.candidate.candidate_id),
    raw: record.raw,
    document: record.document,
    bank: 'demo',
  }));
  const result = attribute([f.observation], {
    store: f.store,
    purpose: 'current',
    nowMs: f.now,
    maxItems: 2,
    sourceMap: new Map([
      [f.observation.id, { sources, text: f.observation.text, score_source: 'observation' }],
    ]),
  });
  assert.deepEqual(
    result.picked.map((item) => item.text),
    [f.records[1].candidate.text, f.records[2].candidate.text],
  );
  assert.deepEqual(
    result.picked.map((item) => item.raw_ids),
    [[f.records[1].raw.id], [f.records[2].raw.id]],
  );
  assert.ok(
    result.excluded.some((item) => item.id === f.records[0].raw.id && item.code === 'over_limit'),
  );
  assert.equal(renderRecall(result.picked).includes(f.observation.text), false);
});

test('native null semantic retains ranked approved facts without lending relevance to inference or forgotten sources', async (t) => {
  const f = await fixture(t, [
    { candidate: { text: '用户偏好安静。' } },
    { candidate: { text: '用户不喜欢突然来访。' } },
    { candidate: { text: '未确认的日常推断。', origin: 'inference' } },
    { status: 'forgotten', candidate: { text: '不能复活的旧偏好。' } },
  ]);
  f.setResponse({
    results: [
      { id: f.records[0].raw.id, type: 'world', scores: { semantic: null, final: 0.0001 } },
      { ...f.observation, scores: { semantic: null, final: 0.0007, reranker: 0.0006 } },
    ],
    source_facts: {},
    source_facts_truncated: true,
  });
  const result = await f.recaller.recall({ query: '我有哪些偏好？' });
  assert.deepEqual(
    result.picked.map((item) => item.text),
    f.records.slice(0, 2).map((record) => record.candidate.text),
  );
  assert.deepEqual(
    result.picked.map((item) => item.semantic),
    [null, null],
  );
  assert.deepEqual(
    result.picked.map((item) => item.rank),
    [0.0007, 0.0007],
  );
  assert.equal(f.processed.length, 0);
  assert.ok(
    result.excluded.some(
      (item) => item.id === f.records[2].raw.id && item.code === 'score_unavailable',
    ),
  );
  assert.ok(
    result.excluded.some(
      (item) => item.id === f.records[3].raw.id && item.code === 'LEPI_MEMORY_SUPPRESSED',
    ),
  );
  assert.equal(result.text.includes(f.observation.text), false);
});
