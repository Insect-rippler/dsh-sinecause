import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { inWorkspace } from '../src/workspace-gate.js'

/** 这个文件守的是一个真实事故：配置用正斜杠、cwd 用反斜杠，字面量比较永远不相等。 */
describe('workspace gate', () => {
  it('matches a forward-slash config against a backslash cwd', () => {
    assert.equal(inWorkspace('C:\\Users\\a\\b', 'C:/Users/a/b'), true)
    assert.equal(inWorkspace('C:\\Users\\a\\b\\plugin', 'C:/Users/a/b'), true)
  })

  it('matches when the cwd uses forward slashes and the config does not', () => {
    assert.equal(inWorkspace('C:/Users/a/b', 'C:\\Users\\a\\b'), true)
  })

  it('rejects a sibling that merely shares the prefix', () => {
    assert.equal(inWorkspace('C:\\Users\\a\\bc', 'C:/Users/a/b'), false)
    assert.equal(inWorkspace('C:\\Users\\a\\b2\\x', 'C:\\Users\\a\\b'), false)
  })

  it('ignores case, trailing separators and redundant segments', () => {
    assert.equal(inWorkspace('c:\\users\\A\\b', 'C:/Users/a/b/'), true)
    assert.equal(inWorkspace('C:\\Users\\a\\.\\b', 'C:/Users/a/b'), true)
  })

  it('treats a missing cwd as outside and an absent root as unfiltered', () => {
    assert.equal(inWorkspace(undefined, 'C:/Users/a/b'), false)
    assert.equal(inWorkspace('', 'C:/Users/a/b'), false)
    assert.equal(inWorkspace('C:/anything', undefined), true)
  })
})
