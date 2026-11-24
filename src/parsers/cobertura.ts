import type { FileBuilder } from '../model';
import { FileCollector } from './collect';
import { NotCoverageReportError, type ParseContext, type ParsedReport } from './types';
import { scanXml } from './xml';

/** Reads `(covered/total)` from a condition-coverage value such as `50% (1/2)`. */
function parseConditions(value: string): [number, number] | undefined {
  const open = value.indexOf('(');
  const slash = value.indexOf('/', open + 1);
  const close = value.indexOf(')', slash + 1);
  if (open < 0 || slash < 0 || close < 0) return undefined;
  const covered = parseInt(value.slice(open + 1, slash), 10);
  const total = parseInt(value.slice(slash + 1, close), 10);
  if (!(total > 0) || !(covered >= 0)) return undefined;
  return [Math.min(covered, total), total];
}

function lineNumber(value: string | undefined): number {
  const n = value === undefined ? NaN : parseInt(value, 10);
  return n >= 1 ? n : 0;
}

/**
 * Parses a Cobertura XML report (coverlet, coverage.py, Istanbul, Microsoft.CodeCoverage dialects).
 * Only class-level `<lines>` produce statements and branches; method-level lines only place and count
 * the method's declaration (at its first line, with that line's hits).
 */
export function parseCobertura(xml: string, ctx: ParseContext): ParsedReport {
  const sources: string[] = [];
  const packages = new Set<string>();
  const collector = new FileCollector(ctx);
  const stack: string[] = [];

  let sourceText: string | undefined;
  let builder: FileBuilder | undefined;
  let methodName: string | undefined;
  let methodLine = 0;
  let methodHits = 0;

  scanXml(xml, {
    open(name, attrs) {
      const parent = stack.length > 0 ? stack[stack.length - 1] : undefined;
      if (parent === undefined && name !== 'coverage') {
        throw new NotCoverageReportError(`Not a Cobertura report: the root element is <${name}>`);
      }
      stack.push(name);
      switch (name) {
        case 'line': {
          if (builder === undefined || parent !== 'lines') return;
          const owner = stack[stack.length - 3];
          const line = lineNumber(attrs.number);
          if (line === 0) return;
          const hits = Number(attrs.hits);
          if (owner === 'class') {
            builder.addLine(line, hits);
            if (attrs.branch !== undefined && attrs.branch.toLowerCase() === 'true') {
              const cond = attrs['condition-coverage'];
              const arms = cond === undefined ? undefined : parseConditions(cond);
              if (arms !== undefined) {
                for (let arm = 0; arm < arms[1]; arm++) builder.addBranch(line, 0, arm, arm < arms[0] ? 1 : 0);
              }
            }
          } else if (owner === 'method' && methodName !== undefined && (methodLine === 0 || line < methodLine)) {
            methodLine = line;
            methodHits = hits;
          }
          return;
        }
        case 'class': {
          const raw = attrs.filename;
          builder = raw === undefined || raw === '' ? undefined : collector.builderFor(raw, sources);
          return;
        }
        case 'method':
          methodName = attrs.name ?? '';
          methodLine = 0;
          methodHits = 0;
          return;
        case 'package':
          if (attrs.name !== undefined) packages.add(attrs.name);
          return;
        case 'source':
          sourceText = '';
          return;
      }
    },
    text(t) {
      if (sourceText !== undefined) sourceText += t;
    },
    close(name) {
      stack.pop();
      switch (name) {
        case 'method':
          if (builder !== undefined && methodName !== undefined && methodLine > 0) {
            builder.addDeclaration(methodName, methodLine, 0, 0, 0, methodHits);
          }
          methodName = undefined;
          return;
        case 'class':
          builder = undefined;
          return;
        case 'source': {
          const source = (sourceText ?? '').trim();
          if (source !== '') sources.push(source);
          sourceText = undefined;
          return;
        }
      }
    },
  });

  return collector.finish([...packages].sort().join('|'));
}
