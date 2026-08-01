import { describe, it, expect } from 'vitest'
import { extractLinearRef } from '../linear/ref.js'

describe('extractLinearRef', () => {
  describe('Linear URLs (no team_keys needed)', () => {
    it('finds an issue URL in the PR body', () => {
      const ref = extractLinearRef(
        { body: 'Closes https://linear.app/inductive-network/issue/IN-2269/some-slug' },
        [],
      )
      expect(ref).toEqual({ id: 'IN-2269', key: 'IN', number: 2269, source: 'body' })
    })

    it('finds an issue URL in the PR title', () => {
      const ref = extractLinearRef(
        { title: 'fix: see linear.app/acme/issue/ENG-7/thing' },
        [],
      )
      expect(ref?.id).toBe('ENG-7')
      expect(ref?.source).toBe('title')
    })

    it('accepts a URL with no trailing slug', () => {
      const ref = extractLinearRef({ body: 'https://linear.app/acme/issue/AB-12' }, [])
      expect(ref?.id).toBe('AB-12')
    })
  })

  describe('bare identifiers require configured team_keys', () => {
    it('ignores bare identifiers when team_keys is empty', () => {
      expect(extractLinearRef({ branch: 'feat/in-2269-thing', title: 'IN-2269 fix' }, [])).toBeNull()
    })

    it('matches a configured key in a branch name, case-insensitively', () => {
      const ref = extractLinearRef({ branch: 'feat/in-2269-tiered-identity' }, ['IN'])
      expect(ref).toEqual({ id: 'IN-2269', key: 'IN', number: 2269, source: 'branch' })
    })

    it('matches an uppercase key in a title', () => {
      const ref = extractLinearRef({ title: 'IN-543: unified resolver' }, ['IN'])
      expect(ref?.id).toBe('IN-543')
      expect(ref?.source).toBe('title')
    })

    it('does not match a key that is not configured', () => {
      expect(extractLinearRef({ branch: 'feat/eng-1-thing' }, ['IN'])).toBeNull()
    })
  })

  describe('false-positive resistance', () => {
    // The reason bare-identifier matching is gated behind team_keys: these all
    // look exactly like Linear identifiers to a naive regex.
    const traps = ['UTF-8', 'SHA-256', 'ISO-8601', 'GPT-5', 'RFC-2119']

    for (const trap of traps) {
      it(`does not treat ${trap} as an issue ref`, () => {
        expect(extractLinearRef({ title: `chore: switch to ${trap}` }, [])).toBeNull()
      })
    }

    it('still ignores traps when unrelated team_keys are configured', () => {
      expect(extractLinearRef({ title: 'chore: SHA-256 hashing' }, ['IN'])).toBeNull()
    })

    it('requires a word boundary so SUBIN-1 does not match key IN', () => {
      expect(extractLinearRef({ title: 'SUBIN-1 nope' }, ['IN'])).toBeNull()
    })
  })

  describe('precedence', () => {
    it('prefers branch over title and body', () => {
      const ref = extractLinearRef(
        { branch: 'feat/in-1-a', title: 'IN-2 b', body: 'IN-3 c' },
        ['IN'],
      )
      expect(ref?.id).toBe('IN-1')
      expect(ref?.source).toBe('branch')
    })

    it('prefers title over body', () => {
      const ref = extractLinearRef({ title: 'IN-2 b', body: 'IN-3 c' }, ['IN'])
      expect(ref?.id).toBe('IN-2')
    })

    it('prefers an unambiguous URL over a bare key in the same field', () => {
      const ref = extractLinearRef(
        { body: 'IN-99 mentioned, real one: https://linear.app/x/issue/IN-2269/z' },
        ['IN'],
      )
      expect(ref?.id).toBe('IN-2269')
    })
  })

  it('returns null when nothing matches', () => {
    expect(extractLinearRef({ branch: 'main', title: 'chore: bump', body: '' }, ['IN'])).toBeNull()
  })

  it('handles absent fields', () => {
    expect(extractLinearRef({}, ['IN'])).toBeNull()
  })
})

describe('hostname anchoring', () => {
  // Regression: an unanchored `linear.app/` fragment let any domain ending in
  // "linear.app" bypass the team_keys gate and target an arbitrary issue.
  const impostors = [
    'https://notlinear.app/acme/issue/IN-2269',
    'https://evil-linear.app/acme/issue/IN-2269',
    'https://mylinear.app/x/issue/IN-1/slug',
  ]

  for (const url of impostors) {
    it(`does not trust ${url.replace('https://', '').split('/')[0]}`, () => {
      expect(extractLinearRef({ body: url }, [])).toBeNull()
    })
  }

  it('still trusts the real host', () => {
    expect(extractLinearRef({ body: 'https://linear.app/acme/issue/IN-2269' }, [])?.id).toBe('IN-2269')
  })

  it('trusts it bare, without a scheme', () => {
    expect(extractLinearRef({ body: 'see linear.app/acme/issue/IN-7' }, [])?.id).toBe('IN-7')
  })

  it('trusts it at the very start of a field', () => {
    expect(extractLinearRef({ body: 'linear.app/acme/issue/IN-8' }, [])?.id).toBe('IN-8')
  })

  it('falls through to team_keys when an impostor URL is present', () => {
    // The impostor must not shadow a legitimate bare ref elsewhere in the text.
    const ref = extractLinearRef({ body: 'https://notlinear.app/x/issue/IN-999 but really IN-42' }, ['IN'])
    expect(ref?.id).toBe('IN-999')
  })
})

describe('hostname is parsed, not pattern-matched', () => {
  // A path segment named linear.app is not the linear.app host. A boundary check
  // on the surrounding character passes here; only real parsing rejects it.
  const impostors = [
    'https://evil.example/linear.app/acme/issue/IN-2269',
    'https://evil.example/?u=https://linear.app/acme/issue/IN-2269',
    'https://linear.app.evil.example/acme/issue/IN-2269',
    'https://user@evil.example/linear.app/acme/issue/IN-1',
  ]

  for (const url of impostors) {
    it(`rejects ${url.slice(8, 40)}...`, () => {
      expect(extractLinearRef({ body: url }, [])).toBeNull()
    })
  }

  it('accepts the real host over https', () => {
    expect(extractLinearRef({ body: 'https://linear.app/acme/issue/IN-2269/slug' }, [])?.id).toBe('IN-2269')
  })

  it('accepts the real host case-insensitively', () => {
    expect(extractLinearRef({ body: 'https://LINEAR.APP/acme/issue/IN-3' }, [])?.id).toBe('IN-3')
  })

  it('ignores a malformed URL without throwing', () => {
    expect(extractLinearRef({ body: 'https://[not-a-url/issue/IN-9' }, [])).toBeNull()
  })

  it('finds a real URL after an impostor one', () => {
    const body = 'https://evil.example/linear.app/x/issue/IN-1 and https://linear.app/acme/issue/IN-42'
    expect(extractLinearRef({ body }, [])?.id).toBe('IN-42')
  })
})
