import { expect, test } from 'vitest';
import { ReportParseError } from '../../../src/parsers/types';
import { scanXml } from '../../../src/parsers/xml';

function events(xml: string): unknown[] {
  const out: unknown[] = [];
  scanXml(xml, {
    open: (name, attrs) => out.push(['open', name, { ...attrs }]),
    text: t => out.push(['text', t]),
    close: name => out.push(['close', name]),
  });
  return out;
}

test('reports elements, attributes, text and entities; skips prolog, DOCTYPE, comments and CDATA markers', () => {
  expect(events('<?xml version="1.0"?><!DOCTYPE coverage SYSTEM "x"><a b="1 &amp; 2"><!-- c --><d>t&lt;</d></a>')).toEqual([
    ['open', 'a', { b: '1 & 2' }],
    ['open', 'd', {}],
    ['text', 't<'],
    ['close', 'd'],
    ['close', 'a'],
  ]);
  expect(events('<a><![CDATA[x<&y]]></a>')).toEqual([['open', 'a', {}], ['text', 'x<&y'], ['close', 'a']]);
});

test('handles a BOM, single quotes, self-closing tags, numeric references and whitespace', () => {
  const xml = '﻿<?xml version="1.0"?>\n<a  x = \'1\' y="&quot;&apos;&gt;&#65;&#x42;&#10;">\n  <b/>\n  <c z="2" />\n</a >\n';
  expect(events(xml)).toEqual([
    ['open', 'a', { x: '1', y: '"\'>AB\n' }],
    ['open', 'b', {}],
    ['close', 'b'],
    ['open', 'c', { z: '2' }],
    ['close', 'c'],
    ['close', 'a'],
  ]);
});

test('a DOCTYPE with an internal subset is skipped', () => {
  expect(events('<!DOCTYPE a [ <!ENTITY e "v>"> ]><a/>')).toEqual([['open', 'a', {}], ['close', 'a']]);
});

test('throws ReportParseError on truncated input', () => {
  for (const xml of ['<a><b', '<a><b>', '<a x="1', '<a><!-- c', '', '<?xml version="1.0"?>', '<a></b>']) {
    expect(() => events(xml), xml).toThrow(ReportParseError);
  }
});
