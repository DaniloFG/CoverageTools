import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { RunSuppressions, SUPPRESSION_TAIL_MS } from '../../../src/runner/suppression';

const timers = { set: (fn: () => void, ms: number) => setTimeout(fn, ms), clear: (h: unknown) => clearTimeout(h as NodeJS.Timeout) };

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

test('a project is suppressed while it runs and for 2,000 ms after release', () => {
  const s = new RunSuppressions(timers);
  expect(SUPPRESSION_TAIL_MS).toBe(2_000);
  expect(s.isSuppressed('project:/a')).toBe(false);
  const run = s.suppress('project:/a');
  expect(s.isSuppressed('project:/a')).toBe(true);
  expect(s.isSuppressed('project:/b')).toBe(false);
  vi.advanceTimersByTime(60_000);
  expect(s.isSuppressed('project:/a')).toBe(true);
  run.release();
  expect(s.isSuppressed('project:/a')).toBe(true);
  vi.advanceTimersByTime(1_999);
  expect(s.isSuppressed('project:/a')).toBe(true);
  vi.advanceTimersByTime(1);
  expect(s.isSuppressed('project:/a')).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});

test('no timer exists while nothing was released, and none once the tail is over', () => {
  const s = new RunSuppressions(timers);
  const run = s.suppress('project:/a');
  expect(vi.getTimerCount()).toBe(0);
  run.release();
  expect(vi.getTimerCount()).toBe(1);
  vi.advanceTimersByTime(2_000);
  expect(vi.getTimerCount()).toBe(0);
});

test('a new run during the tail cancels it; the project stays suppressed until its own release + 2,000 ms', () => {
  const s = new RunSuppressions(timers);
  s.suppress('project:/a').release();
  vi.advanceTimersByTime(1_500);
  const again = s.suppress('project:/a');
  expect(vi.getTimerCount()).toBe(0);
  vi.advanceTimersByTime(5_000);
  expect(s.isSuppressed('project:/a')).toBe(true);
  again.release();
  vi.advanceTimersByTime(1_999);
  expect(s.isSuppressed('project:/a')).toBe(true);
  vi.advanceTimersByTime(1);
  expect(s.isSuppressed('project:/a')).toBe(false);
});

test('overlapping suppressions of one project end with the last release', () => {
  const s = new RunSuppressions(timers);
  const first = s.suppress('project:/a');
  const second = s.suppress('project:/a');
  first.release();
  vi.advanceTimersByTime(10_000);
  expect(s.isSuppressed('project:/a')).toBe(true);
  second.release();
  vi.advanceTimersByTime(2_000);
  expect(s.isSuppressed('project:/a')).toBe(false);
});

test('releasing twice counts once', () => {
  const s = new RunSuppressions(timers);
  const first = s.suppress('project:/a');
  const second = s.suppress('project:/a');
  first.release();
  first.release();
  vi.advanceTimersByTime(2_000);
  expect(s.isSuppressed('project:/a')).toBe(true);
  second.release();
  vi.advanceTimersByTime(2_000);
  expect(s.isSuppressed('project:/a')).toBe(false);
});

test('dispose clears the pending tails', () => {
  const s = new RunSuppressions(timers);
  s.suppress('project:/a').release();
  s.suppress('project:/b').release();
  expect(vi.getTimerCount()).toBe(2);
  s.dispose();
  expect(vi.getTimerCount()).toBe(0);
  expect(s.isSuppressed('project:/a')).toBe(false);
});
