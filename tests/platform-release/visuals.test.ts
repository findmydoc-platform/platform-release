import { describe, expect, it } from 'vitest'
import { boundedVisualCandidates, extractReleaseVisuals } from '../../src/platform-release/visuals.js'

describe('platform release visuals', () => {
  it('prefers explicitly release-eligible visuals and stays bounded', () => {
    const markdown = `
<!-- gh-ui-screenshots:start -->
<!-- gh-ui-screenshots:metadata {"releaseRole":"primary","releaseEligible":true,"formFactor":"desktop"} -->
![Review overview](https://github.com/user-attachments/assets/reviews.png)
<!-- gh-ui-screenshots:end -->

## Screenshots
![Fallback](https://github.com/user-attachments/assets/fallback.png)
`
    const visuals = extractReleaseVisuals(markdown, {
      pullRequestNumber: 42,
      repository: 'findmydoc-platform/website',
    })
    expect(visuals).toHaveLength(2)
    expect(boundedVisualCandidates(visuals)).toEqual([
      expect.objectContaining({
        label: 'Review overview',
        releaseEligible: true,
        releaseRole: 'primary',
      }),
    ])
  })
})
