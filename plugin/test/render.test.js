import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { ageText, renderAgendaBlock } from '../src/render.js'

/** 与 state/request-tail.md 里那条真实注入一致的目标。 */
const sampleGoal = {
  id: 'g_2763909800',
  objective: '长期：把对漾涟·孑的观察攒起来，慢慢填 knowledge/psychological.json',
  status: 'active',
  createdAt: '2026-10-23 21:58:29',
  note: '',
  steps: [
    { id: 1, title: '日常对话里记他的选择、反应、说法，别急着下结论', status: 'doing', evidence: '', dueAt: null },
    { id: 2, title: '攒到几条同类的，再往画像里写，一次写一小段', status: 'pending', evidence: '', dueAt: null },
    { id: 3, title: '写进去的都是实际见过的事，猜的留在猜的地方', status: 'pending', evidence: '', dueAt: null },
  ],
}

/** 参考快照里的时刻：2026-10-23 22:47:57。 */
const NOW = new Date(2026, 9, 23, 22, 47, 57).getTime()

describe('tail rendering', () => {
  it('reproduces the reference tail block byte for byte', () => {
    const text = renderAgendaBlock({ goals: [sampleGoal], timers: [], lastInteraction: '' }, { now: NOW })
    assert.equal(text, [
      '## 目标与计划',
      '符号：[ ] 待办　[>] 进行中　[x] 完成　[!] 卡住',
      '### 1. 长期：把对漾涟·孑的观察攒起来，慢慢填 knowledge/psychological.json（g_2763909800）'
        + '· 共 3 步（完成 0 · 可推进 3） · 建于 10-23 21:58（49 分钟前）',
      '  [>] 1. 日常对话里记他的选择、反应、说法，别急着下结论（当前）',
      '  [ ] 2. 攒到几条同类的，再往画像里写，一次写一小段',
      '  [ ] 3. 写进去的都是实际见过的事，猜的留在猜的地方',
    ].join('\n'))
  })

  it('keeps a single prompt when nothing is active', () => {
    const text = renderAgendaBlock({ goals: [], timers: [] }, { now: NOW })
    assert.equal(text, '## 目标与计划\n当前没有目标，需要寻找新的目标。')
  })

  it('drops finished and abandoned goals', () => {
    const done = { ...sampleGoal, id: 'g_done', status: 'done' }
    const abandoned = { ...sampleGoal, id: 'g_abandoned', status: 'abandoned' }
    const text = renderAgendaBlock({ goals: [done, sampleGoal, abandoned], timers: [] }, { now: NOW })
    assert.doesNotMatch(text, /g_done|g_abandoned/)
    assert.equal(text.match(/^### /gm)?.length, 1)
  })

  it('names the focus when several plans run at once', () => {
    const second = {
      ...sampleGoal,
      id: 'g_second',
      steps: [
        { id: 1, title: '第二步的当前步', status: 'doing', evidence: '', dueAt: null },
      ],
    }
    const text = renderAgendaBlock({ goals: [second, sampleGoal], timers: [] }, { now: NOW })
    assert.match(text, /当前焦点：#1（共 2 个 plan）/)
    assert.match(text, /\[>\] 1\. 第二步的当前步（当前）/)
    assert.match(text, /\[>\] 1\. 日常对话里记他的选择.*（先放着）/)
  })

  it('reports a fully blocked plan with its missing pieces', () => {
    const blocked = {
      ...sampleGoal,
      steps: [
        { id: 1, title: '等桥启动', status: 'blocked', evidence: '', dueAt: null, missing: ['NapCat 没起', '要扫码'], note: '不在我手上' },
        { id: 2, title: '发一条确认', status: 'blocked', evidence: '', dueAt: null, missing: [], note: '同上' },
      ],
    }
    const text = renderAgendaBlock({ goals: [blocked], timers: [] }, { now: NOW })
    assert.match(text, /没有能推进的步骤，卡住的是：/)
    assert.match(text, /\[!\] 1\. 等桥启动（缺：NapCat 没起、要扫码；原因：不在我手上）/)
    assert.match(text, /用 wait 订个时间/)
    assert.match(text, /plan finish\/abandon（plan_id=g_2763909800）/)
  })

  it('asks for finish when every step is done', () => {
    const finished = {
      ...sampleGoal,
      steps: sampleGoal.steps.map(step => ({ ...step, status: 'done' })),
    }
    const text = renderAgendaBlock({ goals: [finished], timers: [] }, { now: NOW })
    assert.match(text, /共 3 步（完成 3 · 可推进 0）/)
    assert.match(text, /步骤全部完成：用 plan finish 收尾/)
  })

  it('windows a long plan around the current step', () => {
    const steps = Array.from({ length: 9 }, (_, index) => ({
      id: index + 1,
      title: `第 ${index + 1} 步`,
      status: index < 4 ? 'done' : index === 4 ? 'doing' : 'pending',
      evidence: '',
      dueAt: null,
    }))
    const text = renderAgendaBlock({ goals: [{ ...sampleGoal, steps }], timers: [] }, { now: NOW })
    assert.match(text, /显示第 4–6 步（共 9 步）/)
    assert.doesNotMatch(text, /第 1 步/)
    assert.match(text, /\[>\] 5\. 第 5 步（当前）/)
  })

  it('shows evidence, due dates and timers', () => {
    const withDetail = {
      ...sampleGoal,
      steps: [
        { id: 1, title: '翻记录', status: 'done', evidence: '翻到三条', dueAt: '2026-10-24 20:00' },
        { id: 2, title: '写一段', status: 'doing', evidence: '', dueAt: null },
      ],
    }
    const text = renderAgendaBlock({
      goals: [withDetail],
      timers: [{ id: 't_1', at: '2026-10-25 09:00:00', reason: '再看看' }],
    }, { now: NOW })
    assert.match(text, /\[x\] 1\. 翻记录（证据：翻到三条）（截止 2026-10-24 20:00）/)
    assert.match(text, /定时器：2026-10-25 09:00:00 再看看/)
  })

  it('keeps timers visible even with no active goal', () => {
    const text = renderAgendaBlock({
      goals: [],
      timers: [{ id: 't_1', at: '2026-10-25 09:00:00', reason: '再看看' }],
    }, { now: NOW })
    assert.match(text, /定时器：2026-10-25 09:00:00 再看看/)
  })

  it('ignores malformed goal entries instead of throwing', () => {
    const text = renderAgendaBlock({ goals: [null, 'x', sampleGoal], timers: 'nope' }, { now: NOW })
    assert.equal(text.match(/^### /gm)?.length, 1)
  })
})

describe('age text', () => {
  it('scales the unit with the gap', () => {
    assert.equal(ageText('2026-10-23 22:40:00', NOW), '10-23 22:40（7 分钟前）')
    assert.equal(ageText('2026-10-23 20:00:00', NOW), '10-23 20:00（2 小时前）')
    assert.equal(ageText('2026-10-20 22:00:00', NOW), '10-20 22:00（3 天前）')
  })

  it('returns nothing for an unusable stamp', () => {
    assert.equal(ageText('', NOW), '')
    assert.equal(ageText('昨天', NOW), '')
  })
})
