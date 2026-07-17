/**
 * Publish gate for the marketplace registry (serve-http-cp-registry.ts).
 *
 * The registry must not silently publish unevaluated packs: a publish with no
 * X-Eval-Score (or one below the CP_REGISTRY_MIN_EVAL floor, default 0.8) is
 * stored as status 'pending_eval' — visible in the vendor console, hidden from
 * the tenant catalog (which filters status = 'published').
 * CP_REGISTRY_ALLOW_UNSCORED=1 is the loudly-logged emergency bypass.
 *
 * Pure-function tests over the exported decidePublishStatus (the express
 * handler + the /:id/republish gate both delegate to it); env is passed
 * explicitly so process.env is never mutated.
 */

import { describe, test, expect } from 'bun:test';
import { decidePublishStatus } from '../src/commands/serve-http-cp-registry.ts';

describe('cp-registry publish gate — decidePublishStatus', () => {
  test('no eval score → pending_eval with an explanatory warning', () => {
    const d = decidePublishStatus(null, {});
    expect(d.status).toBe('pending_eval');
    expect(d.warning).toContain('pending_eval');
    expect(d.warning).toContain('no eval score');
  });

  test('score below the default 0.8 floor → pending_eval, score kept but not published', () => {
    const d = decidePublishStatus(0.5, {});
    expect(d.status).toBe('pending_eval');
    expect(d.warning).toContain('0.5');
    expect(d.warning).toContain('0.8');
  });

  test('score at/above the floor → published, no warning', () => {
    expect(decidePublishStatus(0.9, {})).toEqual({ status: 'published', warning: null });
    // boundary: exactly the floor passes
    expect(decidePublishStatus(0.8, {})).toEqual({ status: 'published', warning: null });
  });

  test('CP_REGISTRY_MIN_EVAL overrides the floor', () => {
    const env = { CP_REGISTRY_MIN_EVAL: '0.5' };
    expect(decidePublishStatus(0.6, env).status).toBe('published');
    expect(decidePublishStatus(0.4, env).status).toBe('pending_eval');
  });

  test('invalid CP_REGISTRY_MIN_EVAL falls back to the 0.8 default', () => {
    for (const bogus of ['banana', '-0.2', '1.5', '']) {
      const d = decidePublishStatus(0.79, { CP_REGISTRY_MIN_EVAL: bogus });
      expect(d.status).toBe('pending_eval');
    }
    expect(decidePublishStatus(0.81, { CP_REGISTRY_MIN_EVAL: 'banana' }).status).toBe('published');
  });

  test('CP_REGISTRY_ALLOW_UNSCORED=1 bypass publishes but carries a warning', () => {
    const env = { CP_REGISTRY_ALLOW_UNSCORED: '1' };
    const noScore = decidePublishStatus(null, env);
    expect(noScore.status).toBe('published');
    expect(noScore.warning).toContain('CP_REGISTRY_ALLOW_UNSCORED');
    const lowScore = decidePublishStatus(0.1, env);
    expect(lowScore.status).toBe('published');
    expect(lowScore.warning).toContain('CP_REGISTRY_ALLOW_UNSCORED');
  });

  test('bypass is a no-op when the score already passes the gate', () => {
    const d = decidePublishStatus(0.95, { CP_REGISTRY_ALLOW_UNSCORED: '1' });
    expect(d).toEqual({ status: 'published', warning: null });
  });

  test('only the exact value "1" arms the bypass', () => {
    expect(decidePublishStatus(null, { CP_REGISTRY_ALLOW_UNSCORED: 'true' }).status).toBe('pending_eval');
    expect(decidePublishStatus(null, { CP_REGISTRY_ALLOW_UNSCORED: '0' }).status).toBe('pending_eval');
  });
});
