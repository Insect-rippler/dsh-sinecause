import assert from 'node:assert/strict'
import { join, sep } from 'node:path'
import { describe, it } from 'node:test'

import { resolveStatePath, resolveWorkspaceRoot } from '../src/paths.js'

describe('workspace resolution', () => {
  it('takes an explicit absolute path as-is', () => {
    assert.equal(resolveWorkspaceRoot('C:\\work\\a'), 'C:\\work\\a')
    assert.equal(resolveWorkspaceRoot('/srv/a'), '/srv/a')
  })

  it('rejects a relative explicit path', () => {
    assert.throws(() => resolveWorkspaceRoot('relative/path'), /绝对路径/)
  })

  it('falls back to the environment before the package location', () => {
    assert.equal(
      resolveWorkspaceRoot(undefined, { env: 'C:\\from-env', packageParent: 'C:\\pkg\\parent' }),
      'C:\\from-env',
    )
    assert.throws(
      () => resolveWorkspaceRoot(undefined, { env: 'not-absolute', packageParent: 'C:\\pkg' }),
      /SINECAUSE_WORKSPACE/,
    )
  })

  it('uses the package parent when nothing else is configured', () => {
    const parent = join('C:', 'work', 'ws')
    assert.equal(resolveWorkspaceRoot(undefined, { env: '', packageParent: parent }), parent)
  })

  it('refuses to resolve into node_modules instead of writing state there', () => {
    const inside = ['C:', 'profiles', 'web', 'node_modules', 'dsh-sinecause'].join(sep)
    assert.throws(
      () => resolveWorkspaceRoot(undefined, { env: '', packageParent: inside }),
      /依赖目录/,
    )
  })
})

describe('state path resolution', () => {
  it('takes an explicit absolute path as-is', () => {
    assert.equal(resolveStatePath('C:\\a\\b.json', 'C:\\ws', 'agenda.json'), 'C:\\a\\b.json')
    assert.throws(() => resolveStatePath('rel.json', 'C:\\ws', 'agenda.json'), /绝对路径/)
  })

  it('defaults to <workspace>/state/<file>', () => {
    assert.equal(resolveStatePath(undefined, join('C:', 'ws'), 'memory.json'), join('C:', 'ws', 'state', 'memory.json'))
  })
})
