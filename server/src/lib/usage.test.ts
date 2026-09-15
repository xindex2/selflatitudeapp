import { describe, it, expect } from 'vitest';
import { currentPeriod } from './usage.js';

describe('currentPeriod', () => {
  it('runs from the activation anniversary to the day before the next one', () => {
    const p = currentPeriod('2026-01-15', new Date('2026-03-20T12:00:00Z'));
    expect(p).toEqual({ start: '2026-03-15', end: '2026-04-15' });
  });
  it('uses the previous month when today is before the anniversary day', () => {
    const p = currentPeriod('2026-01-15', new Date('2026-03-10T12:00:00Z'));
    expect(p).toEqual({ start: '2026-02-15', end: '2026-03-15' });
  });
  it('clamps the 31st to shorter months', () => {
    const p = currentPeriod('2026-01-31', new Date('2026-02-10T12:00:00Z'));
    expect(p).toEqual({ start: '2026-01-31', end: '2026-02-28' });
    const p2 = currentPeriod('2026-01-31', new Date('2026-03-05T12:00:00Z'));
    expect(p2).toEqual({ start: '2026-02-28', end: '2026-03-31' });
  });
  it('falls back to calendar months without an anchor', () => {
    const p = currentPeriod(null, new Date('2026-09-08T00:00:00Z'));
    expect(p).toEqual({ start: '2026-09-01', end: '2026-10-01' });
  });
});
