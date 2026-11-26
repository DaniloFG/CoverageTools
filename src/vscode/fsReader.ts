import nodePath from 'node:path';
import * as vscode from 'vscode';
import type { FsReader } from '../adapters/types';
import { globToRegExp, oneGlob } from '../glob';
import { statKind } from './fileEvents';

export interface VSCodeFsReader extends FsReader {
  /** A file's modification time, or undefined when it cannot be read; lets discovery cache `.cs` answers. */
  statMtime(path: string): Promise<number | undefined>;
  /** What the path is, from one stat; undefined when it is gone or cannot be read. */
  kindOf(path: string): Promise<'file' | 'directory' | undefined>;
}

const decoder = new TextDecoder('utf-8');

/**
 * The adapters' and discovery's file access over VS Code: searches through `workspace.findFiles`
 * (VS Code's own file search, with the excludes applied), reads through `workspace.fs`. Every
 * failure reads as "absent".
 */
export function vscodeFsReader(): VSCodeFsReader {
  return {
    async readText(p) {
      try {
        return decoder.decode(await vscode.workspace.fs.readFile(vscode.Uri.file(p)));
      } catch {
        return undefined;
      }
    },

    async exists(p) {
      try {
        await vscode.workspace.fs.stat(vscode.Uri.file(p));
        return true;
      } catch {
        return false;
      }
    },

    async find(dir, include, exclude) {
      const includeGlob = oneGlob(include);
      if (includeGlob === undefined) return [];
      const excludeGlob = oneGlob(exclude);
      let uris: vscode.Uri[];
      try {
        // An explicit exclude also turns off `files.exclude`, so results do not depend on the user's view settings.
        uris = await vscode.workspace.findFiles(new vscode.RelativePattern(vscode.Uri.file(dir), includeGlob), excludeGlob ?? null);
      } catch {
        return [];
      }
      const excluded = exclude.map(globToRegExp);
      const out: string[] = [];
      for (const uri of uris) {
        if (uri.scheme !== 'file') continue;
        const p = uri.fsPath;
        const rel = nodePath.relative(dir, p);
        // Excludes are relative to `dir`, as for every FsReader; VS Code may match them from the workspace folder.
        if (rel === '' || rel === '..' || rel.startsWith(`..${nodePath.sep}`) || nodePath.isAbsolute(rel)) continue;
        const posix = rel.split(nodePath.sep).join('/');
        if (excluded.some(re => re.test(posix))) continue;
        out.push(p);
      }
      return out.sort();
    },

    kindOf(p) {
      return statKind(vscode.Uri.file(p));
    },

    async statMtime(p) {
      try {
        return (await vscode.workspace.fs.stat(vscode.Uri.file(p))).mtime;
      } catch {
        return undefined;
      }
    },
  };
}
