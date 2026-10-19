import { h } from 'preact'
import render from 'preact-render-to-string'
import { describe, expect, it } from 'vitest'
import { BackupConflictDialog } from './BackupConflictDialog'

describe('backup conflict decision', () => {
  it('offers explicit backup, roaster, and abort choices', () => {
    const html = render(h(BackupConflictDialog, { count: 4, names: ['Profile A', 'Bean B'], onDecision: () => {} }))
    expect(html).toContain('role="dialog"')
    expect(html).toContain('Use backup copies')
    expect(html).toContain('Keep roaster copies')
    expect(html).toContain('Cancel import')
  })
})
