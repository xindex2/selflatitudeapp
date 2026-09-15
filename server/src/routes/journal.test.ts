import { describe, it, expect } from 'vitest';
import { sanitizeHtml, htmlToText } from './journal.js';

describe('journal sanitizer', () => {
  it('strips scripts and attributes but keeps basic formatting', () => {
    const dirty = `<p onclick="x()">Hello <b>bold</b> <script>alert(1)</script><img src=x onerror=alert(1)><a href="http://evil">link</a></p>`;
    expect(sanitizeHtml(dirty)).toBe('<p>Hello <b>bold</b> link</p>');
  });
  it('converts html to readable text', () => {
    expect(htmlToText('<p>One</p><p>Two &amp; three</p><ul><li>a</li><li>b</li></ul>')).toBe('One\nTwo & three\na\nb');
  });
});
