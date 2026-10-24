import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

import { Agenda, MAX_ACTIVE, empty, normalize, normalizeAt, stamp } from '../src/agenda.js'

let root
let path

before(() => {
  root = mkdtempSync(join(tmpdir(), 'goal-agenda-'))
  path = join(root, 'state', 'agenda.json')
})

after(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('agenda state machine', () => {
  it('starts empty when the file does not exist', () => {
    const book = new Agenda(path)
    assert.deepEqual(book.data, empty())
    assert.deepEqual(book.activeGoals(), [])
  })

  it('creates a goal and marks the first step as doing', () => {
    const book = new Agenda(path)
    const goal = book.createGoal('写一篇观察记录', ['翻旧记录', '写第一段'])
    assert.equal(goal.status, 'active')
    assert.equal(goal.steps.length, 2)
    assert.equal(goal.steps[0].status, 'doing')
    assert.equal(goal.steps[1].status, 'pending')
    assert.match(goal.id, /^g_\d+$/)
  })

  it('persists atomically and reloads from disk', () => {
    const reread = new Agenda(path)
    assert.equal(reread.activeGoals().length, 1)
    assert.equal(reread.activeGoals()[0].objective, '写一篇观察记录')
    const text = readFileSync(path, 'utf8')
    assert.ok(text.endsWith('}\n'))
    assert.doesNotThrow(() => JSON.parse(text))
  })

  it('advances the next pending step when one completes', () => {
    const book = new Agenda(path)
    book.stepDone(1, '翻到三条旧记录')
    const steps = book.steps()
    assert.equal(steps[0].status, 'done')
    assert.equal(steps[0].evidence, '翻到三条旧记录')
    assert.match(steps[0].doneAt, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
    assert.equal(steps[1].status, 'doing')
  })

  it('records a blocked step with what is missing', () => {
    const book = new Agenda(path)
    book.stepBlock(2, ['素材'], '还没见到足够的例子')
    const step = book.steps()[1]
    assert.equal(step.status, 'blocked')
    assert.deepEqual(step.missing, ['素材'])
    assert.equal(step.note, '还没见到足够的例子')
  })

  it('appends a step and gives it the next id', () => {
    const book = new Agenda(path)
    const step = book.addStep('回看一遍', '2026-10-24 20:00')
    assert.equal(step.id, 3)
    assert.equal(step.status, 'pending')
    assert.equal(step.dueAt, '2026-10-24 20:00')
  })

  it('reaches the active-plan ceiling', () => {
    const book = new Agenda(path)
    for (let index = 1; index < MAX_ACTIVE; index += 1) book.createGoal(`并行目标 ${index}`, ['一步'])
    assert.throws(() => book.createGoal('再来一个', ['一步']), /同时最多 6 个 plan/)
  })

  it('requires plan_id when several plans are active', () => {
    const book = new Agenda(path)
    const [first, second] = book.activeGoals()
    // 不给 id 时落在第一个
    assert.equal(book.pickGoal(undefined).id, first.id)
    assert.equal(book.pickGoal(second.id).id, second.id)
    assert.throws(() => book.pickGoal('g_does_not_exist'), /找不到 plan/)
  })

  it('finishes and abandons goals', () => {
    const book = new Agenda(path)
    const [first, second] = book.activeGoals()
    book.finishGoal('写完了', first.id)
    book.abandon('不想写', second.id)
    const reloaded = new Agenda(path).goals()
    assert.equal(reloaded[0].status, 'done')
    assert.equal(reloaded[0].note, '写完了')
    assert.match(reloaded[0].finishedAt, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
    assert.equal(reloaded[1].status, 'abandoned')
  })

  it('rejects an empty objective and an empty new step', () => {
    const book = new Agenda(join(root, 'other.json'))
    assert.throws(() => book.createGoal('   ', ['一步']), /objective 不能为空/)
    book.createGoal('有目标', ['一步'])
    assert.throws(() => book.addStep('   '), /title 不能为空/)
  })

  it('normalizes unknown JSON into an empty document', () => {
    assert.deepEqual(normalize('not json'), empty())
    assert.deepEqual(normalize({ goals: 'nope', timers: 3 }), empty())
    assert.deepEqual(normalize({ goals: [{ id: 'g_1' }], lastInteraction: 5 }).goals.length, 1)
    assert.equal(normalize({ goals: [{ id: 'g_1' }], lastInteraction: 5 }).lastInteraction, '')
  })
})

describe('timestamps', () => {
  it('formats a local stamp', () => {
    assert.match(stamp(new Date(2026, 9, 23, 21, 58, 29)), /^2026-10-23 21:58:29$/)
  })

  it('normalizes full and time-only inputs', () => {
    assert.equal(normalizeAt('2026-10-24 20:00'), '2026-10-24 20:00:00')
    assert.match(normalizeAt('07:30'), /^\d{4}-\d{2}-\d{2} 07:30:00$/)
    assert.equal(normalizeAt('明天吧'), '明天吧')
  })

  it('rolls a time-only value to tomorrow when it already passed', () => {
    const normalized = normalizeAt('00:00')
    const when = new Date(normalized.replace(' ', 'T'))
    assert.ok(when.getTime() > Date.now())
  })
})
